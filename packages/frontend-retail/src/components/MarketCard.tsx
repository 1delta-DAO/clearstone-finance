import { useMemo } from "react";
import { fixedYield } from "@delta/calldata-sdk-solana";
import type { FixedYieldMarket } from "../hooks/useFixedYieldMarkets";

interface Props {
  market: FixedYieldMarket;
  onDeposit: (m: FixedYieldMarket) => void;
}

export function MarketCard({ market, onDeposit }: Props) {
  const nowTs = Math.floor(Date.now() / 1000);
  const quote = useMemo(
    () =>
      fixedYield.quote.quoteFixedApy({
        ptPrice: market.ptPrice,
        maturityTs: market.maturityTs,
        nowTs,
        syExchangeRate: market.syExchangeRate,
      }),
    [market.ptPrice, market.maturityTs, market.syExchangeRate, nowTs]
  );

  const maturityDate = new Date(market.maturityTs * 1000);
  const daysToMaturity = Math.max(
    0,
    Math.round(quote.timeToMaturity / 86400)
  );

  return (
    <div className="card bg-base-200 border border-base-300 shadow-sm">
      <div className="card-body p-5">
        <div className="flex items-center justify-between">
          <h3 className="card-title text-base">{market.label}</h3>
          {market.kycGated ? (
            <span className="badge badge-sm badge-warning">KYC</span>
          ) : (
            <span className="badge badge-sm badge-ghost">Open</span>
          )}
        </div>

        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-3xl font-mono font-semibold text-success">
            {(quote.apy * 100).toFixed(2)}%
          </span>
          <span className="text-xs opacity-70">fixed APY</span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-xs opacity-80">
          <div>
            <div className="opacity-60">Matures</div>
            <div className="font-mono">
              {maturityDate.toLocaleDateString()}
            </div>
          </div>
          <div>
            <div className="opacity-60">Term</div>
            <div className="font-mono">{daysToMaturity}d</div>
          </div>
          <div>
            <div className="opacity-60">PT price</div>
            <div className="font-mono">{market.ptPrice.toFixed(4)}</div>
          </div>
          <div>
            <div className="opacity-60">Payoff</div>
            <div className="font-mono">
              {quote.payoffRatio.toFixed(4)}×
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onDeposit(market)}
          className="btn btn-primary btn-sm mt-4"
        >
          Deposit {market.baseSymbol}
        </button>
      </div>
    </div>
  );
}
