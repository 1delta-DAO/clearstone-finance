import { useState, useEffect, useCallback, useMemo } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { usePrograms } from "../hooks/usePrograms";
import Dropdown from "../components/Dropdown";

const BORROW_CURVE_OFFSET = 4920;

interface CurvePoint {
  utilizationRateBps: number;
  borrowRateBps: number;
}

// ---------------------------------------------------------------------------
// SVG Chart
// ---------------------------------------------------------------------------

const W = 560, H = 280;
const PAD = { top: 16, right: 24, bottom: 36, left: 56 };
const PW = W - PAD.left - PAD.right;
const PH = H - PAD.top - PAD.bottom;

function bps(v: number) { return (v / 100).toFixed(1) + "%"; }

function toPath(pts: CurvePoint[], maxR: number): string {
  return pts.map((p, i) => {
    const x = PAD.left + (p.utilizationRateBps / 10000) * PW;
    const y = PAD.top + PH - (Math.min(p.borrowRateBps, maxR) / maxR) * PH;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function Chart({ curve }: { curve: CurvePoint[] }) {
  const rawMax = Math.max(...curve.map(p => p.borrowRateBps), 100);
  const maxR = rawMax <= 1000 ? Math.ceil(rawMax / 200) * 200
    : rawMax <= 5000 ? Math.ceil(rawMax / 1000) * 1000
    : Math.ceil(rawMax / 5000) * 5000;

  const yTicks = Array.from({ length: 5 }, (_, i) => (maxR / 5) * (i + 1));
  const xTicks = [0, 2000, 4000, 6000, 8000, 10000];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {[0, ...yTicks].map(v => {
        const y = PAD.top + PH - (v / maxR) * PH;
        return <g key={`y${v}`}>
          <line x1={PAD.left} y1={y} x2={PAD.left + PW} y2={y} stroke="currentColor" strokeOpacity={0.08} />
          <text x={PAD.left - 6} y={y + 3} textAnchor="end" fontSize={9} fill="currentColor" fillOpacity={0.4}>{bps(v)}</text>
        </g>;
      })}
      {xTicks.map(v => {
        const x = PAD.left + (v / 10000) * PW;
        return <g key={`x${v}`}>
          <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + PH} stroke="currentColor" strokeOpacity={0.08} />
          <text x={x} y={PAD.top + PH + 14} textAnchor="middle" fontSize={9} fill="currentColor" fillOpacity={0.4}>{(v / 100)}%</text>
        </g>;
      })}
      <text x={PAD.left + PW / 2} y={H - 2} textAnchor="middle" fontSize={10} fill="currentColor" fillOpacity={0.5}>Utilization</text>
      <text x={10} y={PAD.top + PH / 2} textAnchor="middle" fontSize={10} fill="currentColor" fillOpacity={0.5}
        transform={`rotate(-90,10,${PAD.top + PH / 2})`}>Borrow Rate (APR)</text>

      <path d={toPath(curve, maxR)} fill="none" stroke="#22d3ee" strokeWidth={2} />
      {curve.map((p, i) => {
        const x = PAD.left + (p.utilizationRateBps / 10000) * PW;
        const y = PAD.top + PH - (Math.min(p.borrowRateBps, maxR) / maxR) * PH;
        return <circle key={i} cx={x} cy={y} r={3} fill="#22d3ee" />;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function RateCurvePanel() {
  const { connection } = useConnection();
  const { config } = usePrograms();

  const reserveEntries = useMemo(() => [
    { label: "dtUSDY (collateral)", address: config.market.dUsdyReserve },
    { label: "sUSDC (borrow)", address: config.market.usdcReserve },
  ], [config]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [customAddr, setCustomAddr] = useState("");
  const activeAddress = customAddr
    ? (() => { try { return new PublicKey(customAddr); } catch { return null; } })()
    : reserveEntries[selectedIdx]?.address ?? null;

  const [curve, setCurve] = useState<CurvePoint[] | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchCurve = useCallback(async () => {
    if (!activeAddress) { setCurve(null); return; }
    setLoading(true);
    try {
      const info = await connection.getAccountInfo(activeAddress);
      if (!info || info.data.length < BORROW_CURVE_OFFSET + 88) { setCurve(null); setLoading(false); return; }
      const points: CurvePoint[] = [];
      for (let i = 0; i < 11; i++) {
        const off = BORROW_CURVE_OFFSET + i * 8;
        points.push({
          utilizationRateBps: info.data.readUInt32LE(off),
          borrowRateBps: info.data.readUInt32LE(off + 4),
        });
      }
      setCurve(points);
    } catch { setCurve(null); }
    setLoading(false);
  }, [activeAddress, connection]);

  useEffect(() => { fetchCurve(); }, [fetchCurve]);

  // Deduplicate trailing points (klend pads with repeated last point)
  const displayCurve = useMemo(() => {
    if (!curve) return null;
    const unique: CurvePoint[] = [curve[0]];
    for (let i = 1; i < curve.length; i++) {
      if (curve[i].utilizationRateBps !== curve[i - 1].utilizationRateBps ||
          curve[i].borrowRateBps !== curve[i - 1].borrowRateBps) {
        unique.push(curve[i]);
      }
    }
    return unique;
  }, [curve]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <span className="eyebrow">Operator</span>
        <h2 className="text-2xl mt-1">Rate Curves</h2>
        <p className="text-sm text-base-content/55 mt-1">
          On-chain borrow rate curves for klend reserves. To change the IRM, use{" "}
          <code className="bg-base-300 px-1 rounded text-xs">npx tsx scripts/replace-reserve-irm.ts</code>.
        </p>
      </div>

      {/* Reserve selector */}
      <div className="panel">
        <div className="card-body p-6 gap-4">
          <h3 className="text-base">Select Reserve</h3>
          <div className="flex gap-3 flex-wrap">
            <Dropdown
              value={selectedIdx}
              onChange={(v) => { setSelectedIdx(Number(v)); setCustomAddr(""); }}
              options={reserveEntries.map((r, i) => ({ value: i, label: `${r.label} (${r.address.toBase58().slice(0, 8)}...)` }))}
              className="min-w-[260px]"
            />
            <span className="self-center opacity-40 text-sm">or</span>
            <input
              placeholder="Paste any reserve address"
              value={customAddr}
              onChange={(e) => setCustomAddr(e.target.value)}
              className="input input-bordered bg-base-200 text-base-content font-mono flex-1 text-sm"
            />
            {loading && <span className="loading loading-spinner loading-sm self-center" />}
          </div>
          {activeAddress && (
            <div className="text-xs font-mono opacity-40">{activeAddress.toBase58()}</div>
          )}
        </div>
      </div>

      {/* Chart + Table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="panel">
          <div className="card-body p-5">
            <h3 className="text-base font-semibold mb-2">Borrow Rate Curve</h3>
            {curve ? <Chart curve={curve} /> : (
              <div className="flex items-center justify-center h-48 opacity-30 text-sm">
                {loading ? "Loading..." : "No curve data — select a valid reserve"}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="card-body p-5">
            <h3 className="text-base font-semibold mb-2">Curve Points</h3>
            {displayCurve ? (
              <div className="overflow-y-auto">
                <table className="table table-xs">
                  <thead><tr><th>#</th><th>Utilization</th><th>Borrow Rate</th></tr></thead>
                  <tbody>
                    {displayCurve.map((p, i) => (
                      <tr key={i}>
                        <td className="opacity-40 font-mono">{i + 1}</td>
                        <td className="font-mono">{(p.utilizationRateBps / 100).toFixed(1)}%</td>
                        <td className="font-mono">{(p.borrowRateBps / 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                    {curve && displayCurve.length < curve.length && (
                      <tr><td colSpan={3} className="text-xs opacity-30 text-center">
                        +{curve.length - displayCurve.length} trailing points at {bps(displayCurve[displayCurve.length - 1].borrowRateBps)}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex items-center justify-center h-48 opacity-30 text-sm">No data</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
