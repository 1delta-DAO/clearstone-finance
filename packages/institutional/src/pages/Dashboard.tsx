import { useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

const SOLSTICE_TOKENS = [
  { symbol: "USDC", mint: "8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g", price: 1.0 },
  { symbol: "USDT", mint: "5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft", price: 1.0 },
  { symbol: "USX", mint: "7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS", price: 1.0 },
  { symbol: "eUSX", mint: "Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt", price: 1.08 },
];

export default function Dashboard() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [solBalance, setSolBalance] = useState(0);

  useEffect(() => {
    if (!publicKey) return;

    async function load() {
      const sol = await connection.getBalance(publicKey!);
      setSolBalance(sol / 1e9);

      const bals: Record<string, number> = {};
      for (const token of SOLSTICE_TOKENS) {
        try {
          const ata = getAssociatedTokenAddressSync(new PublicKey(token.mint), publicKey!, false, TOKEN_PROGRAM_ID);
          const info = await connection.getAccountInfo(ata);
          if (info) {
            const amount = info.data.readBigUInt64LE(64);
            bals[token.symbol] = Number(amount) / 1e6;
          }
        } catch {}
      }
      setBalances(bals);
    }
    load();
  }, [publicKey, connection]);

  const totalValue = Object.entries(balances).reduce((sum, [sym, bal]) => {
    const token = SOLSTICE_TOKENS.find(t => t.symbol === sym);
    return sum + bal * (token?.price || 1);
  }, 0);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Portfolio Overview</h2>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="stat bg-base-200 rounded-box border border-base-300">
          <div className="stat-title">Total Assets</div>
          <div className="stat-value text-primary">${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="stat-desc">Across all tokens</div>
        </div>
        <div className="stat bg-base-200 rounded-box border border-base-300">
          <div className="stat-title">Collateral Deposited</div>
          <div className="stat-value text-success">$0.00</div>
          <div className="stat-desc">In klend market</div>
        </div>
        <div className="stat bg-base-200 rounded-box border border-base-300">
          <div className="stat-title">Outstanding Borrows</div>
          <div className="stat-value text-warning">$0.00</div>
          <div className="stat-desc">USDC borrowed</div>
        </div>
        <div className="stat bg-base-200 rounded-box border border-base-300">
          <div className="stat-title">Health Factor</div>
          <div className="stat-value text-success">--</div>
          <div className="stat-desc">No active positions</div>
        </div>
      </div>

      {/* Token Balances */}
      <div className="card bg-base-200 border border-base-300">
        <div className="card-body p-6">
          <h3 className="card-title text-lg mb-4">Wallet Balances</h3>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="text-right">Balance</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="font-mono">SOL</td>
                  <td className="text-right font-mono">{solBalance.toFixed(4)}</td>
                  <td className="text-right text-base-content/60">--</td>
                  <td className="text-right text-base-content/60">--</td>
                </tr>
                {SOLSTICE_TOKENS.map(token => (
                  <tr key={token.symbol}>
                    <td>
                      <span className="font-mono">{token.symbol}</span>
                      {token.symbol === "eUSX" && (
                        <span className="badge badge-xs badge-success ml-2">yield</span>
                      )}
                    </td>
                    <td className="text-right font-mono">
                      {(balances[token.symbol] || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td className="text-right text-base-content/60">${token.price.toFixed(2)}</td>
                    <td className="text-right font-mono">
                      ${((balances[token.symbol] || 0) * token.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="card bg-base-200 border border-base-300">
        <div className="card-body p-6">
          <h3 className="card-title text-lg mb-4">Lending Flow</h3>
          <div className="steps steps-horizontal w-full">
            <div className="step step-primary">Get USDC/USDT</div>
            <div className="step">Mint USX</div>
            <div className="step">Lock → eUSX</div>
            <div className="step">Wrap → deUSX</div>
            <div className="step">Deposit Collateral</div>
            <div className="step">Borrow USDC</div>
          </div>
          <p className="text-sm text-base-content/50 mt-4">
            Deposit yield-bearing eUSX as KYC-gated collateral, then borrow USDC against it.
            eUSX earns ~8-12% APY while locked as collateral.
          </p>
        </div>
      </div>
    </div>
  );
}
