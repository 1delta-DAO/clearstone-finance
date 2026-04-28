import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Connection,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CSSOL_VAULT,
  CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  CSSOL_VRT_MINT,
  JITO_VAULT_PROGRAM,
  MINT_TO_DISCRIMINATOR,
} from "./addresses";

export interface VaultState {
  base: PublicKey;
  vrtMint: PublicKey;
  supportedMint: PublicKey;
  vrtSupply: bigint;
  tokensDeposited: bigint;
  feeWallet: PublicKey;
}

/**
 * Read minimal vault state from raw bytes. Layout is documented in the
 * SDK's Vault type; offsets verified against the live devnet vault.
 */
export async function readVaultState(conn: Connection, vault: PublicKey): Promise<VaultState> {
  const info = await conn.getAccountInfo(vault, "confirmed");
  if (!info) throw new Error(`vault ${vault.toBase58()} not found`);
  const d = info.data;
  // 0..8 disc | 8..40 base | 40..72 vrtMint | 72..104 supportedMint
  // 104..112 vrtSupply | 112..120 tokensDeposited | ...
  // 496..528 feeWallet (after delegationState + admin slots)
  return {
    base: new PublicKey(d.subarray(8, 40)),
    vrtMint: new PublicKey(d.subarray(40, 72)),
    supportedMint: new PublicKey(d.subarray(72, 104)),
    vrtSupply: d.readBigUInt64LE(104),
    tokensDeposited: d.readBigUInt64LE(112),
    feeWallet: new PublicKey(d.subarray(496, 528)),
  };
}

/**
 * Build the MintTo ix. Account ordering per @jito-foundation/vault-sdk:
 *   config, vault, vrtMint, depositor (signer, writable),
 *   depositorTokenAccount (W), vaultTokenAccount (W),
 *   depositorVrtTokenAccount (W), vaultFeeTokenAccount (W),
 *   tokenProgram, mintSigner (signer)
 */
function buildMintToIx(
  configPda: PublicKey,
  vault: PublicKey,
  vrtMint: PublicKey,
  depositor: PublicKey,
  depositorTokenAccount: PublicKey,
  vaultTokenAccount: PublicKey,
  depositorVrtTokenAccount: PublicKey,
  vaultFeeTokenAccount: PublicKey,
  mintSigner: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 8 + 8);
  data.writeUInt8(MINT_TO_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(amountIn, 1);
  data.writeBigUInt64LE(minAmountOut, 9);
  return new TransactionInstruction({
    programId: JITO_VAULT_PROGRAM,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: vrtMint, isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
      { pubkey: depositorVrtTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vaultFeeTokenAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: mintSigner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * Compose the full SOL → VRT deposit transaction. Returns an unsigned
 * Transaction the wallet adapter then signs.
 *
 * Steps:
 *   1. Idempotently create user's wSOL ATA + VRT ATA + fee VRT ATA.
 *   2. Transfer `amountLamports` native SOL into the wSOL ATA, sync_native.
 *   3. MintTo on the Jito Vault: pulls wSOL from user → mints VRT to user.
 *
 * Requires the connected wallet to be the vault's `mintBurnAdmin` (since
 * our vault is gated). Raises a clear UI error otherwise.
 */
export async function buildDepositTx(
  conn: Connection,
  user: PublicKey,
  amountLamports: bigint,
): Promise<Transaction> {
  const state = await readVaultState(conn, CSSOL_VAULT);
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    JITO_VAULT_PROGRAM,
  );

  const userWsol = getAssociatedTokenAddressSync(state.supportedMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userVrt = getAssociatedTokenAddressSync(state.vrtMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const feeVrt = getAssociatedTokenAddressSync(state.vrtMint, state.feeWallet, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user, userWsol, user, state.supportedMint,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user, userVrt, user, state.vrtMint,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(createAssociatedTokenAccountIdempotentInstruction(
      user, feeVrt, state.feeWallet, state.vrtMint,
      TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ))
    .add(SystemProgram.transfer({ fromPubkey: user, toPubkey: userWsol, lamports: Number(amountLamports) }))
    .add(createSyncNativeInstruction(userWsol))
    .add(buildMintToIx(
      configPda,
      CSSOL_VAULT,
      state.vrtMint,
      user,                              // depositor
      userWsol,                          // depositorTokenAccount
      CSSOL_VAULT_ST_TOKEN_ACCOUNT,      // vaultTokenAccount (vault's wSOL ATA)
      userVrt,                           // depositorVrtTokenAccount
      feeVrt,                            // vaultFeeTokenAccount
      user,                              // mintSigner — gated; only mintBurnAdmin works
      amountLamports,
      0n,
    ));
  return tx;
}

export async function getVrtBalance(conn: Connection, user: PublicKey, vrtMint: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(vrtMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}
