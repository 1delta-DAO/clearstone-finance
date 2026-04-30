import { Fragment, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CSSOL_MINT,
  CSSOL_RESERVE,
  CSSOL_RESERVE_ORACLE,
  CSSOL_VAULT,
  CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  CSSOL_WT_MINT,
  CSSOL_WT_RESERVE,
  ELEVATION_GROUP_LST_SOL,
  JITO_VAULT_PROGRAM,
  KLEND_MARKET,
  KLEND_PROGRAM,
  WSOL_RESERVE,
  WSOL_RESERVE_ORACLE,
} from "../lib/addresses";
import { buildWrapWithJitoVaultIx, readVaultState } from "../lib/jitoVault";
import {
  buildBorrowObligationLiquidityIx,
  buildDepositCsSolIx,
  buildDepositLiquidityAndCollateralIx,
  buildInitObligationIx,
  buildInitUserMetadataIx,
  buildRefreshObligationIx,
  buildRefreshReserveIx,
  buildRepayObligationLiquidityIx,
  buildRequestElevationGroupIx,
  buildWithdrawCollateralAndRedeemIx,
  obligationPda,
  userMetadataPda,
} from "../lib/klend";
import {
  cTokensToUnderlying,
  discoverMarketReserves,
  readObligation,
  readReserve,
  sfToNumber,
  type ObligationView,
  type ReserveView,
} from "../lib/obligationView";

function short(s: string | PublicKey, n = 6): string {
  const v = typeof s === "string" ? s : s.toBase58();
  return `${v.slice(0, n)}…${v.slice(-4)}`;
}
function fmt(n: number, dp = 6): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

type ReserveMeta = {
  symbol: string;
  reserve: PublicKey;
  oracle?: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
};

// Known mint → display info. Anything not in this map is shown by
// shortened mint pubkey, with token-program/decimals derived on-chain.
const KNOWN_MINTS: Record<string, { symbol: string; tokenProgram: PublicKey; oracle?: PublicKey }> = {
  [CSSOL_MINT.toBase58()]: { symbol: "csSOL", tokenProgram: TOKEN_2022_PROGRAM_ID, oracle: CSSOL_RESERVE_ORACLE },
  [NATIVE_MINT.toBase58()]: { symbol: "wSOL", tokenProgram: TOKEN_PROGRAM_ID, oracle: WSOL_RESERVE_ORACLE },
  ...(CSSOL_WT_MINT ? { [CSSOL_WT_MINT.toBase58()]: { symbol: "csSOL-WT", tokenProgram: TOKEN_2022_PROGRAM_ID, oracle: CSSOL_RESERVE_ORACLE } } : {}),
  // Stables on the v2 unified csSOL market (see
  // scripts/bootstrap-cssol-market-v2.ts). Oracles are mock-oracle
  // PriceUpdateV2 accounts pinned to $1.08 (deUSX) and $1.00 (sUSDC).
  "8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT": { symbol: "deUSX", tokenProgram: TOKEN_2022_PROGRAM_ID, oracle: new PublicKey("CbZjUS1RjAVws1uAeNZVarPUy2e1daRnJwJcEnNqYD7V") },
  "8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g": { symbol: "sUSDC", tokenProgram: TOKEN_PROGRAM_ID, oracle: new PublicKey("D9P2AgwpnjVDCWG9DpkR9dxGSLNHASc93fj72DGheNP8") },
};

const ELEVATION_GROUP_STABLES = 1;

const ELEVATION_GROUPS: { id: number; label: string }[] = [
  { id: 0, label: "0 — None (default)" },
  { id: ELEVATION_GROUP_STABLES, label: `${ELEVATION_GROUP_STABLES} — Stables (90% LTV; deUSX collateral, sUSDC debt)` },
  { id: ELEVATION_GROUP_LST_SOL, label: `${ELEVATION_GROUP_LST_SOL} — LST/SOL (90% LTV; csSOL+csSOL-WT collateral, wSOL debt)` },
];

// Markets we can browse from this tab. v2 (KLEND_MARKET, the active one)
// is the unified market built by scripts/bootstrap-cssol-market-v2.ts —
// all five reserves and both elevation groups configured cleanly. v1
// (`2gRy7f…heyejW`) and the standalone eUSX market are kept read-only
// so any pre-migration test state can be inspected during wind-down.
const MARKETS: { pubkey: PublicKey; label: string; active: boolean }[] = [
  { pubkey: KLEND_MARKET, label: "csSOL market v2 (active — unified, both eMode groups)", active: true },
  { pubkey: new PublicKey("2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW"), label: "csSOL market v1 (read-only — config locked)", active: false },
  { pubkey: new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98"), label: "eUSX market (read-only — superseded by v2)", active: false },
];

export default function LendingPositionTab() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [obligation, setObligation] = useState<ObligationView | null>(null);
  const [reserves, setReserves] = useState<Map<string, ReserveView>>(new Map());
  // Discovered list of every reserve in the klend market — populated
  // once via getProgramAccounts and reused for the balance sheet.
  const [marketReserves, setMarketReserves] = useState<ReserveMeta[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<PublicKey>(KLEND_MARKET);
  const [targetElevationGroup, setTargetElevationGroup] = useState<number>(ELEVATION_GROUP_LST_SOL);
  const isActiveMarket = selectedMarket.equals(KLEND_MARKET);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Per-reserve action input state (amount strings keyed by reserve symbol+action).
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [wrapAmount, setWrapAmount] = useState<string>("0.05");

  // Which row currently has its action panel expanded. Only one open at
  // a time keeps the table compact — clicking a row's action button
  // either opens its panel or, if the same action is already open,
  // closes it.
  type ActionKind = "deposit" | "withdraw" | "borrow" | "repay";
  const [activePanel, setActivePanel] = useState<{ symbol: string; action: ActionKind } | null>(null);
  const togglePanel = (symbol: string, action: ActionKind) =>
    setActivePanel((cur) => (cur && cur.symbol === symbol && cur.action === action ? null : { symbol, action }));
  const closePanel = () => setActivePanel(null);

  const refresh = async () => {
    if (!wallet.publicKey) return;
    setError(null);
    try {
      const ob = await readObligation(connection, wallet.publicKey, selectedMarket);
      setObligation(ob);
      // Discover every reserve in the *selected* market and build the
      // metadata table. For known mints we attach a friendly symbol +
      // the canonical oracle (so prices read live, not from klend's
      // stale cached field). Unknown reserves still render — we just
      // show the mint pubkey and fall back to cached price.
      const discovered = await discoverMarketReserves(connection, KLEND_PROGRAM, selectedMarket);
      const metas: ReserveMeta[] = discovered.map((r) => {
        const known = KNOWN_MINTS[r.liquidityMint.toBase58()];
        return {
          symbol: known?.symbol ?? short(r.liquidityMint),
          reserve: r.reserve,
          oracle: known?.oracle,
          mint: r.liquidityMint,
          tokenProgram: known?.tokenProgram ?? TOKEN_PROGRAM_ID,
          decimals: r.decimals,
        };
      });
      setMarketReserves(metas);
      const map = new Map<string, ReserveView>();
      const fetched = await Promise.all(metas.map((r) => readReserve(connection, r.reserve, r.oracle)));
      for (let i = 0; i < metas.length; i++) {
        const v = fetched[i];
        if (v) map.set(metas[i].reserve.toBase58(), v);
      }
      setReserves(map);
      if (ob.exists) setTargetElevationGroup(ob.elevationGroup);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [wallet.publicKey, connection, selectedMarket]);

  // Aggregate metrics
  const metrics = useMemo(() => {
    if (!obligation || !obligation.exists) {
      return { depositValue: 0, borrowValue: 0, borrowFactorAdjusted: 0, allowed: 0, unhealthy: 0, ltvPct: 0, healthPct: 0, nav: 0 };
    }
    const depositValue = sfToNumber(obligation.depositedValueSf);
    const borrowValue = sfToNumber(obligation.borrowedAssetsMarketValueSf);
    const borrowFactorAdjusted = sfToNumber(obligation.borrowFactorAdjustedDebtValueSf);
    const allowed = sfToNumber(obligation.allowedBorrowValueSf);
    const unhealthy = sfToNumber(obligation.unhealthyBorrowValueSf);
    const ltvPct = depositValue > 0 ? (borrowValue / depositValue) * 100 : 0;
    const healthPct = unhealthy > 0 && borrowFactorAdjusted > 0 ? (unhealthy / borrowFactorAdjusted) * 100 : Infinity;
    return { depositValue, borrowValue, borrowFactorAdjusted, allowed, unhealthy, ltvPct, healthPct, nav: depositValue - borrowValue };
  }, [obligation]);

  // Build a positions table indexed by reserve. A reserve can appear as
  // a deposit row, a borrow row, or both.
  const positions = useMemo(() => {
    const byReserve = new Map<string, { reserve: ReserveMeta; depositCtokens?: bigint; depositValue?: number; borrowAmountSf?: bigint; borrowValue?: number }>();
    for (const r of marketReserves) byReserve.set(r.reserve.toBase58(), { reserve: r });
    if (obligation) {
      for (const d of obligation.deposits) {
        const key = d.reserve.toBase58();
        const e = byReserve.get(key);
        if (!e) continue;
        e.depositCtokens = d.depositedCtokens;
        e.depositValue = sfToNumber(d.marketValueSf);
      }
      for (const b of obligation.borrows) {
        const key = b.reserve.toBase58();
        const e = byReserve.get(key);
        if (!e) continue;
        e.borrowAmountSf = b.borrowedAmountSf;
        e.borrowValue = sfToNumber(b.marketValueSf);
      }
    }
    return Array.from(byReserve.values());
  }, [obligation, marketReserves]);

  // ── action handlers ────────────────────────────────────────────────

  function inputKey(symbol: string, action: string) { return `${symbol}:${action}`; }
  function getAmount(symbol: string, action: string): bigint | null {
    const s = inputs[inputKey(symbol, action)];
    if (!s) {
      setError(`Enter a positive amount in the ${symbol} ${action} input first.`);
      return null;
    }
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) {
      setError(`${symbol} ${action} amount must be a positive number (got "${s}").`);
      return null;
    }
    return BigInt(Math.round(n * LAMPORTS_PER_SOL));
  }

  /** Best-effort error stringifier — `[object Object]` is what
   *  `${e.message ?? e}` produces for structured errors with no
   *  `.message` field (wallet rejections, web3.js
   *  `SendTransactionError`, RPC error envelopes). Walk the common
   *  shapes and concatenate everything we can find. */
  function fmtErr(e: any, label?: string): string {
    if (!e) return "(unknown error)";
    const parts: string[] = [];
    if (label) parts.push(`${label} failed:`);
    if (typeof e === "string") parts.push(e);
    if (e.message) parts.push(String(e.message));
    if (e.transactionMessage && e.transactionMessage !== e.message) parts.push(String(e.transactionMessage));
    if (e.signature) parts.push(`sig=${e.signature}`);
    if (Array.isArray(e.transactionLogs)) parts.push(e.transactionLogs.slice(-12).join("\n"));
    if (Array.isArray(e.logs)) parts.push(e.logs.slice(-12).join("\n"));
    if (e.error) {
      // Wallet adapter style: { error: { message, code } }
      if (e.error.message) parts.push(`wallet: ${e.error.message}`);
      else parts.push(`wallet: ${JSON.stringify(e.error)}`);
    }
    if (parts.length === (label ? 1 : 0)) {
      // Nothing useful extracted — dump the whole thing.
      try { parts.push(JSON.stringify(e, null, 2)); } catch { parts.push(String(e)); }
    }
    return parts.join("\n");
  }

  async function send(ixes: TransactionInstruction[], label: string) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not connected");
    const tx = new Transaction();
    ixes.forEach((ix) => tx.add(ix));
    tx.feePayer = wallet.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    setLog((l) => [...l, `signing ${label} …`]);
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    setLog((l) => [...l, `submitted ${label}: ${sig}`]);
    // Check the confirmation's value.err — this catches on-chain
    // failures quickly without waiting on getTransaction (which can
    // lag on devnet's free RPC).
    const confirmed = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (confirmed.value.err) {
      const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const logs = receipt?.meta?.logMessages?.slice(-12).join("\n") ?? "";
      throw new Error(`${label} on-chain err: ${JSON.stringify(confirmed.value.err)}\nsig=${sig}\n${logs}`);
    }
    setLog((l) => [...l, `✓ confirmed ${label}`]);
  }

  // Helper: if the user has no klend obligation / user_metadata yet
  // (first time using klend on this market), prepend the init ixes.
  // Without these, RefreshObligation fails with 3007
  // AccountOwnedByWrongProgram because the obligation account is
  // still system-owned (zero data).
  async function buildInitIxesIfNeeded(): Promise<TransactionInstruction[]> {
    if (!wallet.publicKey) return [];
    const owner = wallet.publicKey;
    const ob = obligationPda(owner);
    const meta = userMetadataPda(owner);
    const [obInfo, metaInfo] = await connection.getMultipleAccountsInfo([ob, meta], "confirmed");
    const out: TransactionInstruction[] = [];
    if (!metaInfo) out.push(await buildInitUserMetadataIx(owner, owner));
    if (!obInfo) out.push(await buildInitObligationIx(owner, owner));
    return out;
  }

  // Helper: build the standard refresh chain (refresh_reserve for every
  // active deposit/borrow + refresh_reserve(targetReserve) at N-2 +
  // refresh_obligation at N-1) for any klend op against a target reserve.
  async function buildRefreshChain(targetReserve: PublicKey): Promise<TransactionInstruction[]> {
    if (!obligation) throw new Error("obligation not loaded");
    const out: TransactionInstruction[] = [];
    const seen = new Set<string>();
    const allRefs = [
      ...obligation.deposits.map((d) => d.reserve),
      ...obligation.borrows.map((b) => b.reserve),
      targetReserve,
    ];
    for (const r of allRefs) {
      const key = r.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = marketReserves.find((m) => m.reserve.equals(r));
      const oracle = meta?.oracle ?? CSSOL_RESERVE_ORACLE;
      out.push(await buildRefreshReserveIx(r, oracle));
    }
    // Move targetReserve's refresh to N-2 by re-pushing it last
    out.push(await buildRefreshReserveIx(targetReserve, marketReserves.find((m) => m.reserve.equals(targetReserve))?.oracle ?? CSSOL_RESERVE_ORACLE));
    const obligationDepositReserves = [
      ...obligation.deposits.map((d) => d.reserve),
      ...obligation.borrows.map((b) => b.reserve),
    ];
    out.push(await buildRefreshObligationIx(wallet.publicKey!, obligationDepositReserves));
    return out;
  }

  /** SOL → csSOL via Jito vault wrap, NO klend deposit. Mirrors
   *  the original Jito Restaking tab's flow but exposed inline so
   *  institutions can wrap without leaving this view. csSOL ends up
   *  in the user's wallet for free use (e.g. swapping into a leveraged
   *  unwind via flash loan, manually depositing later, transferring,
   *  etc.). */
  async function handleWrapOnly() {
    if (!wallet.publicKey) return;
    const lamports = BigInt(Math.round(Number(wrapAmount) * LAMPORTS_PER_SOL));
    if (lamports <= 0n) { setError("amount must be > 0"); return; }
    setBusy(true); setError(null); setLog([`wrap ${wrapAmount} SOL → csSOL …`]);
    try {
      const owner = wallet.publicKey;
      const state = await readVaultState(connection, CSSOL_VAULT);
      const [jitoConfig] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")], JITO_VAULT_PROGRAM,
      );

      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userVrt = getAssociatedTokenAddressSync(state.vrtMint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userCssol = getAssociatedTokenAddressSync(CSSOL_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const feeVrt = getAssociatedTokenAddressSync(state.vrtMint, state.feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const wrapIx = await buildWrapWithJitoVaultIx({
        user: owner, amount: lamports,
        vrtMint: state.vrtMint, feeWallet: state.feeWallet,
        jitoVaultConfig: jitoConfig, vaultStTokenAccount: CSSOL_VAULT_ST_TOKEN_ACCOUNT,
      });

      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        // Idempotent ATA creates needed by wrap_with_jito_vault
        createAssociatedTokenAccountIdempotentInstruction(owner, userWsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountIdempotentInstruction(owner, userVrt, owner, state.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountIdempotentInstruction(owner, userCssol, owner, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountIdempotentInstruction(owner, feeVrt, state.feeWallet, state.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsol, lamports: Number(lamports) }),
        createSyncNativeInstruction(userWsol),
        wrapIx,
      ];
      await send(ixes, "wrap SOL → csSOL");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleDeposit(meta: ReserveMeta) {
    if (!isActiveMarket) { setError("Switch to the csSOL market to deposit — actions on the eUSX market are not wired."); return; }
    const amount = getAmount(meta.symbol, "deposit");
    if (!amount || !wallet.publicKey) return;
    // eMode 2 makes wSOL the *debt* reserve — depositing it as
    // collateral while in this group fails on-chain with
    // `ElevationGroupDebtReserveAsCollateral` (6105). Catch it early
    // with a clear message instead of letting the user pay base fees
    // for a doomed tx.
    if (meta.symbol === "wSOL" && obligation && obligation.elevationGroup === ELEVATION_GROUP_LST_SOL) {
      setError("Cannot deposit wSOL as collateral while in eMode 2 — wSOL is the debt reserve in this elevation group. Only csSOL or csSOL-WT can be deposited as collateral here. Either request elevation group 0 first, or borrow wSOL instead of depositing it.");
      return;
    }
    setBusy(true); setError(null); setLog([`deposit ${amount} ${meta.symbol} …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(meta.mint, owner, false, meta.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, meta.mint, meta.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
      ];
      if (meta.symbol === "wSOL") {
        // wrap native SOL into the wSOL ATA before deposit
        ixes.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: userAta, lamports: Number(amount) }));
        ixes.push(createSyncNativeInstruction(userAta));
      }
      ixes.push(...await buildRefreshChain(meta.reserve));
      // Use the symbol-specific deposit builder
      if (meta.symbol === "csSOL") {
        ixes.push(await buildDepositCsSolIx(owner, amount));
      } else {
        ixes.push(await buildDepositLiquidityAndCollateralIx({
          user: owner, reserve: meta.reserve,
          liquidityMint: meta.mint, liquidityTokenProgram: meta.tokenProgram,
          userSourceLiquidity: userAta, amount,
        }));
      }
      // For wSOL deposit: close the wSOL ATA at the end. Any leftover
      // wSOL + the ATA rent come back as native SOL — net effect is
      // exactly `amount` lamports moved from the user's native wallet
      // into the reserve, no stranded ATA.
      if (meta.symbol === "wSOL") {
        ixes.push(createCloseAccountInstruction(userAta, owner, owner, [], TOKEN_PROGRAM_ID));
      }
      await send(ixes, `deposit ${meta.symbol}`);
      closePanel();
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleBorrow(meta: ReserveMeta) {
    if (!isActiveMarket) { setError("Switch to the csSOL market to borrow."); return; }
    const amount = getAmount(meta.symbol, "borrow");
    if (!amount || !wallet.publicKey) return;
    setBusy(true); setError(null); setLog([`borrow ${amount} ${meta.symbol} …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(meta.mint, owner, false, meta.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, meta.mint, meta.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
      ];
      ixes.push(...await buildRefreshChain(meta.reserve));
      ixes.push(await buildBorrowObligationLiquidityIx({
        user: owner, borrowReserve: meta.reserve,
        liquidityMint: meta.mint, liquidityTokenProgram: meta.tokenProgram,
        userDestinationLiquidity: userAta, amount,
      }));
      // For wSOL: close the ATA so the borrowed amount + any prior wSOL
      // + the ATA rent all flow back to the user as native SOL.
      if (meta.symbol === "wSOL") {
        ixes.push(createCloseAccountInstruction(userAta, owner, owner, [], TOKEN_PROGRAM_ID));
      }
      await send(ixes, `borrow ${meta.symbol}`);
      closePanel();
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleRepay(meta: ReserveMeta) {
    if (!isActiveMarket) { setError("Switch to the csSOL market to repay."); return; }
    const amount = getAmount(meta.symbol, "repay");
    if (!amount || !wallet.publicKey) return;
    setBusy(true); setError(null); setLog([`repay ${amount} ${meta.symbol} …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(meta.mint, owner, false, meta.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, meta.mint, meta.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
      ];
      if (meta.symbol === "wSOL") {
        // wrap native SOL into wSOL ATA before repay
        ixes.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: userAta, lamports: Number(amount) }));
        ixes.push(createSyncNativeInstruction(userAta));
      }
      ixes.push(...await buildRefreshChain(meta.reserve));
      ixes.push(await buildRepayObligationLiquidityIx({
        user: owner, repayReserve: meta.reserve,
        liquidityMint: meta.mint, liquidityTokenProgram: meta.tokenProgram,
        userSourceLiquidity: userAta, amount,
      }));
      // For wSOL: close the ATA at the end so any leftover wSOL + the
      // ATA rent come back as native SOL.
      if (meta.symbol === "wSOL") {
        ixes.push(createCloseAccountInstruction(userAta, owner, owner, [], TOKEN_PROGRAM_ID));
      }
      await send(ixes, `repay ${meta.symbol}`);
      closePanel();
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleWithdraw(meta: ReserveMeta) {
    if (!isActiveMarket) { setError("Switch to the csSOL market to withdraw."); return; }
    const amount = getAmount(meta.symbol, "withdraw");
    if (!amount || !wallet.publicKey) return;
    setBusy(true); setError(null); setLog([`withdraw ${amount} ${meta.symbol} …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(meta.mint, owner, false, meta.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, meta.mint, meta.tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID),
      ];
      ixes.push(...await buildRefreshChain(meta.reserve));
      // Partial withdraw — the reserve stays in obligation.deposits, so
      // its row still belongs in the refresh_obligation remaining
      // accounts list.
      const remaining = obligation ? obligation.deposits.map((d) => d.reserve) : [];
      ixes.push(await buildWithdrawCollateralAndRedeemIx({
        user: owner, reserve: meta.reserve,
        liquidityMint: meta.mint, liquidityTokenProgram: meta.tokenProgram,
        userDestinationLiquidity: userAta, collateralAmount: amount,
        refreshObligationDeposits: remaining,
      }));
      // For wSOL: close the wsol ATA at the end so the withdrawn amount
      // (plus any pre-existing wSOL and the ATA rent) lands as native
      // SOL in the user's wallet. Institutional users almost always
      // want native SOL post-withdraw.
      if (meta.symbol === "wSOL") {
        ixes.push(createCloseAccountInstruction(userAta, owner, owner, [], TOKEN_PROGRAM_ID));
      }
      await send(ixes, `withdraw ${meta.symbol}`);
      closePanel();
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  /** Switch the obligation's elevation group. Must refresh every
   *  active deposit/borrow reserve in the same tx (klend reads them
   *  to validate the group's collateral/debt invariants). The
   *  `request_elevation_group` ix takes the obligation's deposit and
   *  borrow reserves as remaining_accounts; both must be writable per
   *  the SDK convention. */
  async function handleSetElevationGroup() {
    if (!isActiveMarket) { setError("Switch to the csSOL market to change elevation groups."); return; }
    if (!wallet.publicKey || !obligation) return;
    if (obligation.elevationGroup === targetElevationGroup) {
      setError(`Already in elevation group ${targetElevationGroup}`);
      return;
    }
    setBusy(true); setError(null); setLog([`request elevation group ${targetElevationGroup} …`]);
    try {
      const owner = wallet.publicKey;
      const depositReserves = obligation.deposits.map((d) => d.reserve);
      const borrowReserves = obligation.borrows.map((b) => b.reserve);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
      ];
      // Refresh every involved reserve before the ix (each reserve
      // must be fresh so klend can verify LTV/debt-value under the
      // new group).
      const seen = new Set<string>();
      for (const r of [...depositReserves, ...borrowReserves]) {
        const k = r.toBase58();
        if (seen.has(k)) continue;
        seen.add(k);
        const m = marketReserves.find((mm) => mm.reserve.equals(r));
        ixes.push(await buildRefreshReserveIx(r, m?.oracle ?? CSSOL_RESERVE_ORACLE));
      }
      ixes.push(await buildRefreshObligationIx(owner, [...depositReserves, ...borrowReserves]));
      ixes.push(await buildRequestElevationGroupIx(owner, targetElevationGroup, depositReserves, borrowReserves));
      await send(ixes, `set elevation group ${targetElevationGroup}`);
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  // ── UI ─────────────────────────────────────────────────────────────

  if (!wallet.publicKey) {
    return (
      <section className="max-w-5xl">
        <h2 className="text-2xl font-bold mb-2">Lending position</h2>
        <p className="opacity-70 mb-6">Full klend balance sheet: collateral on the left, debt on the right, with per-row deposit / borrow / repay / withdraw and a flash-loan unwind on the csSOL row.</p>
        <div className="alert alert-warning"><span>Connect a wallet to start.</span></div>
      </section>
    );
  }

  const inEmode2 = obligation?.elevationGroup === ELEVATION_GROUP_LST_SOL;

  return (
    <section className="max-w-6xl space-y-6">
      <header>
        <h2 className="text-2xl font-bold">Lending position — full balance sheet</h2>
        <p className="opacity-70 mt-1 text-sm">
          Reads klend obligation + every reserve's price feed and renders
          the user's position as a balance sheet. Per-row actions:
          <code className="mx-1">deposit</code>,
          <code className="mx-1">borrow</code>,
          <code className="mx-1">repay</code>,
          <code className="mx-1">withdraw</code>; the csSOL row also exposes
          the flash-loan unwind for active leveraged positions.
        </p>
      </header>

      {/* Summary card */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="NAV" value={fmtUsd(metrics.nav)} hint="depositValue − borrowValue" />
        <Stat label="LTV" value={fmt(metrics.ltvPct, 2) + "%"} hint={`borrow $${fmt(metrics.borrowValue, 2)} / deposit $${fmt(metrics.depositValue, 2)}`} />
        <Stat label="health" value={Number.isFinite(metrics.healthPct) ? fmt(metrics.healthPct, 1) + "%" : "∞"} hint="unhealthy / borrowFactorAdjusted" warn={metrics.healthPct < 110} />
        <Stat label="elevation" value={obligation && obligation.exists ? `group ${obligation.elevationGroup}${inEmode2 ? " (csSOL/wSOL eMode)" : ""}` : "n/a"} />
      </div>

      {/* Market switcher — flip between csSOL market (active) and the
          standalone eUSX market (read-only, awaiting unification). */}
      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-2">
          <div className="font-bold">Market <span className="text-xs opacity-60 font-normal">(klend lending market)</span></div>
          <p className="text-xs opacity-70">
            The csSOL market is now unified — deUSX (collateral) and Solstice
            USDC (debt) reserves were migrated in from the standalone eUSX
            market, so a single obligation can hold csSOL/csSOL-WT/deUSX as
            collateral against wSOL or sUSDC debt. The legacy eUSX market is
            kept read-only for wind-down of any pre-migration positions.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              className="select select-bordered select-sm w-full max-w-md"
              value={selectedMarket.toBase58()}
              onChange={(e) => setSelectedMarket(new PublicKey(e.target.value))}
              disabled={busy}
            >
              {MARKETS.map((m) => (
                <option key={m.pubkey.toBase58()} value={m.pubkey.toBase58()}>{m.label}</option>
              ))}
            </select>
            <code className="text-xs opacity-60">{short(selectedMarket)}</code>
          </div>
          {!isActiveMarket ? (
            <div className="alert alert-warning text-xs">
              <span>
                Browsing a non-active market — <strong>actions (deposit / borrow / repay /
                withdraw / elevation switch) are disabled here</strong>. The action
                handlers and obligation builders are wired against the csSOL
                market only. Switch back to the csSOL market to interact.
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {/* Elevation group switcher — request_elevation_group atomically */}
      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-2">
          <div className="font-bold">Elevation group <span className="text-xs opacity-60 font-normal">(klend eMode)</span></div>
          <p className="text-xs opacity-70">
            Group <code>0</code> is the default market (per-reserve LTVs).{" "}
            Group <code>{ELEVATION_GROUP_STABLES}</code> is the Stables eMode
            (90% LTV / 92% liq; deUSX collateral, sUSDC debt).{" "}
            Group <code>{ELEVATION_GROUP_LST_SOL}</code> is the LST/SOL eMode
            (90% LTV / 92% liq; csSOL + csSOL-WT collateral, wSOL debt).
            Switching is allowed only if the current obligation's deposits and
            borrows satisfy the new group's constraints (one collateral asset
            from the group, debt only in the group's debt reserve).
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs opacity-70">current:</span>
            <code className="text-sm">group {obligation?.exists ? obligation.elevationGroup : "—"}</code>
            <span className="opacity-40">→</span>
            <select
              className="select select-bordered select-sm"
              value={targetElevationGroup}
              onChange={(e) => setTargetElevationGroup(Number(e.target.value))}
              disabled={busy}
            >
              {ELEVATION_GROUPS.map((g) => (
                <option key={g.id} value={g.id}>{g.label}</option>
              ))}
            </select>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || !obligation?.exists || obligation.elevationGroup === targetElevationGroup}
              onClick={() => void handleSetElevationGroup()}
            >
              {busy ? <span className="loading loading-spinner loading-xs" /> : null}
              Apply
            </button>
          </div>
        </div>
      </div>

      {/* Plain wrap SOL → csSOL (no klend deposit). Useful for getting csSOL into
          your wallet for later use without committing to lending. */}
      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-2">
          <div className="font-bold">Wrap SOL → csSOL <span className="text-xs opacity-60 font-normal">(no klend deposit, KYC-gated mint)</span></div>
          <p className="text-xs opacity-70">
            Atomic SOL → wSOL → Jito vault MintTo (VRT swept to pool) → csSOL minted to your wallet.
            csSOL ends up free in your wallet for unstake-queue, transfer, or manual klend deposit later.
          </p>
          <div className="flex items-center gap-2">
            <input type="number" step="0.001" min="0" className="input input-bordered input-sm w-32"
              value={wrapAmount} onChange={(e) => setWrapAmount(e.target.value)} disabled={busy} />
            <span className="text-sm opacity-70">SOL</span>
            <button className="btn btn-sm btn-primary" disabled={busy || !wrapAmount} onClick={() => void handleWrapOnly()}>
              {busy ? <span className="loading loading-spinner loading-xs" /> : null}
              Wrap to csSOL
            </button>
          </div>
        </div>
      </div>

      {/* Balance sheet — deposits left, debts right */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* DEPOSITS */}
        <div className="card bg-base-200">
          <div className="card-body p-0">
            <div className="px-4 pt-4 pb-2 flex items-baseline justify-between">
              <span className="font-bold">Collateral (deposits)</span>
              <span className="text-xs opacity-60">{positions.filter((p) => p.depositCtokens).length} active</span>
            </div>
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead className="text-xs opacity-60">
                  <tr>
                    <th>Asset</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">LTV</th>
                    <th className="text-right">Balance</th>
                    <th className="text-right">Value</th>
                    <th className="text-right pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const r = reserves.get(p.reserve.reserve.toBase58());
                    const price = r ? sfToNumber(r.marketPriceSf) : 0;
                    const underlying = p.depositCtokens
                      ? Number(cTokensToUnderlying(p.depositCtokens)) / LAMPORTS_PER_SOL
                      : 0;
                    const ltv = r?.ltvPct ?? 0;
                    const liq = r?.liqThresholdPct ?? 0;
                    const isWsol = p.reserve.symbol === "wSOL";
                    const unit = isWsol ? "SOL" : p.reserve.symbol;
                    const dKey = `${p.reserve.symbol}:deposit`;
                    const wKey = `${p.reserve.symbol}:withdraw`;
                    const dOpen = activePanel?.symbol === p.reserve.symbol && activePanel.action === "deposit";
                    const wOpen = activePanel?.symbol === p.reserve.symbol && activePanel.action === "withdraw";
                    const hasDeposit = !!p.depositCtokens && p.depositCtokens > 0n;
                    return (
                      <Fragment key={p.reserve.symbol}>
                        <tr className={hasDeposit ? "" : "opacity-60"}>
                          <td>
                            <div className="font-bold">{p.reserve.symbol}</div>
                            {isWsol ? <div className="text-[10px] opacity-50">auto-wrap/unwrap SOL</div> : null}
                          </td>
                          <td className="text-right font-mono text-xs">{price > 0 ? fmtUsd(price) : "—"}</td>
                          <td className="text-right font-mono text-xs" title={`liq threshold ${liq}%`}>
                            {ltv > 0 ? `${ltv}%` : <span className="opacity-40">—</span>}
                          </td>
                          <td className="text-right font-mono text-xs">{hasDeposit ? fmt(underlying, 6) : <span className="opacity-40">—</span>}</td>
                          <td className="text-right text-xs opacity-70">{hasDeposit ? fmtUsd(p.depositValue ?? 0) : <span className="opacity-40">—</span>}</td>
                          <td className="text-right pr-4">
                            <div className="join">
                              <button
                                className={`btn btn-xs join-item ${dOpen ? "btn-primary" : ""}`}
                                disabled={busy}
                                onClick={() => togglePanel(p.reserve.symbol, "deposit")}
                              >Deposit</button>
                              <button
                                className={`btn btn-xs join-item ${wOpen ? "btn-primary" : ""}`}
                                disabled={busy || !hasDeposit}
                                onClick={() => togglePanel(p.reserve.symbol, "withdraw")}
                              >Withdraw</button>
                            </div>
                          </td>
                        </tr>
                        {(dOpen || wOpen) ? (
                          <tr className="bg-base-300/40">
                            <td colSpan={6} className="px-4 py-3">
                              <ActionPanel
                                title={dOpen ? `Deposit ${unit}` : `Withdraw ${unit}`}
                                hint={dOpen
                                  ? (isWsol ? "Native SOL is auto-wrapped before the klend deposit." : `Transfers ${unit} from your wallet into the reserve as collateral.`)
                                  : `Withdraws ${unit} collateral and redeems the cTokens for underlying.`}
                                inputKey={dOpen ? dKey : wKey}
                                inputs={inputs} setInputs={setInputs}
                                unitLabel={unit}
                                busy={busy}
                                onConfirm={() => void (dOpen ? handleDeposit(p.reserve) : handleWithdraw(p.reserve))}
                                onCancel={closePanel}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {positions.every((p) => !p.depositCtokens) ? (
              <div className="px-4 pb-3 text-xs opacity-60">No deposits yet. Click <strong>Deposit</strong> on any row to add collateral.</div>
            ) : null}
            {CSSOL_WT_RESERVE ? (
              <div className="px-4 pb-3 pt-1 border-t border-base-300">
                <button
                  className="btn btn-xs btn-secondary w-full"
                  disabled={busy}
                  onClick={() => setError("Flash-unwind lives on the dedicated unwind tab — switch to it and use the leveraged-unwind card.")}
                >⚡ Flash-loan unwind csSOL → csSOL-WT (no SOL needed to repay)</button>
              </div>
            ) : null}
          </div>
        </div>

        {/* BORROWS */}
        <div className="card bg-base-200">
          <div className="card-body p-0">
            <div className="px-4 pt-4 pb-2 flex items-baseline justify-between">
              <span className="font-bold">Debt (borrows)</span>
              <span className="text-xs opacity-60">{positions.filter((p) => p.borrowAmountSf).length} active</span>
            </div>
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead className="text-xs opacity-60">
                  <tr>
                    <th>Asset</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">LTV</th>
                    <th className="text-right">Borrowed</th>
                    <th className="text-right">Value</th>
                    <th className="text-right pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const r = reserves.get(p.reserve.reserve.toBase58());
                    const price = r ? sfToNumber(r.marketPriceSf) : 0;
                    const borrowedUnderlying = p.borrowAmountSf
                      ? sfToNumber(p.borrowAmountSf) / LAMPORTS_PER_SOL
                      : 0;
                    const ltv = r?.ltvPct ?? 0;
                    const liq = r?.liqThresholdPct ?? 0;
                    const isWsol = p.reserve.symbol === "wSOL";
                    const unit = isWsol ? "SOL" : p.reserve.symbol;
                    const bKey = `${p.reserve.symbol}:borrow`;
                    const rKey = `${p.reserve.symbol}:repay`;
                    const bOpen = activePanel?.symbol === p.reserve.symbol && activePanel.action === "borrow";
                    const rOpen = activePanel?.symbol === p.reserve.symbol && activePanel.action === "repay";
                    const hasDebt = !!p.borrowAmountSf && p.borrowAmountSf > 0n;
                    return (
                      <Fragment key={p.reserve.symbol}>
                        <tr className={hasDebt ? "" : "opacity-60"}>
                          <td>
                            <div className="font-bold">{p.reserve.symbol}</div>
                            {isWsol ? <div className="text-[10px] opacity-50">auto-wrap/unwrap SOL</div> : null}
                          </td>
                          <td className="text-right font-mono text-xs">{price > 0 ? fmtUsd(price) : "—"}</td>
                          <td className="text-right font-mono text-xs" title={`liq threshold ${liq}%`}>
                            {ltv > 0 ? `${ltv}%` : <span className="opacity-40">—</span>}
                          </td>
                          <td className="text-right font-mono text-xs">{hasDebt ? fmt(borrowedUnderlying, 6) : <span className="opacity-40">—</span>}</td>
                          <td className="text-right text-xs opacity-70">{hasDebt ? fmtUsd(p.borrowValue ?? 0) : <span className="opacity-40">—</span>}</td>
                          <td className="text-right pr-4">
                            <div className="join">
                              <button
                                className={`btn btn-xs join-item ${bOpen ? "btn-primary" : ""}`}
                                disabled={busy}
                                onClick={() => togglePanel(p.reserve.symbol, "borrow")}
                              >Borrow</button>
                              <button
                                className={`btn btn-xs join-item ${rOpen ? "btn-primary" : ""}`}
                                disabled={busy || !hasDebt}
                                onClick={() => togglePanel(p.reserve.symbol, "repay")}
                              >Repay</button>
                            </div>
                          </td>
                        </tr>
                        {(bOpen || rOpen) ? (
                          <tr className="bg-base-300/40">
                            <td colSpan={6} className="px-4 py-3">
                              <ActionPanel
                                title={bOpen ? `Borrow ${unit}` : `Repay ${unit}`}
                                hint={bOpen
                                  ? `Borrows ${unit} against your collateral. Subject to the reserve's LTV cap and the obligation's elevation group.`
                                  : (isWsol ? "Native SOL is auto-wrapped before repayment; any leftover wSOL + ATA rent return as native." : `Repays ${unit} debt from your wallet.`)}
                                inputKey={bOpen ? bKey : rKey}
                                inputs={inputs} setInputs={setInputs}
                                unitLabel={unit}
                                busy={busy}
                                onConfirm={() => void (bOpen ? handleBorrow(p.reserve) : handleRepay(p.reserve))}
                                onCancel={closePanel}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {positions.every((p) => !p.borrowAmountSf) ? (
              <div className="px-4 pb-3 text-xs opacity-60">No outstanding debt.</div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Single transaction console — the live log of the tx in flight
          plus any error from the last attempt, kept in one place below
          the balance sheet (instead of scattered alerts at the top and
          a pre block at the bottom). */}
      <TxConsole busy={busy} log={log} error={error} onClear={() => { setLog([]); setError(null); }} />

      <div className="flex items-center gap-3 text-xs opacity-60">
        <span>obligation: <code>{obligation && obligation.exists ? short(obligation.obligationAddr) : "(not initialized)"}</code></span>
        <button className="btn btn-ghost btn-xs" onClick={() => void refresh()} disabled={busy}>Refresh</button>
      </div>
    </section>
  );
}

/** Single transaction console below the balance sheet: progress lines
 *  from the in-flight tx + the last error, side-by-side. Replaces the
 *  scattered top-of-page alert + bottom-of-page <pre>. Shows nothing
 *  until the user takes an action. */
function TxConsole({ busy, log, error, onClear }: {
  busy: boolean;
  log: string[];
  error: string | null;
  onClear: () => void;
}) {
  if (!busy && log.length === 0 && !error) return null;
  return (
    <div className="card bg-base-200">
      <div className="card-body p-3 gap-2">
        <div className="flex items-center justify-between">
          <div className="font-bold text-sm flex items-center gap-2">
            {busy ? <span className="loading loading-spinner loading-xs" /> : null}
            Transaction console
            {error ? <span className="badge badge-error badge-sm">error</span> : busy ? <span className="badge badge-info badge-sm">running</span> : log.length > 0 ? <span className="badge badge-success badge-sm">done</span> : null}
          </div>
          <button className="btn btn-ghost btn-xs" disabled={busy} onClick={onClear}>Clear</button>
        </div>
        {log.length > 0 ? (
          <pre className="bg-base-300 rounded p-2 text-[11px] whitespace-pre-wrap font-mono max-h-40 overflow-auto">{log.join("\n")}</pre>
        ) : null}
        {error ? (
          <pre className="alert alert-error text-[11px] whitespace-pre-wrap p-2 rounded max-h-64 overflow-auto">{error}</pre>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className="card bg-base-200">
      <div className="card-body p-3">
        <div className="text-xs opacity-60">{label}</div>
        <div className={`text-lg font-bold ${warn ? "text-warning" : ""}`}>{value}</div>
        {hint ? <div className="text-xs opacity-50">{hint}</div> : null}
      </div>
    </div>
  );
}

/** Inline-expanded action input for a single row. Shown when the user
 *  clicks Deposit / Withdraw / Borrow / Repay; hidden by default. The
 *  amount string lives in the parent's `inputs` map so it survives
 *  panel toggles (without losing what the user typed if they
 *  accidentally close + reopen). */
function ActionPanel({
  title, hint, inputKey, inputs, setInputs, unitLabel, busy, onConfirm, onCancel,
}: {
  title: string;
  hint?: string;
  inputKey: string;
  inputs: Record<string, string>;
  setInputs: (s: Record<string, string>) => void;
  unitLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const value = inputs[inputKey] ?? "";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <div className="font-bold text-sm">{title}</div>
        {hint ? <div className="text-[11px] opacity-60 max-w-md text-right">{hint}</div> : null}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="number" step="0.001" min="0" placeholder="0.00"
          className="input input-bordered input-sm w-40 font-mono"
          value={value}
          onChange={(e) => setInputs({ ...inputs, [inputKey]: e.target.value })}
          disabled={busy}
          autoFocus
        />
        <span className="text-xs opacity-60">{unitLabel}</span>
        <div className="flex-1" />
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm btn-primary" disabled={busy || !value} onClick={onConfirm}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : null}
          Confirm
        </button>
      </div>
    </div>
  );
}
