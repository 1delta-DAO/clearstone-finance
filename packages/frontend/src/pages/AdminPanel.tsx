import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";

/**
 * Admin Panel — Banking group governance operations
 *
 * Sections:
 *   1. Mint Management — Initialize dUSDY mint, view status
 *   2. KYC Whitelist — Add/remove whitelisted wallets, view list
 *   3. Market Setup — Create lending market, initialize reserves
 *   4. Reserve Config — Set LTV, oracles, deposit/borrow limits
 *   5. Token Minting — Mint dUSDY to whitelisted counterparties
 */

export default function AdminPanel() {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();

  const [whitelistAddr, setWhitelistAddr] = useState("");
  const [mintAmount, setMintAmount] = useState("");
  const [mintRecipient, setMintRecipient] = useState("");

  if (!connected) {
    return (
      <Card title="Connect Wallet">
        <p style={{ color: "#888" }}>Connect your wallet to access admin controls.</p>
        <p style={{ color: "#666", fontSize: 13 }}>
          Only the market authority wallet can perform governance operations.
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* 1. Market Setup */}
      <Card title="1. Market Setup">
        <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
          Initialize the dUSDY mint and create a new klend lending market.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <ActionButton label="Initialize dUSDY Mint" onClick={() => {/* TODO: admin.initializeMint */}} />
          <ActionButton label="Create Lending Market" onClick={() => {/* TODO: admin.createLendingMarket */}} />
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <ActionButton label="Init dUSDY Reserve" onClick={() => {/* TODO: admin.initReserve (dUSDY) */}} />
          <ActionButton label="Init USDC Reserve" onClick={() => {/* TODO: admin.initReserve (USDC) */}} />
        </div>
      </Card>

      {/* 2. Reserve Configuration */}
      <Card title="2. Reserve Configuration">
        <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
          Set LTV ratios, oracle feeds, and deposit/borrow limits.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <ConfigRow label="dUSDY LTV" value="95%" />
          <ConfigRow label="dUSDY Liq. Threshold" value="97%" />
          <ConfigRow label="Pyth dUSDY Oracle" value="BkN8...Lmpb" />
          <ConfigRow label="Pyth USDC Oracle" value="Gnt2...eJotD" />
          <ConfigRow label="Deposit Limit" value="1,000,000" />
          <ConfigRow label="Borrow Limit" value="500,000" />
        </div>
        <ActionButton label="Apply Configuration" onClick={() => {/* TODO: admin.configBatch */}} style={{ marginTop: 12 }} />
      </Card>

      {/* 3. KYC Whitelist */}
      <Card title="3. KYC Whitelist Management">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Wallet address to whitelist"
            value={whitelistAddr}
            onChange={(e) => setWhitelistAddr(e.target.value)}
            style={inputStyle}
          />
          <ActionButton label="Add to Whitelist" onClick={() => {/* TODO: admin.addToWhitelist */}} />
        </div>
      </Card>

      {/* 4. Mint Tokens */}
      <Card title="4. Mint dUSDY">
        <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
          Mint dUSDY tokens to a whitelisted counterparty.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Recipient wallet"
            value={mintRecipient}
            onChange={(e) => setMintRecipient(e.target.value)}
            style={{ ...inputStyle, flex: 2 }}
          />
          <input
            placeholder="Amount"
            value={mintAmount}
            onChange={(e) => setMintAmount(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <ActionButton label="Mint" onClick={() => {/* TODO: admin.mintTokens */}} />
        </div>
      </Card>

      {/* Status */}
      <Card title="Market Status">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 13, color: "#aaa" }}>
          <span>Authority:</span><span style={{ fontFamily: "monospace" }}>{publicKey?.toBase58().slice(0, 16)}...</span>
          <span>Cluster:</span><span>Devnet</span>
          <span>Programs:</span><span>delta-mint + governor</span>
          <span>Lending:</span><span>Kamino v2 (klend)</span>
        </div>
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

function ActionButton({ label, onClick, style }: { label: string; onClick: () => void; style?: React.CSSProperties }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 16px",
        border: "1px solid #4a9eff",
        borderRadius: 6,
        background: "#1a2a4a",
        color: "#4a9eff",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 500,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {label}
    </button>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span style={{ color: "#888", fontSize: 13 }}>{label}</span>
      <span style={{ color: "#e0e0e0", fontSize: 13, fontFamily: "monospace" }}>{value}</span>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  border: "1px solid #333",
  borderRadius: 6,
  background: "#111",
  color: "#e0e0e0",
  fontSize: 13,
  fontFamily: "monospace",
};
