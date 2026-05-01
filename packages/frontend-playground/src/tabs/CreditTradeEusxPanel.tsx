import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CEUSX_MINT,
  CEUSX_RESERVE,
  CEUSX_RESERVE_ORACLE,
  ELEVATION_GROUP_STABLES,
  SUSDC_MINT,
  SUSDC_RESERVE,
  SUSDC_RESERVE_ORACLE,
} from "../lib/addresses";
import {
  buildBorrowObligationLiquidityIx,
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
import { readObligation, readReserve, sfToNumber } from "../lib/obligationView";

type Action = "deposit" | "borrow" | "repay" | "withdraw" | null;

const SUSDC_DECIMALS = 6;
const CEUSX_DECIMALS = 6;

function fmt(n: number, dp = 6): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(dp);
}
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtErr(e: any): string {
  if (!e) return "unknown error";
  if (typeof e === "string") return e;
  return e?.message ?? JSON.stringify(e);
}

export default function CreditTradeEusxPanel() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Reserves
  const [ceusxPrice, setCeusxPrice] = useState(0);
  const [susdcPrice, setSusdcPrice] = useState(0);
  const [susdcAvailable, setSusdcAvailable] = useState(0);

  // Wallet balances
  const [ceusxBal, setCeusxBal] = useState(0);
  const [susdcBal, setSusdcBal] = useState(0);

  // Obligation
  const [ceusxCollateral, setCeusxCollateral] = useState(0);
  const [susdcDebt, setSusdcDebt] = useState(0);
  const [elevationGroup, setElevationGroup] = useState(0);
  const [obligationExists, setObligationExists] = useState(false);
  const [userMetaExists, setUserMetaExists] = useState(false);

  // Action panel
  const [action, setAction] = useState<Action>(null);
  const [amountStr, setAmountStr] = useState("");

  async function refresh() {
    if (!wallet.publicKey) return;
    setError(null);
    try {
      const owner = wallet.publicKey;
      const [ceusxRes, susdcRes, obligation] = await Promise.all([
        readReserve(connection, CEUSX_RESERVE, CEUSX_RESERVE_ORACLE),
        readReserve(connection, SUSDC_RESERVE, SUSDC_RESERVE_ORACLE),
        readObligation(connection, owner),
      ]);
      if (ceusxRes) setCeusxPrice(sfToNumber(ceusxRes.marketPriceSf));
      if (susdcRes) {
        setSusdcPrice(sfToNumber(susdcRes.marketPriceSf));
        setSusdcAvailable(Number(susdcRes.availableAmount) / 10 ** SUSDC_DECIMALS);
      }

      // Obligation deposits/borrows for ceUSX & sUSDC. depositedCtokens are
      // cTokens; we approximate the underlying via the reserve's marketValueSf
      // (USD) divided by its price — same approach the credit-trade tab uses.
      const dep = obligation.deposits.find((d) => d.reserve.equals(CEUSX_RESERVE));
      const bor = obligation.borrows.find((b) => b.reserve.equals(SUSDC_RESERVE));
      const ceusxPx = ceusxRes ? sfToNumber(ceusxRes.marketPriceSf) : 0;
      const susdcPx = susdcRes ? sfToNumber(susdcRes.marketPriceSf) : 1;
      setCeusxCollateral(dep && ceusxPx > 0 ? sfToNumber(dep.marketValueSf) / ceusxPx : 0);
      setSusdcDebt(bor && susdcPx > 0 ? sfToNumber(bor.marketValueSf) / susdcPx : 0);
      setElevationGroup(obligation.elevationGroup);
      setObligationExists(obligation.exists);

      // Wallet balances
      const ceusxAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const susdcAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const [ceusxBalRaw, susdcBalRaw] = await Promise.all([
        connection.getTokenAccountBalance(ceusxAta).then((b) => b.value.uiAmount ?? 0).catch(() => 0),
        connection.getTokenAccountBalance(susdcAta).then((b) => b.value.uiAmount ?? 0).catch(() => 0),
      ]);
      setCeusxBal(ceusxBalRaw);
      setSusdcBal(susdcBalRaw);

      // user_metadata existence — needed because the first deposit also
      // creates the obligation, but klend requires user_metadata to exist
      // before the obligation init.
      const metaInfo = await connection.getAccountInfo(userMetadataPda(owner), "confirmed");
      setUserMetaExists(!!metaInfo);
    } catch (e: any) {
      setError(fmtErr(e));
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [wallet.publicKey?.toBase58()]);

  async function buildInitIxesIfNeeded(): Promise<TransactionInstruction[]> {
    if (!wallet.publicKey) return [];
    const out: TransactionInstruction[] = [];
    if (!userMetaExists) out.push(await buildInitUserMetadataIx(wallet.publicKey, wallet.publicKey));
    if (!obligationExists) out.push(await buildInitObligationIx(wallet.publicKey, wallet.publicKey));
    return out;
  }

  /** Standard refresh chain: refresh every active reserve, plus the
   *  target reserve last (klend's `check_refresh` requires the action's
   *  target reserve at N-2 of the action ix), then refresh_obligation.
   *  Identical shape to LendingPositionTab.buildRefreshChain. */
  async function buildRefreshChain(targetReserve: PublicKey): Promise<TransactionInstruction[]> {
    const owner = wallet.publicKey!;
    const obligation = await readObligation(connection, owner);
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
      const oracle = r.equals(CEUSX_RESERVE) ? CEUSX_RESERVE_ORACLE : SUSDC_RESERVE_ORACLE;
      out.push(await buildRefreshReserveIx(r, oracle));
    }
    // Move targetReserve's refresh to N-2 by re-pushing it last
    const oracle = targetReserve.equals(CEUSX_RESERVE) ? CEUSX_RESERVE_ORACLE : SUSDC_RESERVE_ORACLE;
    out.push(await buildRefreshReserveIx(targetReserve, oracle));
    out.push(await buildRefreshObligationIx(owner, [
      ...obligation.deposits.map((d) => d.reserve),
      ...obligation.borrows.map((b) => b.reserve),
    ]));
    return out;
  }

  async function send(ixes: TransactionInstruction[], label: string) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not ready");
    const owner = wallet.publicKey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixes }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    setLog((l) => [...l, `${label}: signing…`]);
    const signed = await wallet.signTransaction(vtx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    setLog((l) => [...l, `${label}: sent ${sig.slice(0, 20)}…`]);
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`${label} failed: ${JSON.stringify(conf.value.err)}`);
    setLog((l) => [...l, `${label}: confirmed`]);
  }

  function getLamports(decimals: number): bigint {
    const n = Number(amountStr);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.floor(n * 10 ** decimals));
  }

  async function handleDeposit() {
    if (!wallet.publicKey) return;
    const amount = getLamports(CEUSX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(ceusxBal * 10 ** CEUSX_DECIMALS)) < amount) {
      setError(`Insufficient ceUSX: have ${ceusxBal}, need ${amountStr}. Mint USX → ceUSX via the institutional portal first.`);
      return;
    }
    setBusy(true); setError(null); setLog([`deposit ${amountStr} ceUSX …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, CEUSX_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...await buildRefreshChain(CEUSX_RESERVE),
      ];
      ixes.push(await buildDepositLiquidityAndCollateralIx({
        user: owner, reserve: CEUSX_RESERVE,
        liquidityMint: CEUSX_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
        userSourceLiquidity: userAta, amount,
      }));
      await send(ixes, "deposit ceUSX");
      setAction(null);
      setAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleBorrow() {
    if (!wallet.publicKey) return;
    const amount = getLamports(SUSDC_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (Number(amount) > susdcAvailable * 10 ** SUSDC_DECIMALS) {
      setError(`Reserve only has ${susdcAvailable.toFixed(2)} sUSDC available.`);
      return;
    }
    setBusy(true); setError(null); setLog([`borrow ${amountStr} sUSDC …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const obligation = await readObligation(connection, owner);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, SUSDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      ];
      // Auto-enter EG-1 (stables) if the obligation has only ceUSX
      // collateral and isn't already in the group. Without EG-1 the
      // ceUSX/sUSDC pair sits at the base LTV (much lower than 90%);
      // entering the group is the whole point of leveraging here.
      const onlyCeusxCollateral =
        obligation.deposits.length === 0 ||
        obligation.deposits.every((d) => d.reserve.equals(CEUSX_RESERVE));
      const noBorrowsYet = obligation.borrows.length === 0;
      if (obligation.elevationGroup !== ELEVATION_GROUP_STABLES && onlyCeusxCollateral && noBorrowsYet) {
        // Refresh + obligation refresh + request_elevation_group + obligation refresh again
        // before the borrow's refresh chain. klend validates LTV under the new group.
        ixes.push(await buildRefreshReserveIx(CEUSX_RESERVE, CEUSX_RESERVE_ORACLE));
        ixes.push(await buildRefreshReserveIx(SUSDC_RESERVE, SUSDC_RESERVE_ORACLE));
        ixes.push(await buildRefreshObligationIx(owner, obligation.deposits.map((d) => d.reserve)));
        ixes.push(await buildRequestElevationGroupIx(
          owner,
          ELEVATION_GROUP_STABLES,
          obligation.deposits.map((d) => d.reserve),
          [], // no borrows yet
        ));
      }
      ixes.push(...await buildRefreshChain(SUSDC_RESERVE));
      ixes.push(await buildBorrowObligationLiquidityIx({
        user: owner, borrowReserve: SUSDC_RESERVE,
        liquidityMint: SUSDC_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
        userDestinationLiquidity: userAta, amount,
        obligationDepositReserves: obligation.deposits.map((d) => d.reserve),
      }));
      await send(ixes, "borrow sUSDC");
      setAction(null);
      setAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleRepay() {
    if (!wallet.publicKey) return;
    const amount = getLamports(SUSDC_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    if (BigInt(Math.floor(susdcBal * 10 ** SUSDC_DECIMALS)) < amount) {
      setError(`Insufficient sUSDC: have ${susdcBal}, need ${amountStr}.`);
      return;
    }
    setBusy(true); setError(null); setLog([`repay ${amountStr} sUSDC …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(SUSDC_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, SUSDC_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...await buildRefreshChain(SUSDC_RESERVE),
      ];
      ixes.push(await buildRepayObligationLiquidityIx({
        user: owner, repayReserve: SUSDC_RESERVE,
        liquidityMint: SUSDC_MINT, liquidityTokenProgram: TOKEN_PROGRAM_ID,
        userSourceLiquidity: userAta, amount,
      }));
      await send(ixes, "repay sUSDC");
      setAction(null);
      setAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  async function handleWithdraw() {
    if (!wallet.publicKey) return;
    const amount = getLamports(CEUSX_DECIMALS);
    if (amount <= 0n) { setError("Amount must be > 0"); return; }
    setBusy(true); setError(null); setLog([`withdraw ${amountStr} ceUSX …`]);
    try {
      const owner = wallet.publicKey;
      const userAta = getAssociatedTokenAddressSync(CEUSX_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const obligation = await readObligation(connection, owner);
      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...await buildInitIxesIfNeeded(),
        createAssociatedTokenAccountIdempotentInstruction(owner, userAta, owner, CEUSX_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
        ...await buildRefreshChain(CEUSX_RESERVE),
      ];
      ixes.push(await buildWithdrawCollateralAndRedeemIx({
        user: owner, reserve: CEUSX_RESERVE,
        liquidityMint: CEUSX_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
        userDestinationLiquidity: userAta, collateralAmount: amount,
        refreshObligationDeposits: obligation.deposits.map((d) => d.reserve),
      }));
      await send(ixes, "withdraw ceUSX");
      setAction(null);
      setAmountStr("");
      await refresh();
    } catch (e: any) { setError(fmtErr(e)); } finally { setBusy(false); }
  }

  // ── UI ──

  if (!wallet.publicKey) {
    return <div className="alert alert-warning"><span>Connect a wallet to start.</span></div>;
  }

  const collateralUsd = ceusxCollateral * ceusxPrice;
  const debtUsd = susdcDebt * susdcPrice;
  const equityUsd = collateralUsd - debtUsd;
  const ltvPct = collateralUsd > 0 ? (debtUsd / collateralUsd) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Constraint banner — explain why this is manual, not 1-tx */}
      <div className="alert alert-warning">
        <div className="text-xs">
          <div className="font-bold mb-1">Manual deposit + borrow flow</div>
          <div>
            The atomic flash-loan loop available for csSOL/wSOL is not possible
            here — Solstice's USX program gates <code>RequestMint</code> /
            <code>RequestRedeem</code> behind their operator multisig, so
            sUSDC↔USX cannot be CPI'd from a user-signed tx. To leverage:
            mint USX → ceUSX once via the institutional portal, then loop
            <code className="mx-1">deposit</code>→
            <code className="mx-1">borrow</code>→ off-app convert →
            <code className="mx-1">deposit</code> as many times as you want
            here.
          </div>
        </div>
      </div>

      {/* Pool liquidity card */}
      <div className="card bg-base-200">
        <div className="card-body p-4">
          <div className="flex items-baseline justify-between">
            <span className="font-bold text-sm">Pool liquidity (sUSDC)</span>
            <span className="text-[11px] opacity-60">single ix borrow capacity</span>
          </div>
          <div className="grid grid-cols-3 gap-3 mt-2 text-sm">
            <div>
              <div className="opacity-60 text-[11px]">Available sUSDC</div>
              <div className="font-mono">{fmt(susdcAvailable, 2)}</div>
              <div className="text-[10px] opacity-50">{fmtUsd(susdcAvailable * susdcPrice)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">ceUSX price</div>
              <div className="font-mono">{fmtUsd(ceusxPrice)}</div>
            </div>
            <div>
              <div className="opacity-60 text-[11px]">sUSDC price</div>
              <div className="font-mono">{fmtUsd(susdcPrice)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Position card */}
      <div className="card bg-base-200">
        <div className="card-body p-4">
          <div className="flex items-baseline justify-between mb-2">
            <span className="font-bold text-sm">Position</span>
            <span className="text-[11px] opacity-60">
              eMode group {elevationGroup} {elevationGroup === ELEVATION_GROUP_STABLES ? "(Stables, 90% LTV)" : "(base LTV)"}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="opacity-60 text-xs">Collateral (ceUSX)</div>
              <div className="font-mono">{fmt(ceusxCollateral, 4)}</div>
              <div className="text-xs opacity-50">{fmtUsd(collateralUsd)}</div>
            </div>
            <div>
              <div className="opacity-60 text-xs">Debt (sUSDC)</div>
              <div className="font-mono">{fmt(susdcDebt, 4)}</div>
              <div className="text-xs opacity-50">{fmtUsd(debtUsd)}</div>
            </div>
            <div>
              <div className="opacity-60 text-xs">Equity</div>
              <div className="font-mono">{fmtUsd(equityUsd)}</div>
            </div>
            <div>
              <div className="opacity-60 text-xs">Current LTV</div>
              <div className="font-mono">{ltvPct.toFixed(2)}%</div>
            </div>
          </div>
        </div>
      </div>

      {/* Wallet balances + action picker */}
      <div className="card bg-base-200">
        <div className="card-body p-4">
          <div className="flex items-baseline justify-between mb-3">
            <span className="font-bold text-sm">Wallet</span>
            <span className="text-[11px] opacity-60">connected: {wallet.publicKey.toBase58().slice(0, 8)}…</span>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm mb-4">
            <div>
              <div className="opacity-60 text-xs">ceUSX balance</div>
              <div className="font-mono">{fmt(ceusxBal, 4)}</div>
            </div>
            <div>
              <div className="opacity-60 text-xs">sUSDC balance</div>
              <div className="font-mono">{fmt(susdcBal, 4)}</div>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              className={`btn btn-sm ${action === "deposit" ? "btn-primary" : "btn-outline"}`}
              disabled={busy}
              onClick={() => { setAction(action === "deposit" ? null : "deposit"); setAmountStr(""); setError(null); }}
            >
              Deposit ceUSX
            </button>
            <button
              className={`btn btn-sm ${action === "borrow" ? "btn-primary" : "btn-outline"}`}
              disabled={busy || ceusxCollateral <= 0}
              onClick={() => { setAction(action === "borrow" ? null : "borrow"); setAmountStr(""); setError(null); }}
            >
              Borrow sUSDC
            </button>
            <button
              className={`btn btn-sm ${action === "repay" ? "btn-primary" : "btn-outline"}`}
              disabled={busy || susdcDebt <= 0}
              onClick={() => { setAction(action === "repay" ? null : "repay"); setAmountStr(""); setError(null); }}
            >
              Repay sUSDC
            </button>
            <button
              className={`btn btn-sm ${action === "withdraw" ? "btn-primary" : "btn-outline"}`}
              disabled={busy || ceusxCollateral <= 0}
              onClick={() => { setAction(action === "withdraw" ? null : "withdraw"); setAmountStr(""); setError(null); }}
            >
              Withdraw ceUSX
            </button>
          </div>

          {action ? (
            <div className="mt-4 p-3 bg-base-300/50 rounded">
              <div className="text-xs opacity-70 mb-2">
                {action === "deposit" && "Move ceUSX from your wallet into klend collateral. First borrow auto-enters Stables eMode (90% LTV)."}
                {action === "borrow" && "Borrow sUSDC against your ceUSX collateral. If not in Stables eMode yet, this tx will request it before the borrow."}
                {action === "repay" && "Pull sUSDC from your wallet to pay down the obligation's debt."}
                {action === "withdraw" && "Pull ceUSX out of klend back to your wallet. Subject to LTV constraints if you have outstanding debt."}
              </div>
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="text-xs opacity-60 block mb-1">Amount</label>
                  <input
                    type="number" step="any" min="0"
                    className="input input-sm input-bordered w-full"
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value)}
                    disabled={busy}
                  />
                </div>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busy || !amountStr || Number(amountStr) <= 0}
                  onClick={() => {
                    if (action === "deposit") void handleDeposit();
                    else if (action === "borrow") void handleBorrow();
                    else if (action === "repay") void handleRepay();
                    else if (action === "withdraw") void handleWithdraw();
                  }}
                >
                  {busy ? <span className="loading loading-spinner loading-xs" /> : null}
                  {action === "deposit" && "Deposit"}
                  {action === "borrow" && "Borrow"}
                  {action === "repay" && "Repay"}
                  {action === "withdraw" && "Withdraw"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Tx console */}
      {(log.length > 0 || error) ? (
        <div className="card bg-base-300/60">
          <div className="card-body p-4">
            <div className="font-bold text-sm mb-2">Transaction console</div>
            {error ? (
              <div className="alert alert-error text-xs mb-2">
                <pre className="whitespace-pre-wrap break-all">{error}</pre>
              </div>
            ) : null}
            <pre className="text-xs whitespace-pre-wrap break-all opacity-70">
              {log.join("\n")}
            </pre>
          </div>
        </div>
      ) : null}

      <div className="text-[11px] opacity-50">
        Reserves — ceUSX: {CEUSX_RESERVE.toBase58().slice(0, 8)}… · sUSDC:{" "}
        {SUSDC_RESERVE.toBase58().slice(0, 8)}… · obligation:{" "}
        {obligationPda(wallet.publicKey).toBase58().slice(0, 8)}…
      </div>
    </div>
  );
}
