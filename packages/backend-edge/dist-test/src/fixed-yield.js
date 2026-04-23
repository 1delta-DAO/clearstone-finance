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
import { Connection, PublicKey } from "@solana/web3.js";
export const fixedYield = new Hono();
// ---------------------------------------------------------------------------
// Fixtures (v0). Replace with `fetchMarketsOnChain` once the indexer is real.
// ---------------------------------------------------------------------------
const NOW = () => Math.floor(Date.now() / 1000);
function fixtureMarkets() {
    return [
        {
            id: "fx-usdc-30d",
            label: "USDC · 30d",
            baseSymbol: "USDC",
            baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            baseDecimals: 6,
            vault: "11111111111111111111111111111111",
            market: "11111111111111111111111111111111",
            maturityTs: NOW() + 30 * 86400,
            ptPrice: 0.9925,
            syExchangeRate: 1.0,
            kycGated: false,
        },
        {
            id: "fx-usdc-90d",
            label: "USDC · 90d",
            baseSymbol: "USDC",
            baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            baseDecimals: 6,
            vault: "11111111111111111111111111111111",
            market: "11111111111111111111111111111111",
            maturityTs: NOW() + 90 * 86400,
            ptPrice: 0.9765,
            syExchangeRate: 1.0,
            kycGated: false,
        },
        {
            id: "fx-usdt-180d",
            label: "USDT · 180d (KYC)",
            baseSymbol: "USDT",
            baseMint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            baseDecimals: 6,
            vault: "11111111111111111111111111111111",
            market: "11111111111111111111111111111111",
            maturityTs: NOW() + 180 * 86400,
            ptPrice: 0.948,
            syExchangeRate: 1.0,
            kycGated: true,
        },
    ];
}
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/**
 * GET /markets
 *
 * Returns all active PT markets with derived PT price + implied fixed
 * APY inputs. The frontend computes the APY itself via the SDK's
 * `quoteFixedApy` helper so we don't need to agree on math twice.
 */
fixedYield.get("/markets", async (c) => {
    const markets = await getMarkets(c.env);
    return c.json({ markets }, 200, {
        "Cache-Control": "public, max-age=30",
    });
});
/**
 * GET /markets/:id
 *
 * Single-market detail endpoint. Useful when the deposit modal wants
 * a depth/slippage curve without re-fetching the full list.
 */
fixedYield.get("/markets/:id", async (c) => {
    const id = c.req.param("id");
    const markets = await getMarkets(c.env);
    const market = markets.find((m) => m.id === id);
    if (!market)
        return c.json({ error: "not found" }, 404);
    return c.json({ market }, 200, {
        "Cache-Control": "public, max-age=15",
    });
});
/**
 * GET /vaults
 *
 * Groups markets by vault. Institutional/curator frontends use this to
 * render maturity ladders per underlying.
 */
fixedYield.get("/vaults", async (c) => {
    const markets = await getMarkets(c.env);
    const vaults = groupByVault(markets);
    return c.json({ vaults }, 200, {
        "Cache-Control": "public, max-age=30",
    });
});
/**
 * GET /vaults/:id/positions/:user
 *
 * Returns a specific user's PT + YT + LP holdings in the vault plus any
 * auto-roll policy. Not cached — balances change per tx.
 */
fixedYield.get("/vaults/:id/positions/:user", async (c) => {
    const vaultId = c.req.param("id");
    const user = c.req.param("user");
    const position = await fetchUserPosition(c.env, vaultId, user);
    return c.json({ position }, 200, {
        "Cache-Control": "no-store",
    });
});
// ---------------------------------------------------------------------------
// Internals — v1 replaces these with real RPC reads. Keep the names
// stable so the route handlers don't change when wiring the real path.
// ---------------------------------------------------------------------------
async function getMarkets(env) {
    // 1. KV cache hit.
    const cached = await env.WHITELIST_CACHE?.get("fixed-yield:markets:v1");
    if (cached) {
        try {
            return JSON.parse(cached);
        }
        catch {
            /* ignore — recompute */
        }
    }
    // 2. Live RPC if a registry is configured.
    try {
        const live = await fetchMarketsOnChain(env);
        if (live && live.length > 0) {
            await env.WHITELIST_CACHE?.put("fixed-yield:markets:v1", JSON.stringify(live), { expirationTtl: 30 });
            return live;
        }
    }
    catch (err) {
        console.error("fetchMarketsOnChain failed, falling back to fixture:", err);
    }
    // 3. Fixture.
    return fixtureMarkets();
}
function groupByVault(markets) {
    const byVault = new Map();
    for (const m of markets) {
        const arr = byVault.get(m.vault) ?? [];
        arr.push(m);
        byVault.set(m.vault, arr);
    }
    return [...byVault.entries()].map(([vault, ms]) => {
        ms.sort((a, b) => a.maturityTs - b.maturityTs);
        const first = ms[0];
        return {
            id: vault,
            label: `${first.baseSymbol} vault`,
            underlying: first.baseMint,
            baseDecimals: first.baseDecimals,
            curator: "11111111111111111111111111111111",
            creatorFeeBps: 0,
            whitelistRequired: first.kycGated,
            markets: ms,
        };
    });
}
/**
 * v0 stub — returns a flat "no balance" response. v1 reads the user's
 * PT/YT/LP ATAs from RPC and optionally the auto-roll policy PDA.
 */
async function fetchUserPosition(_env, _vaultId, _user) {
    return {
        ptAmount: "0",
        ytAmount: "0",
        lpAmount: "0",
        nextAutoRollTs: null,
    };
}
function parseRegistry(env) {
    const raw = env.MARKET_REGISTRY;
    if (!raw)
        return [];
    try {
        return JSON.parse(raw);
    }
    catch (err) {
        console.error("MARKET_REGISTRY is not valid JSON:", err);
        return [];
    }
}
/**
 * Read the vault + market accounts for every configured entry and
 * decorate with dynamic fields. Returns `null` when the registry is
 * empty so the caller can fall through to the fixture.
 */
async function fetchMarketsOnChain(env) {
    const registry = parseRegistry(env);
    if (registry.length === 0)
        return null;
    const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
    const keys = registry.flatMap((r) => [
        new PublicKey(r.vault),
        new PublicKey(r.market),
    ]);
    // @solana/web3.js caps at 100 per batch; we expect far fewer markets.
    const infos = await conn.getMultipleAccountsInfo(keys);
    const out = [];
    for (let i = 0; i < registry.length; i++) {
        const entry = registry[i];
        const vaultInfo = infos[i * 2];
        const marketInfo = infos[i * 2 + 1];
        if (!vaultInfo || !marketInfo) {
            console.warn(`Missing account data for ${entry.id}`);
            continue;
        }
        const maturityTs = decodeVaultMaturity(vaultInfo.data);
        const ptPrice = decodeMarketPtPrice(marketInfo.data);
        out.push({
            id: entry.id,
            label: entry.label,
            baseSymbol: entry.baseSymbol,
            baseMint: entry.baseMint,
            baseDecimals: entry.baseDecimals,
            vault: entry.vault,
            market: entry.market,
            maturityTs,
            ptPrice,
            // TODO(decoder): read `last_seen_sy_exchange_rate` from the vault.
            // It's a `precise_number::Number` — non-trivial borsh type. v1
            // keeps this at 1.0 for stablecoin-backed markets; revisit when
            // yield-bearing collateral markets (eUSX / JitoSOL-style) ship.
            syExchangeRate: 1.0,
            kycGated: entry.kycGated,
            accounts: entry.accounts,
        });
    }
    return out;
}
// ---------------------------------------------------------------------------
// Borsh offset decoders — hand-rolled to avoid pulling @coral-xyz/anchor
// into the worker. Offsets follow the field order in
//   clearstone-fixed-yield/programs/clearstone_core/src/state/{vault,market_two}.rs
// If those structs are edited, bump the offsets below and rerun the
// account-dump fixture test before deploying.
// ---------------------------------------------------------------------------
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
export const VAULT_START_TS_OFFSET = 331;
export const VAULT_DURATION_OFFSET = 335;
export function decodeVaultMaturity(data) {
    if (data.length < VAULT_DURATION_OFFSET + 4) {
        throw new Error(`Vault account too small: ${data.length} < ${VAULT_DURATION_OFFSET + 4}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const startTs = view.getUint32(VAULT_START_TS_OFFSET, true);
    const duration = view.getUint32(VAULT_DURATION_OFFSET, true);
    return startTs + duration;
}
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
export const MARKET_PT_BALANCE_OFFSET = 373;
export const MARKET_SY_BALANCE_OFFSET = 381;
export function decodeMarketPtPrice(data) {
    if (data.length < MARKET_SY_BALANCE_OFFSET + 8) {
        throw new Error(`MarketTwo account too small: ${data.length} < ${MARKET_SY_BALANCE_OFFSET + 8}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const pt = view.getBigUint64(MARKET_PT_BALANCE_OFFSET, true);
    const sy = view.getBigUint64(MARKET_SY_BALANCE_OFFSET, true);
    if (pt === 0n)
        return 0;
    // Spot price approximation: SY-per-PT from the AMM reserves.
    // Ignores virtual reserves + curve shape; fine for display.
    return Number(sy) / Number(pt);
}
//# sourceMappingURL=fixed-yield.js.map