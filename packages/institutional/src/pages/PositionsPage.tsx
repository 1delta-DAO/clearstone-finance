import { useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");

export default function PositionsPage() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [obligation, setObligation] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!publicKey) return;

    async function load() {
      setLoading(true);
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from([0]), Buffer.from([0]), publicKey!.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
        KLEND
      );
      const info = await connection.getAccountInfo(obPda);
      if (info) {
        setObligation({
          address: obPda.toBase58(),
          size: info.data.length,
          exists: true,
        });
      } else {
        setObligation(null);
      }
      setLoading(false);
    }
    load();
  }, [publicKey, connection]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <span className="loading loading-spinner loading-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Active Positions</h2>

      {!obligation ? (
        <div className="card bg-base-200 border border-base-300">
          <div className="card-body p-8 text-center">
            <p className="text-base-content/60 text-lg">No active lending positions.</p>
            <p className="text-sm text-base-content/40">
              Deposit collateral first, then borrow against it.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="card bg-base-200 border border-base-300">
            <div className="card-body p-6">
              <h3 className="card-title text-lg mb-4">Obligation</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-base-content/60">Address</span>
                    <span className="font-mono text-xs">{obligation.address.slice(0, 20)}...</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-base-content/60">Status</span>
                    <span className="badge badge-success badge-sm">Active</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-base-content/60">Market</span>
                    <span className="font-mono text-xs">{MARKET.toBase58().slice(0, 12)}...</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-base-content/60">Account Size</span>
                    <span className="font-mono">{obligation.size} bytes</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card bg-base-200 border border-base-300">
              <div className="card-body p-6">
                <h3 className="card-title text-lg">Collateral</h3>
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th className="text-right">Amount</th>
                        <th className="text-right">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="font-mono">dUSDY</td>
                        <td className="text-right font-mono">--</td>
                        <td className="text-right font-mono">--</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-base-content/40 mt-2">
                  Collateral amounts are tracked in the obligation account on-chain.
                </p>
              </div>
            </div>

            <div className="card bg-base-200 border border-base-300">
              <div className="card-body p-6">
                <h3 className="card-title text-lg">Borrows</h3>
                <div className="overflow-x-auto">
                  <table className="table table-sm">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th className="text-right">Amount</th>
                        <th className="text-right">Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="font-mono">USDC</td>
                        <td className="text-right font-mono">--</td>
                        <td className="text-right font-mono">~5%</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-base-content/40 mt-2">
                  Outstanding borrow amounts accrue interest over time.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
