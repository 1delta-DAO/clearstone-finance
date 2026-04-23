import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";

/**
 * Base URL of the clearstone backend-edge worker.
 *
 * Leave unset (or point at `/fixed-yield` for a same-origin deploy) and
 * the hook falls back to the fixture data below. Set
 * `VITE_EDGE_URL` to e.g. `https://clearstone-edge.workers.dev` to
 * consume the live `/fixed-yield/markets` endpoint.
 */
const EDGE_URL = (import.meta as unknown as { env: Record<string, string> })
  .env.VITE_EDGE_URL;

/**
 * A snapshot of a single PT market, as consumed by the UI.
 *
 * When the edge worker is reachable, this hook fetches
 * `${EDGE_URL}/fixed-yield/markets` and decodes the response. Otherwise
 * it falls back to the static fixture so the UI keeps rendering.
 */
/**
 * Fully-resolved account set for a market — everything the SDK needs
 * to build a ready-to-sign zap-in / zap-out tx beyond user + amount.
 *
 * Only present when the backend indexer has resolved real on-chain
 * state. Fixture-mode markets leave `accounts` undefined; the UI will
 * error loudly before attempting to simulate against bogus PDAs.
 */
export interface MarketAccounts {
  syProgram: PublicKey;
  syMarket: PublicKey;
  syMint: PublicKey;
  baseVault: PublicKey;

  vaultAuthority: PublicKey;
  yieldPosition: PublicKey;
  mintPt: PublicKey;
  mintYt: PublicKey;
  escrowSy: PublicKey;
  vaultAlt: PublicKey;
  coreEventAuthority: PublicKey;

  mintLp: PublicKey;
  marketEscrowPt: PublicKey;
  marketEscrowSy: PublicKey;
  marketAlt: PublicKey;
  tokenFeeTreasurySy: PublicKey;
}

export interface FixedYieldMarket {
  /** Stable id — `vault + seed_id` fingerprint. */
  id: string;
  /** Human label, e.g. "USDC · Apr 2026". */
  label: string;
  /** Underlying (what user deposits / receives). Symbol for display. */
  baseSymbol: string;
  /** Base mint. */
  baseMint: PublicKey;
  /** 6 decimals for USDC/USDT, 8 for most, etc. */
  baseDecimals: number;

  /** Vault account (clearstone_core). */
  vault: PublicKey;
  /** Market account (per-maturity). */
  market: PublicKey;

  /** Maturity unix-seconds. */
  maturityTs: number;

  /** AMM-derived PT spot price, in base units per PT-base-unit. */
  ptPrice: number;
  /** Current SY exchange rate to base. */
  syExchangeRate: number;

  /** KYC gate: vault was created with whitelist_required = true. */
  kycGated: boolean;

  /** Full account metadata from backend indexer; undefined in fixture mode. */
  accounts?: MarketAccounts;
}

function decodeAccounts(raw: Record<string, string>): MarketAccounts {
  const pk = (k: string) => new PublicKey(raw[k]);
  return {
    syProgram: pk("syProgram"),
    syMarket: pk("syMarket"),
    syMint: pk("syMint"),
    baseVault: pk("baseVault"),
    vaultAuthority: pk("vaultAuthority"),
    yieldPosition: pk("yieldPosition"),
    mintPt: pk("mintPt"),
    mintYt: pk("mintYt"),
    escrowSy: pk("escrowSy"),
    vaultAlt: pk("vaultAlt"),
    coreEventAuthority: pk("coreEventAuthority"),
    mintLp: pk("mintLp"),
    marketEscrowPt: pk("marketEscrowPt"),
    marketEscrowSy: pk("marketEscrowSy"),
    marketAlt: pk("marketAlt"),
    tokenFeeTreasurySy: pk("tokenFeeTreasurySy"),
  };
}

const FIXTURE: FixedYieldMarket[] = [
  {
    id: "fixture-usdc-90d",
    label: "USDC · 90d",
    baseSymbol: "USDC",
    baseMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    baseDecimals: 6,
    vault: PublicKey.default,
    market: PublicKey.default,
    maturityTs: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
    ptPrice: 0.9765,
    syExchangeRate: 1.0,
    kycGated: false,
  },
  {
    id: "fixture-usdc-30d",
    label: "USDC · 30d",
    baseSymbol: "USDC",
    baseMint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    baseDecimals: 6,
    vault: PublicKey.default,
    market: PublicKey.default,
    maturityTs: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    ptPrice: 0.9925,
    syExchangeRate: 1.0,
    kycGated: false,
  },
  {
    id: "fixture-usdt-180d",
    label: "USDT · 180d",
    baseSymbol: "USDT",
    baseMint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    baseDecimals: 6,
    vault: PublicKey.default,
    market: PublicKey.default,
    maturityTs: Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60,
    ptPrice: 0.9480,
    syExchangeRate: 1.0,
    kycGated: true,
  },
];

/**
 * Returns the currently-open fixed-yield markets. v0: fixture data.
 * v1 TODO: swap for `fetch(EDGE_URL + "/markets")` driven by
 * backend-edge's indexer.
 */
export function useFixedYieldMarkets(): {
  markets: FixedYieldMarket[];
  loading: boolean;
  error: Error | null;
} {
  const [state, setState] = useState<{
    markets: FixedYieldMarket[];
    loading: boolean;
    error: Error | null;
  }>({ markets: [], loading: true, error: null });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!EDGE_URL) {
        // Dev fallback — show fixture immediately.
        setState({ markets: FIXTURE, loading: false, error: null });
        return;
      }

      try {
        const res = await fetch(`${EDGE_URL}/fixed-yield/markets`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          markets: Array<{
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
            accounts?: Record<string, string>;
          }>;
        };
        if (cancelled) return;
        const markets: FixedYieldMarket[] = body.markets.map((m) => ({
          ...m,
          baseMint: new PublicKey(m.baseMint),
          vault: new PublicKey(m.vault),
          market: new PublicKey(m.market),
          accounts: m.accounts ? decodeAccounts(m.accounts) : undefined,
        }));
        setState({ markets, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        // Soft-degrade to fixture on fetch failure — keep the UI alive.
        setState({
          markets: FIXTURE,
          loading: false,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
