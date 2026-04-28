import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

import {
  CSSOL_MINT,
  CSSOL_RESERVE,
  ELEVATION_GROUP_LST_SOL,
  KLEND_MARKET,
  KLEND_PROGRAM,
  WSOL_RESERVE,
} from "./addresses";

// Anchor-style discriminators for the klend ixs we use. Computed
// off-thread (see comment block below) and pinned here so the tab can
// run synchronously.
//   sha256("global:init_user_metadata")[0..8]   = 75a9b8413294f604
//   sha256("global:init_obligation")[0..8]      = fb20c0bbcf0c14fb
//   sha256("global:request_elevation_group")[0..8] = 4d2bb70d8ddff5d6
//   sha256("global:refresh_reserve")[0..8]      = 02da8aeb4fc91966
//   sha256("global:refresh_obligation")[0..8]   = 218493e497c04859
//   sha256("global:deposit_reserve_liquidity_and_obligation_collateral")[0..8]
//                                              = 81c70402de271a2e
async function sha256_8(input: string): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(h).slice(0, 8);
}

// ── Helpers ────────────────────────────────────────────────────────────

const DEFAULT = PublicKey.default;
const enc = new TextEncoder();

function lendingMarketAuthority(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("lma"), market.toBuffer()], KLEND_PROGRAM)[0];
}
function reserveLiqSupply(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("reserve_liq_supply"), reserve.toBuffer()], KLEND_PROGRAM)[0];
}
function reserveCollMint(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("reserve_coll_mint"), reserve.toBuffer()], KLEND_PROGRAM)[0];
}
function reserveCollSupply(reserve: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("reserve_coll_supply"), reserve.toBuffer()], KLEND_PROGRAM)[0];
}

export function userMetadataPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("user_meta"), owner.toBuffer()], KLEND_PROGRAM)[0];
}

/**
 * Obligation PDA — for default obligations the seeds are:
 *   [tag(=0), id(=0), owner, market, default_pubkey, default_pubkey]
 */
export function obligationPda(owner: PublicKey, tag = 0, id = 0): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Uint8Array.from([tag]),
      Uint8Array.from([id]),
      owner.toBuffer(),
      KLEND_MARKET.toBuffer(),
      DEFAULT.toBuffer(),
      DEFAULT.toBuffer(),
    ],
    KLEND_PROGRAM,
  )[0];
}

// ── ix builders ────────────────────────────────────────────────────────

export async function buildInitUserMetadataIx(owner: PublicKey, feePayer: PublicKey): Promise<TransactionInstruction> {
  const userMeta = userMetadataPda(owner);
  // Args: userLookupTable (Pubkey, default = no LUT)
  const data = new Uint8Array(8 + 32);
  data.set(await sha256_8("global:init_user_metadata"), 0);
  data.set(DEFAULT.toBuffer(), 8);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: feePayer, isSigner: true, isWritable: true },
      { pubkey: userMeta, isSigner: false, isWritable: true },
      { pubkey: DEFAULT, isSigner: false, isWritable: false },        // referrerUserMetadata = default = no referrer
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function buildInitObligationIx(owner: PublicKey, feePayer: PublicKey, tag = 0, id = 0): Promise<TransactionInstruction> {
  const obligation = obligationPda(owner, tag, id);
  const userMeta = userMetadataPda(owner);
  // Args: InitObligationArgs { tag: u8, id: u8 }
  const data = new Uint8Array(8 + 1 + 1);
  data.set(await sha256_8("global:init_obligation"), 0);
  data[8] = tag; data[9] = id;
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: feePayer, isSigner: true, isWritable: true },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: DEFAULT, isSigner: false, isWritable: false },        // seed1Account
      { pubkey: DEFAULT, isSigner: false, isWritable: false },        // seed2Account
      { pubkey: userMeta, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function buildRequestElevationGroupIx(owner: PublicKey, group = ELEVATION_GROUP_LST_SOL): Promise<TransactionInstruction> {
  const obligation = obligationPda(owner);
  const data = new Uint8Array(8 + 1);
  data.set(await sha256_8("global:request_elevation_group"), 0);
  data[8] = group;
  // remaining_accounts: each deposit reserve. Empty obligation has no
  // deposits, so no remaining accounts on first request.
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export async function buildRefreshReserveIx(reserve: PublicKey, oracle: PublicKey): Promise<TransactionInstruction> {
  const data = await sha256_8("global:refresh_reserve");
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: oracle, isSigner: false, isWritable: false },          // pythOracle
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },   // switchboardPriceOracle = default → using program id as None sentinel per klend convention
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },   // switchboardTwapOracle
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },   // scopePrices
    ],
    data: Buffer.from(data),
  });
}

export async function buildRefreshObligationIx(owner: PublicKey, depositReserves: PublicKey[]): Promise<TransactionInstruction> {
  const data = await sha256_8("global:refresh_obligation");
  const obligation = obligationPda(owner);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: obligation, isSigner: false, isWritable: true },
      ...depositReserves.map((r) => ({ pubkey: r, isSigner: false, isWritable: false })),
    ],
    data: Buffer.from(data),
  });
}

/** csSOL deposit + obligation collateral — Token-2022 liquidity path. */
export async function buildDepositCsSolIx(owner: PublicKey, amount: bigint): Promise<TransactionInstruction> {
  const obligation = obligationPda(owner);
  const lma = lendingMarketAuthority(KLEND_MARKET);
  const liquiditySupply = reserveLiqSupply(CSSOL_RESERVE);
  const collMint = reserveCollMint(CSSOL_RESERVE);
  const collDest = reserveCollSupply(CSSOL_RESERVE);
  const userSource = getAssociatedTokenAddressSync(
    CSSOL_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const data = new Uint8Array(8 + 8);
  data.set(await sha256_8("global:deposit_reserve_liquidity_and_obligation_collateral"), 0);
  new DataView(data.buffer).setBigUint64(8, amount, true);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: KLEND_MARKET, isSigner: false, isWritable: false },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: CSSOL_RESERVE, isSigner: false, isWritable: true },
      { pubkey: CSSOL_MINT, isSigner: false, isWritable: true },          // reserveLiquidityMint (Token-2022 → mut for transfer fee accounting)
      { pubkey: liquiditySupply, isSigner: false, isWritable: true },
      { pubkey: collMint, isSigner: false, isWritable: true },
      { pubkey: collDest, isSigner: false, isWritable: true },
      { pubkey: userSource, isSigner: false, isWritable: true },
      { pubkey: KLEND_PROGRAM, isSigner: false, isWritable: false },      // placeholderUserDestinationCollateral = None
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },   // collateralTokenProgram (cTokens are SPL Token)
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // liquidityTokenProgram (csSOL is Token-2022)
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export const KLEND_RESERVES = { csSOL: CSSOL_RESERVE, wSOL: WSOL_RESERVE };
