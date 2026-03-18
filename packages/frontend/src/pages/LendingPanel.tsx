import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { usePrograms } from "../hooks/usePrograms";

export default function LendingPanel() {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const { config } = usePrograms();

  const [depositAmt, setDepositAmt] = useState("");
  const [borrowAmt, setBorrowAmt] = useState("");
  const [repayAmt, setRepayAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [dUsdyBalance, setDUsdyBalance] = useState<string | null>(null);
  const [isWhitelisted, setIsWhitelisted] = useState<boolean | null>(null);
  const [status, setStatus] = useState<{ msg: string; type: "info" | "ok" | "err" } | null>(null);

  const showStatus = (msg: string, type: "info" | "ok" | "err" = "info") => {
    setStatus({ msg, type });
    if (type !== "info") setTimeout(() => setStatus(null), 8000);
  };

  // Fetch balances
  useEffect(() => {
    if (!publicKey || !connected) return;
    let cancelled = false;

    (async () => {
      try {
        // Check dUSDY balance
        const dUsdyAta = getAssociatedTokenAddressSync(
          config.pool.wrappedMint, publicKey, false, TOKEN_2022_PROGRAM_ID
        );
        const ataInfo = await connection.getTokenAccountBalance(dUsdyAta).catch(() => null);
        if (!cancelled) {
          setDUsdyBalance(ataInfo ? (Number(ataInfo.value.amount) / 1e6).toFixed(2) : "0.00");
        }

        // Check whitelist status
        const [whitelistEntry] = PublicKey.findProgramAddressSync(
          [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
          config.programs.deltaMint
        );
        const wlInfo = await connection.getAccountInfo(whitelistEntry);
        if (!cancelled) setIsWhitelisted(!!wlInfo);
      } catch {
        if (!cancelled) {
          setDUsdyBalance("0.00");
          setIsWhitelisted(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [publicKey, connected, connection, config]);

  if (!connected) {
    return (
      <Card title="Connect Wallet">
        <p style={{ color: "#888" }}>Connect your wallet to access lending operations.</p>
        <p style={{ color: "#666", fontSize: 13 }}>
          You must be KYC-whitelisted to deposit dUSDY collateral.
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {status && (
        <div style={{
          padding: "10px 16px", borderRadius: 6, fontSize: 13, fontFamily: "monospace",
          background: status.type === "ok" ? "#1a3a1a" : status.type === "err" ? "#3a1a1a" : "#1a1a3a",
          border: `1px solid ${status.type === "ok" ? "#4caf50" : status.type === "err" ? "#f44336" : "#4a9eff"}`,
          color: status.type === "ok" ? "#4caf50" : status.type === "err" ? "#f44336" : "#4a9eff",
        }}>
          {status.msg}
        </div>
      )}

      {/* Position Overview */}
      <Card title="Your Position">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16, textAlign: "center" }}>
          <StatBox label="Wallet Balance" value={dUsdyBalance ?? "..."} unit="dUSDY" />
          <StatBox
            label="KYC Status"
            value={isWhitelisted === null ? "..." : isWhitelisted ? "Approved" : "Not KYC'd"}
            color={isWhitelisted ? "#4caf50" : "#f44336"}
          />
          <StatBox label="Deposited" value="—" unit="dUSDY" />
          <StatBox label="Borrowed" value="—" unit="USDC" />
        </div>
      </Card>

      {!isWhitelisted && isWhitelisted !== null && (
        <div style={{
          padding: "12px 16px", borderRadius: 6, background: "#3a2a1a",
          border: "1px solid #ff9800", color: "#ff9800", fontSize: 13,
        }}>
          Your wallet is not KYC-whitelisted. Contact the market administrator to get whitelisted
          before depositing dUSDY.
        </div>
      )}

      {/* Operations grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card title="Deposit dUSDY">
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
            Deposit dUSDY as collateral to borrow USDC.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Amount"
              value={depositAmt}
              onChange={(e) => setDepositAmt(e.target.value)}
              style={inputStyle}
              type="number"
            />
            <ActionButton
              label="Deposit"
              color="#4caf50"
              onClick={() => showStatus("Deposit coming soon — klend deposit integration pending", "info")}
            />
          </div>
          <MaxButton label={`Wallet: ${dUsdyBalance ?? "—"} dUSDY`} onClick={() => setDepositAmt(dUsdyBalance || "")} />
        </Card>

        <Card title="Borrow USDC">
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
            Borrow USDC against your dUSDY collateral.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Amount"
              value={borrowAmt}
              onChange={(e) => setBorrowAmt(e.target.value)}
              style={inputStyle}
              type="number"
            />
            <ActionButton
              label="Borrow"
              color="#ff9800"
              onClick={() => showStatus("Borrow coming soon — klend borrow integration pending", "info")}
            />
          </div>
        </Card>

        <Card title="Repay USDC">
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
            Repay borrowed USDC to release collateral.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Amount"
              value={repayAmt}
              onChange={(e) => setRepayAmt(e.target.value)}
              style={inputStyle}
              type="number"
            />
            <ActionButton
              label="Repay"
              color="#2196f3"
              onClick={() => showStatus("Repay coming soon", "info")}
            />
          </div>
        </Card>

        <Card title="Withdraw dUSDY">
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
            Withdraw collateral (must maintain health factor).
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Amount"
              value={withdrawAmt}
              onChange={(e) => setWithdrawAmt(e.target.value)}
              style={inputStyle}
              type="number"
            />
            <ActionButton
              label="Withdraw"
              color="#f44336"
              onClick={() => showStatus("Withdraw coming soon", "info")}
            />
          </div>
        </Card>
      </div>

      {/* Deployment Info */}
      <Card title="Market Info">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 12, color: "#666" }}>
          <span>dUSDY Mint:</span><Addr value={config.pool.wrappedMint.toBase58()} />
          <span>Governor Pool:</span><Addr value={config.pool.poolConfig.toBase58()} />
          <span>Underlying (USDY):</span><Addr value={config.pool.underlyingMint.toBase58()} />
          <span>Oracle:</span><Addr value={config.oracles.usdyPythV2.toBase58()} />
        </div>
      </Card>
    </div>
  );
}

// ── Reusable components ──

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid #333", borderRadius: 8, padding: 20, background: "#0d0d1a" }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 16, color: "#e0e0e0" }}>{title}</h3>
      {children}
    </div>
  );
}

function StatBox({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 600, color: color || "#e0e0e0", fontFamily: "monospace" }}>{value}</div>
      <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
        {unit && <span style={{ color: "#666" }}>{unit} </span>}{label}
      </div>
    </div>
  );
}

function ActionButton({ label, onClick, color }: { label: string; onClick: () => void; color: string }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 20px", border: `1px solid ${color}`, borderRadius: 6,
      background: `${color}22`, color, cursor: "pointer", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
    }}>
      {label}
    </button>
  );
}

function MaxButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
      <span onClick={onClick} style={{ cursor: "pointer", textDecoration: "underline" }}>{label}</span>
    </div>
  );
}

function Addr({ value }: { value?: string }) {
  if (!value) return <span>—</span>;
  return <span style={{ fontFamily: "monospace", color: "#aaa" }}>{value.slice(0, 8)}...{value.slice(-4)}</span>;
}

const inputStyle: React.CSSProperties = {
  flex: 1, padding: "8px 12px", border: "1px solid #333", borderRadius: 6,
  background: "#111", color: "#e0e0e0", fontSize: 14, fontFamily: "monospace",
};
