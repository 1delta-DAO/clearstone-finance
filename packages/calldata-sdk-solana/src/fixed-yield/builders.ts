/**
 * Low-level instruction builders for `clearstone_router` wrapper_* ixs.
 *
 * Each `build*` returns a single `TransactionInstruction`. Callers are
 * expected to provide a fully-resolved account set — these builders do
 * no PDA derivation or ATA lookup beyond what the router strictly needs
 * to know. For the high-level "just give me a ready-to-sign tx" flow,
 * see `zap.ts`.
 *
 * Why no IDL-generated client? The router IDL is ~100kB and adds a hard
 * runtime dependency on `@coral-xyz/anchor`. Going straight through the
 * discriminator table keeps this SDK framework-free and forward-compatible
 * with either Anchor 0.30 or 0.31 clients.
 */

import {
  PublicKey,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  CLEARSTONE_ROUTER_PROGRAM_ID,
  CLEARSTONE_CORE_PROGRAM_ID,
  GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../common/constants.js";
import { ROUTER_DISC } from "./constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Ro = { pubkey: PublicKey; writable?: false; signer?: false };
type Rw = { pubkey: PublicKey; writable: true; signer?: false };

const ro = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: false,
});
const rw = (pubkey: PublicKey): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable: true,
});
const signer = (pubkey: PublicKey, writable = true): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable: writable,
});

function u64le(n: BN | bigint | number): Buffer {
  const v = typeof n === "bigint" ? new BN(n.toString()) : new BN(n);
  return v.toArrayLike(Buffer, "le", 8);
}

function i64le(n: BN | bigint | number): Buffer {
  const v = typeof n === "bigint" ? new BN(n.toString()) : new BN(n);
  return v.toTwos(64).toArrayLike(Buffer, "le", 8);
}

// ---------------------------------------------------------------------------
// Shared account bundles
// ---------------------------------------------------------------------------

/**
 * Accounts that every wrapper needs regardless of direction. The router
 * dedupes these across the inner core/adapter CPIs so callers never list
 * the same pubkey twice.
 */
export interface WrapperCommon {
  /** User signing the tx. Pays for any init-on-demand ATAs upstream. */
  user: PublicKey;

  // Adapter side
  /** SY market PDA on the adapter (generic_exchange_rate_sy / kamino_sy_adapter). */
  syMarket: PublicKey;
  /** Underlying base mint (e.g. cUSDY / kUSDC). */
  baseMint: PublicKey;
  /** SY mint (authority = sy_market PDA). */
  syMint: PublicKey;
  /** Adapter-owned base vault holding wrapped base tokens. */
  baseVault: PublicKey;

  // Core side
  /** Vault's authority PDA — also the yield-position holder. */
  authority: PublicKey;
  /** Vault account. */
  vault: PublicKey;
  /** Vault's yield_position account (PDA of authority + vault). */
  yieldPosition: PublicKey;
  /** Vault's bound address-lookup-table. */
  addressLookupTable: PublicKey;
  /** core_program event-authority PDA. */
  coreEventAuthority: PublicKey;

  // Program ids — allow caller to override (devnet deployments may differ).
  coreProgram?: PublicKey;
  syProgram?: PublicKey;
  routerProgram?: PublicKey;
  tokenProgram?: PublicKey;
}

// ---------------------------------------------------------------------------
// wrapper_strip / wrapper_merge
// ---------------------------------------------------------------------------

export interface WrapperStripParams extends WrapperCommon {
  /** User's base-asset ATA (source). */
  baseSrc: PublicKey;
  /** User's SY ATA (pass-through, also the adapter writes the minted SY here). */
  sySrc: PublicKey;
  /** Vault's own SY escrow (destination of core.strip). */
  escrowSy: PublicKey;
  /** User's YT destination ATA. */
  ytDst: PublicKey;
  /** User's PT destination ATA. */
  ptDst: PublicKey;
  /** PT mint (vault PDA). */
  mintPt: PublicKey;
  /** YT mint (vault PDA). */
  mintYt: PublicKey;
  /** Amount of base being stripped. */
  amountBase: BN | bigint | number;
  /**
   * Any additional accounts the adapter or core require beyond the ones
   * in WrapperCommon. Forwarded via `remaining_accounts`.
   */
  remainingAccounts?: AccountMeta[];
}

/** Base → PT + YT in one instruction (adapter.mint_sy → core.strip). */
export function buildWrapperStrip(p: WrapperStripParams): TransactionInstruction {
  const keys: AccountMeta[] = [
    signer(p.user),

    // adapter (mint_sy)
    ro(p.syMarket),
    ro(p.baseMint),
    rw(p.syMint),
    rw(p.baseSrc),
    rw(p.baseVault),

    // core (strip)
    rw(p.authority),
    rw(p.vault),
    rw(p.sySrc),
    rw(p.escrowSy),
    rw(p.ytDst),
    rw(p.ptDst),
    rw(p.mintYt),
    rw(p.mintPt),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
    ro(p.addressLookupTable),

    // program accounts
    ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
    ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
    rw(p.yieldPosition),
    ro(p.coreEventAuthority),

    ...(p.remainingAccounts ?? []),
  ];

  return new TransactionInstruction({
    programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
    keys,
    data: Buffer.concat([ROUTER_DISC.wrapperStrip, u64le(p.amountBase)]),
  });
}

export interface WrapperMergeParams extends WrapperCommon {
  /** User's SY ATA (pass-through). */
  sySrc: PublicKey;
  /** User's base-asset destination ATA. */
  baseDst: PublicKey;
  /** Vault's own SY escrow. */
  escrowSy: PublicKey;
  /** User's YT source ATA. */
  ytSrc: PublicKey;
  /** User's PT source ATA. */
  ptSrc: PublicKey;
  mintPt: PublicKey;
  mintYt: PublicKey;
  /** Amount of PT+YT being merged back (1:1 pre-maturity; PT-only at/after maturity). */
  amountPy: BN | bigint | number;
  remainingAccounts?: AccountMeta[];
}

/** PT + YT → base (core.merge → adapter.redeem_sy). */
export function buildWrapperMerge(p: WrapperMergeParams): TransactionInstruction {
  const keys: AccountMeta[] = [
    signer(p.user),

    // adapter (redeem_sy)
    ro(p.syMarket),
    ro(p.baseMint),
    rw(p.syMint),
    rw(p.baseDst),
    rw(p.baseVault),

    // core (merge)
    rw(p.authority),
    rw(p.vault),
    rw(p.sySrc),
    rw(p.escrowSy),
    rw(p.ytSrc),
    rw(p.ptSrc),
    rw(p.mintYt),
    rw(p.mintPt),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
    ro(p.addressLookupTable),

    ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
    ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
    rw(p.yieldPosition),
    ro(p.coreEventAuthority),

    ...(p.remainingAccounts ?? []),
  ];

  return new TransactionInstruction({
    programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
    keys,
    data: Buffer.concat([ROUTER_DISC.wrapperMerge, u64le(p.amountPy)]),
  });
}

// ---------------------------------------------------------------------------
// wrapper_buy_pt / wrapper_sell_pt
// ---------------------------------------------------------------------------

export interface WrapperBuyPtParams extends WrapperCommon {
  baseSrc: PublicKey;
  sySrc: PublicKey;
  ptDst: PublicKey;
  market: PublicKey;
  marketEscrowSy: PublicKey;
  marketEscrowPt: PublicKey;
  marketAlt: PublicKey;
  tokenFeeTreasurySy: PublicKey;
  /** Exact PT out the user wants. */
  ptAmount: BN | bigint | number;
  /** Max base to spend (adapter mints up to this much SY). */
  maxBase: BN | bigint | number;
  /**
   * Slippage bound on the AMM. Negative — SY leaves the user when buying
   * PT. Denominated in SY base units.
   */
  maxSyIn: BN | bigint | number;
  remainingAccounts?: AccountMeta[];
}

/** Base → PT at AMM (mint_sy → trade_pt buy). Leftover SY stays in user's ATA. */
export function buildWrapperBuyPt(
  p: WrapperBuyPtParams
): TransactionInstruction {
  const keys: AccountMeta[] = [
    signer(p.user),

    // adapter (mint_sy)
    ro(p.syMarket),
    ro(p.baseMint),
    rw(p.syMint),
    rw(p.baseSrc),
    rw(p.baseVault),

    // core (trade_pt)
    rw(p.market),
    rw(p.sySrc),
    rw(p.ptDst),
    rw(p.marketEscrowSy),
    rw(p.marketEscrowPt),
    ro(p.marketAlt),
    ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
    rw(p.tokenFeeTreasurySy),

    ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
    ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
    ro(p.coreEventAuthority),

    ...(p.remainingAccounts ?? []),
  ];

  return new TransactionInstruction({
    programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
    keys,
    data: Buffer.concat([
      ROUTER_DISC.wrapperBuyPt,
      u64le(p.ptAmount),
      u64le(p.maxBase),
      i64le(p.maxSyIn),
    ]),
  });
}

// ---------------------------------------------------------------------------
// wrapper_buy_yt
// ---------------------------------------------------------------------------

export interface WrapperBuyYtParams extends WrapperCommon {
  baseSrc: PublicKey;
  sySrc: PublicKey;
  ytDst: PublicKey;
  ptDst: PublicKey;
  market: PublicKey;
  marketEscrowSy: PublicKey;
  marketEscrowPt: PublicKey;
  marketAlt: PublicKey;
  tokenFeeTreasurySy: PublicKey;

  // strip-cascade (vault side)
  /** Vault authority PDA. */
  vaultAuthority: PublicKey;
  /** Vault's own SY escrow (distinct from the market escrows). */
  escrowSyVault: PublicKey;
  mintYt: PublicKey;
  mintPt: PublicKey;
  /** Vault's address_lookup_table. */
  vaultAlt: PublicKey;

  /** Base to wrap into SY up-front (adapter.mint_sy amount). */
  baseIn: BN | bigint | number;
  /** Max SY spend on the AMM leg (buy_yt's slippage bound). */
  syIn: BN | bigint | number;
  /** Exact YT out the trade should produce. */
  ytOut: BN | bigint | number;
  remainingAccounts?: AccountMeta[];
}

/**
 * Base → YT (adapter.mint_sy → core.buy_yt).
 *
 * buy_yt internally self-CPIs into `strip`, so the vault-side accounts
 * (`vault`, `vault_authority`, `escrow_sy_vault`, `mint_yt/pt`,
 * `vault_alt`, `yield_position`) are required alongside the market
 * trade accounts. This is the complement to `buildWrapperSellYt`.
 */
export function buildWrapperBuyYt(
  p: WrapperBuyYtParams
): TransactionInstruction {
  const keys: AccountMeta[] = [
    signer(p.user),

    // adapter (mint_sy)
    ro(p.syMarket),
    ro(p.baseMint),
    rw(p.syMint),
    rw(p.baseSrc),
    rw(p.baseVault),

    // core.buy_yt (trade side)
    rw(p.market),
    rw(p.sySrc),
    rw(p.ytDst),
    rw(p.ptDst),
    rw(p.marketEscrowSy),
    rw(p.marketEscrowPt),
    rw(p.tokenFeeTreasurySy),
    ro(p.marketAlt),

    // strip-cascade
    rw(p.vaultAuthority),
    rw(p.vault),
    rw(p.escrowSyVault),
    rw(p.mintYt),
    rw(p.mintPt),
    ro(p.vaultAlt),
    rw(p.yieldPosition),

    ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
    ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
    ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
    ro(p.coreEventAuthority),

    ...(p.remainingAccounts ?? []),
  ];

  return new TransactionInstruction({
    programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
    keys,
    data: Buffer.concat([
      ROUTER_DISC.wrapperBuyYt,
      u64le(p.baseIn),
      u64le(p.syIn),
      u64le(p.ytOut),
    ]),
  });
}

// ---------------------------------------------------------------------------
// wrapper_sell_pt
// ---------------------------------------------------------------------------

export interface WrapperSellPtParams extends WrapperCommon {
  /** User's SY ATA (pass-through: trade lands SY here, redeem drains it). */
  sySrc: PublicKey;
  /** User's PT source ATA. */
  ptSrc: PublicKey;
  /** User's base destination ATA. */
  baseDst: PublicKey;
  market: PublicKey;
  marketEscrowSy: PublicKey;
  marketEscrowPt: PublicKey;
  marketAlt: PublicKey;
  tokenFeeTreasurySy: PublicKey;
  /** PT amount being sold. Positive u64. */
  ptIn: BN | bigint | number;
  /** Slippage floor on the AMM leg (minimum SY out before redeem). */
  minSyOut: BN | bigint | number;
  remainingAccounts?: AccountMeta[];
}

/** PT → base (core.sell_pt → adapter.redeem_sy). */
export function buildWrapperSellPt(
  p: WrapperSellPtParams
): TransactionInstruction {
  const keys: AccountMeta[] = [
    signer(p.user),

    // core (trade_pt)
    rw(p.market),
    rw(p.sySrc),
    rw(p.ptSrc),
    rw(p.marketEscrowSy),
    rw(p.marketEscrowPt),
    ro(p.marketAlt),
    rw(p.tokenFeeTreasurySy),

    // adapter (redeem_sy)
    ro(p.syMarket),
    ro(p.baseMint),
    rw(p.syMint),
    rw(p.baseVault),
    rw(p.baseDst),

    ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
    ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
    ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
    ro(p.coreEventAuthority),

    ...(p.remainingAccounts ?? []),
  ];

  return new TransactionInstruction({
    programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
    keys,
    data: Buffer.concat([
      ROUTER_DISC.wrapperSellPt,
      u64le(p.ptIn),
      u64le(p.minSyOut),
    ]),
  });
}

// ---------------------------------------------------------------------------
// wrapper_sell_yt
// ---------------------------------------------------------------------------

export interface WrapperSellYtParams {
  user: PublicKey;

  // core.sell_yt
  market: PublicKey;
  /** User's YT source ATA. */
  ytSrc: PublicKey;
  /** User's PT source ATA (sell_yt self-CPIs to merge, which burns matched PT+YT). */
  ptSrc: PublicKey;
  /** User's SY ATA — pass-through for the AMM proceeds before redeem. */
  sySrc: PublicKey;
  marketEscrowSy: PublicKey;
  marketEscrowPt: PublicKey;
  marketAlt: PublicKey;
  tokenFeeTreasurySy: PublicKey;

  // merge-cascade (vault-level)
  vault: PublicKey;
  /** Vault authority PDA. */
  vaultAuthority: PublicKey;
  /** Vault's SY escrow (per-vault, distinct from the market escrows). */
  escrowSyVault: PublicKey;
  mintYt: PublicKey;
  mintPt: PublicKey;
  /** Vault's address_lookup_table. */
  vaultAlt: PublicKey;
  /** Vault's yield_position (PDA of authority + vault). */
  yieldPosition: PublicKey;

  // adapter.redeem_sy
  syMarket: PublicKey;
  baseMint: PublicKey;
  syMint: PublicKey;
  baseVault: PublicKey;
  /** User's base-asset destination ATA. */
  baseDst: PublicKey;

  /** YT amount being sold. */
  ytIn: BN | bigint | number;
  /** Slippage floor on the AMM leg (minimum SY out before redeem). */
  minSyOut: BN | bigint | number;

  // Program-id overrides
  coreProgram?: PublicKey;
  syProgram?: PublicKey;
  routerProgram?: PublicKey;
  tokenProgram?: PublicKey;
  coreEventAuthority: PublicKey;

  remainingAccounts?: AccountMeta[];
}

/**
 * YT → base (core.sell_yt → adapter.redeem_sy).
 *
 * sell_yt internally self-CPIs to merge, so the vault-side accounts
 * (`vault`, `vault_authority`, `escrow_sy_vault`, `mint_yt`, `mint_pt`,
 * `vault_alt`, `yield_position`) must be present in addition to the
 * market-side trade accounts.
 *
 * This is the companion piece to `buildWrapperStrip` that unlocks the
 * full `zap.buildZapInToPt` flow (strip → sell_yt → user holds PT only).
 */
export function buildWrapperSellYt(
  p: WrapperSellYtParams
): TransactionInstruction {
  const keys: AccountMeta[] = [
    signer(p.user),

    // core.sell_yt (trade side)
    rw(p.market),
    rw(p.ytSrc),
    rw(p.ptSrc),
    rw(p.sySrc),
    rw(p.marketEscrowSy),
    rw(p.marketEscrowPt),
    ro(p.marketAlt),
    rw(p.tokenFeeTreasurySy),

    // merge-cascade
    rw(p.vault),
    rw(p.vaultAuthority),
    rw(p.escrowSyVault),
    rw(p.mintYt),
    rw(p.mintPt),
    ro(p.vaultAlt),
    rw(p.yieldPosition),

    // adapter.redeem_sy
    ro(p.syMarket),
    ro(p.baseMint),
    rw(p.syMint),
    rw(p.baseVault),
    rw(p.baseDst),

    ro(p.tokenProgram ?? TOKEN_PROGRAM_ID),
    ro(p.syProgram ?? GENERIC_EXCHANGE_RATE_SY_PROGRAM_ID),
    ro(p.coreProgram ?? CLEARSTONE_CORE_PROGRAM_ID),
    ro(p.coreEventAuthority),

    ...(p.remainingAccounts ?? []),
  ];

  return new TransactionInstruction({
    programId: p.routerProgram ?? CLEARSTONE_ROUTER_PROGRAM_ID,
    keys,
    data: Buffer.concat([
      ROUTER_DISC.wrapperSellYt,
      u64le(p.ytIn),
      u64le(p.minSyOut),
    ]),
  });
}

// ---------------------------------------------------------------------------
// Stubs for the remaining 7 wrappers — account shapes match the Rust
// side; implement on demand. Each follows the exact same pattern.
// ---------------------------------------------------------------------------

export const TODO_BUILDERS = [
  "buildWrapperCollectInterest",
  "buildWrapperProvideLiquidity",
  "buildWrapperProvideLiquidityClassic",
  "buildWrapperProvideLiquidityBase",
  "buildWrapperWithdrawLiquidity",
  "buildWrapperWithdrawLiquidityClassic",
] as const;
