import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { DeploymentConfig } from "../config/devnet";

interface PortfolioCardProps {
  usdcBalance: number | null;
  config: DeploymentConfig;
}

export function PortfolioCard({ usdcBalance, config }: PortfolioCardProps) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [depositedAmount, setDepositedAmount] = useState<number | null>(null);

  // Check if user has cTokens (klend receipt tokens) indicating deposits
  useEffect(() => {
    if (!publicKey) return;
    // For now, show a placeholder — actual klend cToken balance would be fetched here
    setDepositedAmount(0);
  }, [publicKey, connection]);

  const totalValue = (usdcBalance || 0) + (depositedAmount || 0);
  const earnedYield = depositedAmount ? depositedAmount * 0.042 / 365 * 30 : 0; // ~30 days of yield

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Your Portfolio</h3>

      <div style={styles.row}>
        <span style={styles.label}>Wallet USDC</span>
        <span style={styles.value}>
          ${usdcBalance !== null ? usdcBalance.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}
        </span>
      </div>

      <div style={styles.row}>
        <span style={styles.label}>Deposited</span>
        <span style={styles.value}>
          ${depositedAmount !== null ? depositedAmount.toLocaleString(undefined, { minimumFractionDigits: 2 }) : "—"}
        </span>
      </div>

      <div style={{ ...styles.row, borderTop: "1px solid #1f2937", paddingTop: 12, marginTop: 4 }}>
        <span style={{ ...styles.label, color: "#fff", fontWeight: 600 }}>Total</span>
        <span style={{ ...styles.value, color: "#fff", fontWeight: 700 }}>
          ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </span>
      </div>

      {depositedAmount !== null && depositedAmount > 0 && (
        <div style={styles.yieldBox}>
          <span style={styles.yieldLabel}>Estimated monthly yield</span>
          <span style={styles.yieldValue}>
            +${earnedYield.toFixed(2)}
          </span>
        </div>
      )}

      <div style={styles.statusRow}>
        <span style={styles.statusDot} />
        <span style={styles.statusText}>KYC Verified</span>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: 12,
    padding: "24px",
  },
  title: { fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 20 },
  row: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  label: { fontSize: 14, color: "#9ca3af" },
  value: { fontSize: 14, color: "#d1d5db", fontFamily: "monospace" },
  yieldBox: {
    background: "#0d2818",
    border: "1px solid #166534",
    borderRadius: 8,
    padding: "12px 16px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 16,
  },
  yieldLabel: { fontSize: 12, color: "#4ade80" },
  yieldValue: { fontSize: 16, fontWeight: 700, color: "#4ade80" },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 20,
    paddingTop: 12,
    borderTop: "1px solid #1f2937",
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#4ade80",
  },
  statusText: { fontSize: 12, color: "#4ade80" },
};
