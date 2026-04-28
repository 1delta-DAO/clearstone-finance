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
  DEFAULT_MINT_BURN_ADMIN,
  JITO_VAULT_PROGRAM,
  MINT_TO_DISCRIMINATOR,
  ROLE_MINT_BURN_ADMIN,
  SET_SECONDARY_ADMIN_DISCRIMINATOR,
} from "./addresses";

export interface VaultState {
  base: PublicKey;
  vrtMint: PublicKey;
  supportedMint: PublicKey;
  vrtSupply: bigint;
  tokensDeposited: bigint;
  admin: PublicKey;
  feeWallet: PublicKey;
  mintBurnAdmin: PublicKey;
}

/**
 * Three roles a connected wallet might hold against this vault. The dev
 * playground enables the Deposit button differently per role.
 *
 *   admin                — vault top-level admin. Can rotate any
 *                          secondary admin. Playground will atomically
 *                          rotate mintBurnAdmin → user → restore.
 *   mintBurnAdmin        — already authorized to sign MintTo. Just mints.
 *   none                 — neither. Deposit blocked; UI disables button.
 */
export type WalletRole = "admin" | "mintBurnAdmin" | "none";

export function classifyWallet(state: VaultState, wallet: PublicKey | null): WalletRole {
  if (!wallet) return "none";
  if (state.mintBurnAdmin.equals(wallet)) return "mintBurnAdmin";
  if (state.admin.equals(wallet)) return "admin";
  return "none";
}

/**
 * Read minimal vault state from raw bytes. Offsets verified against the
 * live devnet vault by binary-searching for known pubkey locations:
 *   8..40   base
 *   40..72  vrtMint
 *   72..104 supportedMint
 *   104..112 vrtSupply (u64 LE)
 *   112..120 tokensDeposited (u64 LE)
 *   120..128 depositCapacity
 *   ...
 *   admin slots start at offset 440, in this order (32 bytes each):
 *     admin, delegationAdmin, operatorAdmin, ncnAdmin, slasherAdmin,
 *     capacityAdmin, feeAdmin, delegateAssetAdmin, feeWallet,
 *     mintBurnAdmin, metadataAdmin.
 *   So feeWallet = 440 + 32*8 = 696.
 *      mintBurnAdmin = 440 + 32*9 = 728.
 */
const ADMIN_BLOCK_START = 440;
const ADMIN_OFFSET = ADMIN_BLOCK_START + 32 * 0;          // 440
const FEE_WALLET_OFFSET = ADMIN_BLOCK_START + 32 * 8;     // 696
const MINT_BURN_ADMIN_OFFSET = ADMIN_BLOCK_START + 32 * 9; // 728

export async function readVaultState(conn: Connection, vault: PublicKey): Promise<VaultState> {
  const info = await conn.getAccountInfo(vault, "confirmed");
  if (!info) throw new Error(`vault ${vault.toBase58()} not found`);
  const d = info.data;
  return {
    base: new PublicKey(d.subarray(8, 40)),
    vrtMint: new PublicKey(d.subarray(40, 72)),
    supportedMint: new PublicKey(d.subarray(72, 104)),
    vrtSupply: d.readBigUInt64LE(104),
    tokensDeposited: d.readBigUInt64LE(112),
    admin: new PublicKey(d.subarray(ADMIN_OFFSET, ADMIN_OFFSET + 32)),
    feeWallet: new PublicKey(d.subarray(FEE_WALLET_OFFSET, FEE_WALLET_OFFSET + 32)),
    mintBurnAdmin: new PublicKey(d.subarray(MINT_BURN_ADMIN_OFFSET, MINT_BURN_ADMIN_OFFSET + 32)),
  };
}

/**
 * Build a SetSecondaryAdmin ix. Used by the playground to atomically
 * rotate mintBurnAdmin in/out for an admin-driven deposit.
 *
 * Account ordering per the SDK:
 *   config (R), vault (W), admin (signer, R), newAdmin (R)
 */
function buildSetSecondaryAdminIx(
  configPda: PublicKey,
  vault: PublicKey,
  admin: PublicKey,
  newAdmin: PublicKey,
  role: number,
): TransactionInstruction {
  const data = Buffer.alloc(2);
  data.writeUInt8(SET_SECONDARY_ADMIN_DISCRIMINATOR, 0);
  data.writeUInt8(role, 1);
  return new TransactionInstruction({
    programId: JITO_VAULT_PROGRAM,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: newAdmin, isSigner: false, isWritable: false },
    ],
    data,
  });
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
 * Compose the full SOL → VRT deposit transaction. The exact ix list
 * depends on the connected wallet's role on the vault:
 *
 *   role = "mintBurnAdmin"  ATAs + transfer + sync_native + MintTo
 *   role = "admin"          ATAs + transfer + sync_native +
 *                           SetSecondaryAdmin(MintBurnAdmin = user)  ←
 *                           MintTo                                   ← all atomic
 *                           SetSecondaryAdmin(MintBurnAdmin = restoreTo)
 *   role = "none"           throws — caller should disable the button.
 *
 * Returns an unsigned Transaction the wallet adapter then signs.
 */
export async function buildDepositTx(
  conn: Connection,
  user: PublicKey,
  amountLamports: bigint,
  options: { restoreMintBurnAdminTo?: PublicKey } = {},
): Promise<{ tx: Transaction; mode: WalletRole }> {
  const state = await readVaultState(conn, CSSOL_VAULT);
  const role = classifyWallet(state, user);
  if (role === "none") {
    throw new Error(
      `connected wallet ${user.toBase58().slice(0, 8)}… holds neither admin nor ` +
      `mintBurnAdmin role on this vault. Deposit cannot proceed.`,
    );
  }

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    JITO_VAULT_PROGRAM,
  );

  const userWsol = getAssociatedTokenAddressSync(state.supportedMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userVrt = getAssociatedTokenAddressSync(state.vrtMint, user, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const feeVrt = getAssociatedTokenAddressSync(state.vrtMint, state.feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
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
    .add(createSyncNativeInstruction(userWsol));

  // Admin path: atomically rotate the gate to the user, mint, restore.
  // The whole sequence runs as one atomic tx — gate is restored on commit
  // and never visible as "open" off-chain.
  if (role === "admin") {
    tx.add(buildSetSecondaryAdminIx(configPda, CSSOL_VAULT, user, user, ROLE_MINT_BURN_ADMIN));
  }

  tx.add(buildMintToIx(
    configPda,
    CSSOL_VAULT,
    state.vrtMint,
    user,
    userWsol,
    CSSOL_VAULT_ST_TOKEN_ACCOUNT,
    userVrt,
    feeVrt,
    user,
    amountLamports,
    0n,
  ));

  if (role === "admin") {
    const restoreTo = options.restoreMintBurnAdminTo ?? DEFAULT_MINT_BURN_ADMIN;
    tx.add(buildSetSecondaryAdminIx(configPda, CSSOL_VAULT, user, restoreTo, ROLE_MINT_BURN_ADMIN));
  }

  return { tx, mode: role };
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
