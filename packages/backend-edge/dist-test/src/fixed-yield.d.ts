/**
 * Fixed-yield market indexer — Cloudflare Worker route.
 *
 * Serves the same `FixedYieldMarket` shape the retail/institutional
 * frontends consume. v0 implementation returns a seeded fixture so
 * the frontend can be wired end-to-end against a real HTTP endpoint
 * while the on-chain data path is built out.
 *
 * v1 implementation (outlined below as `fetchMarketsOnChain`) will:
 *   1. Scan all `Vault` accounts owned by clearstone_core.
 *   2. For each vault, enumerate its `MarketTwo` children (seed_id 1..=255).
 *   3. For each market, read PT price + SY exchange rate + maturity.
 *   4. Derive `kyc_gated` from the vault's curator config.
 *
 * Cached at the edge for 15–30s — PT prices move but the UI shouldn't
 * hammer RPC.
 */
import { Hono } from "hono";
import type { Env } from "./types.js";
export declare const fixedYield: Hono<{
    Bindings: Env;
}, import("hono/types").BlankSchema, "/">;
export interface MarketDto {
    id: string;
    label: string;
    baseSymbol: string;
    baseMint: string;
    baseDecimals: number;
    vault: string;
    market: string;
    maturityTs: number;
    ptPrice: number;
    syExchangeRate: number;
    kycGated: boolean;
    /**
     * Everything the SDK needs to build a ready-to-sign deposit / redeem
     * tx beyond what the frontend already knows (user, amounts). Omitted
     * in v0 fixture mode to signal "accounts not resolvable" — frontend
     * should error loudly rather than build a tx against bogus PDAs.
     */
    accounts?: MarketAccountsDto;
}
/**
 * Adapter + vault + market PDAs + user-side token-account derivation
 * anchors. These are read from on-chain state by the indexer; the
 * frontend passes them verbatim into `fixedYield.tx.buildZapInToPtV0Tx`
 * / `buildZapOutToBaseV0Tx`.
 */
export interface MarketAccountsDto {
    syProgram: string;
    syMarket: string;
    syMint: string;
    /** Adapter-owned vault holding wrapped base. */
    baseVault: string;
    vaultAuthority: string;
    yieldPosition: string;
    mintPt: string;
    mintYt: string;
    /** Vault's own SY escrow. */
    escrowSy: string;
    /** Vault's address_lookup_table. */
    vaultAlt: string;
    coreEventAuthority: string;
    mintLp: string;
    marketEscrowPt: string;
    marketEscrowSy: string;
    marketAlt: string;
    tokenFeeTreasurySy: string;
}
export interface VaultDto {
    id: string;
    label: string;
    underlying: string;
    baseDecimals: number;
    curator: string;
    creatorFeeBps: number;
    whitelistRequired: boolean;
    /** Markets tracked by this vault, by maturity (ascending). */
    markets: MarketDto[];
}
export interface UserPositionDto {
    /** PT balance in base units. */
    ptAmount: string;
    /** YT balance in base units. */
    ytAmount: string;
    /** LP balance (if any). */
    lpAmount: string;
    /** For auto-roll opt-in vaults, the next scheduled roll ts. */
    nextAutoRollTs: number | null;
}
/**
 * Operator-curated registry of markets. Each entry carries the static
 * pubkeys that are known at market-creation time (mints, escrows,
 * ALTs, SY-program wiring). The indexer reads the dynamic bits
 * (ptPrice, syExchangeRate, maturityTs) from the accounts themselves.
 *
 * Populate by setting the `MARKET_REGISTRY` env var to a JSON array
 * of `MarketRegistryEntry`. Empty or unset → fixture path wins.
 *
 * Rationale for a curated registry rather than `getProgramAccounts`:
 *   - Public RPCs rate-limit `getProgramAccounts` heavily.
 *   - `seed_id` in the MarketTwo PDA is not trivially discoverable
 *     without walking a bitmap — cheaper for operators to list markets
 *     as they're created than to reverse-discover them.
 *   - Lets the operator gate which markets show up in the retail UI
 *     without changing the frontend.
 */
export interface MarketRegistryEntry {
    id: string;
    label: string;
    baseSymbol: string;
    baseDecimals: number;
    kycGated: boolean;
    vault: string;
    market: string;
    baseMint: string;
    accounts: MarketAccountsDto;
}
/**
 * Vault layout prefix (fixed-size, up to the Number fields we skip):
 *
 *   8    discriminator
 *   32   curator
 *   2    creator_fee_bps
 *   1    reentrancy_guard
 *   32   sy_program
 *   32   mint_sy
 *   32   mint_yt
 *   32   mint_pt
 *   32   escrow_yt
 *   32   escrow_sy
 *   32   yield_position
 *   32   address_lookup_table
 *   4    start_ts      ← read
 *   4    duration      ← read
 *
 * start_ts begins at byte 331, duration at 335.
 */
export declare const VAULT_START_TS_OFFSET = 331;
export declare const VAULT_DURATION_OFFSET = 335;
export declare function decodeVaultMaturity(data: Uint8Array): number;
/**
 * MarketTwo header (everything before `financials`):
 *
 *   8    discriminator
 *   32   curator
 *   2    creator_fee_bps
 *   1    reentrancy_guard
 *   32   address_lookup_table
 *   32   mint_pt
 *   32   mint_sy
 *   32   vault
 *   32   mint_lp
 *   32   token_pt_escrow
 *   32   token_sy_escrow
 *   32   token_fee_treasury_sy
 *   2    fee_treasury_sy_bps
 *   32   self_address
 *   1    signer_bump
 *   1    status_flags
 *   32   sy_program
 *                       = 365 bytes
 *
 * financials.expiration_ts @ 365 (u64), pt_balance @ 373, sy_balance @ 381.
 */
export declare const MARKET_PT_BALANCE_OFFSET = 373;
export declare const MARKET_SY_BALANCE_OFFSET = 381;
export declare function decodeMarketPtPrice(data: Uint8Array): number;
//# sourceMappingURL=fixed-yield.d.ts.map