import { useMemo, useState } from "react";
import { fixedYield } from "@delta/calldata-sdk-solana";
import BN from "bn.js";
import type { FixedYieldMarket } from "../hooks/useFixedYieldMarkets";

interface Props {
  market: FixedYieldMarket | null;
  onClose: () => void;
  /** Caller implements wallet signing + RPC dispatch. */
  onSubmit: (args: { market: FixedYieldMarket; amountBase: BN }) => void;
  submitting?: boolean;
}

/**
 * Deposit-into-PT modal. Computes the expected payoff at maturity from
 * the market snapshot and hands off a BN-denominated amount to the
 * caller. Tx construction happens one layer up (so this component stays
 * agnostic to wallet-adapter plumbing).
 */
export function DepositPtModal({
  market,
  onClose,
  onSubmit,
  submitting,
}: Props) {
  const [amountStr, setAmountStr] = useState("");

  const amountBase = useMemo<BN | null>(() => {
    if (!market) return null;
    const n = Number.parseFloat(amountStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    const units = BigInt(
      Math.round(n * Math.pow(10, market.baseDecimals))
    );
    return new BN(units.toString());
  }, [amountStr, market]);

  const nowTs = Math.floor(Date.now() / 1000);
  const quote = useMemo(() => {
    if (!market || !amountBase) return null;
    return fixedYield.quote.quoteTermDeposit(
      {
        ptPrice: market.ptPrice,
        maturityTs: market.maturityTs,
        nowTs,
        syExchangeRate: market.syExchangeRate,
      },
      amountBase
    );
  }, [market, amountBase, nowTs]);

  const payoutHuman = useMemo(() => {
    if (!market || !quote) return null;
    const outNum =
      Number(quote.amountBaseOutAtMaturity.toString()) /
      Math.pow(10, market.baseDecimals);
    return outNum.toLocaleString(undefined, {
      maximumFractionDigits: 4,
    });
  }, [market, quote]);

  if (!market) return null;

  const maturityDate = new Date(market.maturityTs * 1000);

  return (
    <div className="modal modal-open" role="dialog">
      <div className="modal-box max-w-md">
        <h3 className="font-bold text-lg">Deposit into {market.label}</h3>
        <p className="text-sm opacity-70 mt-1">
          Lock a fixed rate until {maturityDate.toLocaleDateString()}. Exit
          early at the prevailing PT price on the AMM.
        </p>

        <label className="form-control mt-4">
          <div className="label">
            <span className="label-text">Amount ({market.baseSymbol})</span>
          </div>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0.00"
            className="input input-bordered font-mono"
          />
        </label>

        <div className="mt-4 rounded-lg bg-base-200 p-3 text-sm">
          <div className="flex justify-between">
            <span className="opacity-70">Fixed APY</span>
            <span className="font-mono text-success">
              {quote ? (quote.apy * 100).toFixed(2) + "%" : "—"}
            </span>
          </div>
          <div className="flex justify-between mt-1">
            <span className="opacity-70">At maturity</span>
            <span className="font-mono">
              {payoutHuman ?? "—"} {market.baseSymbol}
            </span>
          </div>
          <div className="flex justify-between mt-1">
            <span className="opacity-70">Maturity date</span>
            <span className="font-mono">
              {maturityDate.toLocaleDateString()}
            </span>
          </div>
        </div>

        <div className="modal-action">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!amountBase || submitting}
            onClick={() =>
              amountBase && onSubmit({ market, amountBase })
            }
          >
            {submitting ? "Submitting…" : "Deposit"}
          </button>
        </div>
      </div>
      <div
        className="modal-backdrop"
        role="button"
        tabIndex={0}
        onClick={submitting ? undefined : onClose}
        onKeyDown={(e) =>
          (e.key === "Escape" || e.key === "Enter") &&
          !submitting &&
          onClose()
        }
      />
    </div>
  );
}
