import { useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import AdminPanel from "../pages/AdminPanel";
import LendingPanel from "../pages/LendingPanel";
import OraclePanel from "../pages/OraclePanel";

type Tab = "admin" | "lending" | "oracles";

export default function Layout() {
  const [tab, setTab] = useState<Tab>("admin");

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      {/* Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Delta Lending Console</h1>
          <p style={{ margin: 0, color: "#888", fontSize: 14 }}>
            KYC-gated institutional lending on Solana
          </p>
        </div>
        <WalletMultiButton />
      </header>

      {/* Tab navigation */}
      <nav style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <button
          onClick={() => setTab("admin")}
          style={{
            padding: "8px 20px",
            border: "1px solid #333",
            borderRadius: 6,
            background: tab === "admin" ? "#1a1a2e" : "transparent",
            color: tab === "admin" ? "#fff" : "#888",
            cursor: "pointer",
            fontWeight: tab === "admin" ? 600 : 400,
          }}
        >
          Admin / Governance
        </button>
        <button
          onClick={() => setTab("lending")}
          style={{
            padding: "8px 20px",
            border: "1px solid #333",
            borderRadius: 6,
            background: tab === "lending" ? "#1a1a2e" : "transparent",
            color: tab === "lending" ? "#fff" : "#888",
            cursor: "pointer",
            fontWeight: tab === "lending" ? 600 : 400,
          }}
        >
          Lending
        </button>
        <button
          onClick={() => setTab("oracles")}
          style={{
            padding: "8px 20px",
            border: "1px solid #333",
            borderRadius: 6,
            background: tab === "oracles" ? "#1a1a2e" : "transparent",
            color: tab === "oracles" ? "#fff" : "#888",
            cursor: "pointer",
            fontWeight: tab === "oracles" ? 600 : 400,
          }}
        >
          Oracles
        </button>
      </nav>

      {/* Content */}
      {tab === "admin" ? <AdminPanel /> : tab === "lending" ? <LendingPanel /> : <OraclePanel />}
    </div>
  );
}
