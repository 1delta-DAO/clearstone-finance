import { useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

const SOLSTICE_TOKENS = [
  { symbol: "USDC", mint: "8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g", price: 1.0, color: "text-info" },
  { symbol: "USDT", mint: "5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft", price: 1.0, color: "text-success" },
  { symbol: "USX", mint: "7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS", price: 1.0, color: "text-primary" },
  { symbol: "eUSX", mint: "Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt", price: 1.08, color: "text-warning", yield: true },
];

export default function Dashboard() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [solBalance, setSolBalance] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!publicKey) return;
    setLoading(true);

    async function load() {
      const sol = await connection.getBalance(publicKey!);
      setSolBalance(sol / 1e9);

      const bals: Record<string, number> = {};
      for (const token of SOLSTICE_TOKENS) {
        try {
          const ata = getAssociatedTokenAddressSync(new PublicKey(token.mint), publicKey!, false, TOKEN_PROGRAM_ID);
          const info = await connection.getAccountInfo(ata);
          if (info) bals[token.symbol] = Number(info.data.readBigUInt64LE(64)) / 1e6;
        } catch {}
      }
      setBalances(bals);
      setLoading(false);
    }
    load();
  }, [publicKey, connection]);

  const totalValue = Object.entries(balances).reduce((sum, [sym, bal]) => {
    const token = SOLSTICE_TOKENS.find(t => t.symbol === sym);
    return sum + bal * (token?.price || 1);
  }, 0);

  return (
    <div className="space-y-8">
      <div>
        <span className="eyebrow">Portfolio</span>
        <h2 className="text-3xl mt-2">Overview</h2>
        <p className="text-sm text-base-content/55 mt-1">Real-time view of your institutional lending positions.</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="panel p-5 space-y-1">
          <div className="eyebrow">Total Assets</div>
          <div className="figure text-3xl text-primary">
            {loading ? <span className="loading loading-dots loading-sm" /> :
              "$" + totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="text-xs text-base-content/45">Across all tokens</div>
        </div>

        <div className="panel p-5 space-y-1">
          <div className="eyebrow">Collateral Deposited</div>
          <div className="figure text-3xl text-success">$0.00</div>
          <div className="text-xs text-base-content/45">In klend market</div>
        </div>

        <div className="panel p-5 space-y-1">
          <div className="eyebrow">Outstanding Borrows</div>
          <div className="figure text-3xl text-warning">$0.00</div>
          <div className="text-xs text-base-content/45">USDC borrowed</div>
        </div>

        <div className="panel p-5 space-y-1">
          <div className="eyebrow">Health Factor</div>
          <div className="figure text-3xl text-success">--</div>
          <div className="text-xs text-base-content/45">No active positions</div>
        </div>
      </div>

      {/* Token Balances */}
      <div className="panel p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg">Wallet Balances</h3>
          <div className="badge badge-ghost badge-sm num">{solBalance.toFixed(2)} SOL</div>
        </div>

          {loading ? (
            <div className="flex justify-center py-8">
              <span className="loading loading-spinner loading-md" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th className="text-right">Balance</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {SOLSTICE_TOKENS.map(token => {
                    const bal = balances[token.symbol] || 0;
                    return (
                      <tr key={token.symbol} className="hover">
                        <td>
                          <div className="flex items-center gap-2">
                            <span className={`font-mono font-semibold ${token.color}`}>{token.symbol}</span>
                            {token.yield && (
                              <span className="badge badge-warning badge-xs gap-1">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
                                yield
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="text-right font-mono">{bal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td className="text-right text-base-content/50">${token.price.toFixed(2)}</td>
                        <td className="text-right font-mono font-semibold">
                          ${(bal * token.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>

      {/* Lending Flow */}
      <div className="panel p-6">
        <h3 className="text-lg mb-4">Institutional Lending Flow</h3>
        <ul className="steps steps-horizontal w-full text-xs">
          <li className="step step-primary">Get USDC</li>
          <li className="step">Mint USX</li>
          <li className="step">Lock for eUSX</li>
          <li className="step">KYC Wrap</li>
          <li className="step">Deposit</li>
          <li className="step">Borrow</li>
        </ul>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="panel-flat p-4 space-y-1">
            <div className="font-semibold text-sm text-success">Earn on Collateral</div>
            <p className="text-xs text-base-content/55">
              eUSX earns ~8–12% APY from funding rate arbitrage, hedged staking,
              and tokenized US Treasuries while locked as collateral.
            </p>
          </div>
          <div className="panel-flat p-4 space-y-1">
            <div className="font-semibold text-sm text-warning">Carry Trade</div>
            <p className="text-xs text-base-content/55">
              Borrow USDC at 0.5–20% APY against collateral earning ~8–12%.
              Net carry: up to ~10% APY profit on deposited capital.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
