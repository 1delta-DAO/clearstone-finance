import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";

/**
 * Lending Panel — End-user operations
 *
 * For whitelisted counterparties to interact with the lending market:
 *   - View positions (collateral deposited, loans outstanding)
 *   - Deposit dUSDY as collateral
 *   - Borrow USDC against collateral
 *   - Repay USDC loans
 *   - Withdraw dUSDY collateral
 */

export default function LendingPanel() {
  const { publicKey, connected } = useWallet();
  const [depositAmt, setDepositAmt] = useState("");
  const [borrowAmt, setBorrowAmt] = useState("");
  const [repayAmt, setRepayAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");

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
      {/* Position Overview */}
      <Card title="Your Position">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16, textAlign: "center" }}>
          <StatBox label="dUSDY Deposited" value="—" unit="dUSDY" />
          <StatBox label="USDC Borrowed" value="—" unit="USDC" />
          <StatBox label="Health Factor" value="—" color="#4caf50" />
          <StatBox label="Available to Borrow" value="—" unit="USDC" />
        </div>
      </Card>

      {/* Operations grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Deposit */}
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
            />
            <ActionButton
              label="Deposit"
              color="#4caf50"
              onClick={() => {/* TODO: lending.deposit */}}
            />
          </div>
          <MaxButton label="Wallet: — dUSDY" onClick={() => setDepositAmt("")} />
        </Card>

        {/* Borrow */}
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
            />
            <ActionButton
              label="Borrow"
              color="#ff9800"
              onClick={() => {/* TODO: lending.borrow */}}
            />
          </div>
          <MaxButton label="Max: — USDC (95% LTV)" onClick={() => setBorrowAmt("")} />
        </Card>

        {/* Repay */}
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
            />
            <ActionButton
              label="Repay"
              color="#2196f3"
              onClick={() => {/* TODO: lending.repay */}}
            />
          </div>
          <MaxButton label="Outstanding: — USDC" onClick={() => setRepayAmt("")} />
        </Card>

        {/* Withdraw */}
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
            />
            <ActionButton
              label="Withdraw"
              color="#f44336"
              onClick={() => {/* TODO: lending.withdraw */}}
            />
          </div>
          <MaxButton label="Available: — dUSDY" onClick={() => setWithdrawAmt("")} />
        </Card>
      </div>

      {/* Transaction history placeholder */}
      <Card title="Recent Transactions">
        <p style={{ color: "#666", fontSize: 13, textAlign: "center", padding: 20 }}>
          No transactions yet. Deposit dUSDY collateral to get started.
        </p>
      </Card>
    </div>
  );
}

// ── Reusable components ──

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: "1px solid #333",
      borderRadius: 8,
      padding: 20,
      background: "#0d0d1a",
    }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 16, color: "#e0e0e0" }}>{title}</h3>
      {children}
    </div>
  );
}

function StatBox({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 24, fontWeight: 600, color: color || "#e0e0e0", fontFamily: "monospace" }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
        {unit && <span style={{ color: "#666" }}>{unit} </span>}
        {label}
      </div>
    </div>
  );
}

function ActionButton({ label, onClick, color }: { label: string; onClick: () => void; color: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 20px",
        border: `1px solid ${color}`,
        borderRadius: 6,
        background: `${color}22`,
        color,
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function MaxButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
      <span
        onClick={onClick}
        style={{ cursor: "pointer", textDecoration: "underline" }}
      >
        {label}
      </span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  border: "1px solid #333",
  borderRadius: 6,
  background: "#111",
  color: "#e0e0e0",
  fontSize: 14,
  fontFamily: "monospace",
};
