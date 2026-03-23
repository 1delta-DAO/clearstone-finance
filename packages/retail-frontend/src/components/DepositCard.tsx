import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { DeploymentConfig } from "../config/devnet";
import {
  buildDepositReserveLiquidityIx,
  reserveCollateralMint,
} from "../lib/klend";

interface DepositCardProps {
  usdcBalance: number | null;
  config: DeploymentConfig;
  supplyAPY?: number;
}

export function DepositCard({ usdcBalance, config, supplyAPY = 0 }: DepositCardProps) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "depositing" | "success" | "error">("idle");
  const [txSig, setTxSig] = useState<string>("");
  const [error, setError] = useState<string>("");

  const maxAmount = usdcBalance || 0;
  const apyPct = (supplyAPY * 100).toFixed(2);

  const handleDeposit = useCallback(async () => {
    if (!publicKey || !amount || Number(amount) <= 0) return;
    setStatus("depositing");
    setError("");

    try {
      const reserve = config.market.usdcReserve;
      const market = config.market.lendingMarket;
      const usdcMint = config.usdc.mint;
      const oracle = config.market.usdcOracle;

      const amountNative = BigInt(Math.floor(Number(amount) * 1e6));

      // User ATAs
      const userUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, publicKey, false, TOKEN_PROGRAM_ID
      );
      const cMint = reserveCollateralMint(reserve);
      const userCTokenAta = getAssociatedTokenAddressSync(
        cMint, publicKey, false, TOKEN_PROGRAM_ID
      );

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));

      // Create cToken ATA if it doesn't exist
      const cTokenInfo = await connection.getAccountInfo(userCTokenAta);
      if (!cTokenInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            publicKey, userCTokenAta, publicKey, cMint, TOKEN_PROGRAM_ID
          )
        );
      }

      // Note: refreshReserve skipped on devnet (Pyth V2 feeds are stale).
      // Deposits don't require a fresh oracle price.

      // Deposit
      tx.add(
        buildDepositReserveLiquidityIx(
          publicKey,
          reserve,
          market,
          usdcMint,
          amountNative,
          TOKEN_PROGRAM_ID,
          TOKEN_PROGRAM_ID,
          userUsdcAta,
          userCTokenAta,
        )
      );

      const sig = await sendTransaction(tx, connection, { skipPreflight: false });
      await connection.confirmTransaction(sig, "confirmed");

      setTxSig(sig);
      setStatus("success");
      setAmount("");
    } catch (e: any) {
      console.error("Deposit failed:", e);
      setError(e.message?.slice(0, 120) || "Deposit failed");
      setStatus("error");
    }
  }, [publicKey, amount, connection, config, sendTransaction]);

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Deposit USDC</h3>
      <p style={styles.subtitle}>
        Earn {apyPct}% APY by supplying USDC to the lending market
      </p>

      <div style={styles.inputGroup}>
        <label style={styles.label}>Amount (USDC)</label>
        <div style={styles.inputRow}>
          <input
            type="number"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setStatus("idle"); }}
            placeholder="0.00"
            min="0"
            max={maxAmount}
            step="0.01"
            style={styles.input}
          />
          <button onClick={() => setAmount(String(maxAmount))} style={styles.maxBtn}>
            MAX
          </button>
        </div>
        <span style={styles.balanceHint}>
          Balance: {maxAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC
        </span>
      </div>

      {Number(amount) > 0 && (
        <div style={styles.preview}>
          <div style={styles.previewRow}>
            <span>You deposit</span>
            <span>${Number(amount).toFixed(2)}</span>
          </div>
          <div style={styles.previewRow}>
            <span>Est. yearly yield ({apyPct}%)</span>
            <span style={{ color: "#4ade80" }}>
              +${(Number(amount) * supplyAPY).toFixed(2)}
            </span>
          </div>
        </div>
      )}

      <button
        onClick={handleDeposit}
        disabled={status === "depositing" || Number(amount) <= 0 || Number(amount) > maxAmount}
        style={{
          ...styles.depositBtn,
          opacity: status === "depositing" || Number(amount) <= 0 || Number(amount) > maxAmount ? 0.5 : 1,
        }}
      >
        {status === "depositing" ? "Depositing..." : status === "success" ? "Deposited!" : "Deposit USDC"}
      </button>

      {status === "success" && txSig && (
        <p style={styles.success}>
          Deposit confirmed!{" "}
          <a
            href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#4ade80" }}
          >
            View tx
          </a>
        </p>
      )}
      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.info}>
        <p>No lock-up period — withdraw anytime</p>
        <p>Interest accrues every Solana slot (~400ms)</p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { background: "#111827", border: "1px solid #1f2937", borderRadius: 12, padding: "24px" },
  title: { fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 4 },
  subtitle: { fontSize: 13, color: "#6b7280", marginBottom: 20 },
  inputGroup: { marginBottom: 16 },
  label: { display: "block", fontSize: 12, color: "#9ca3af", marginBottom: 6, textTransform: "uppercase" as const, letterSpacing: 0.5 },
  inputRow: { display: "flex", gap: 8 },
  input: { flex: 1, background: "#0a0e17", border: "1px solid #1f2937", borderRadius: 8, padding: "12px 16px", color: "#fff", fontSize: 18, fontFamily: "monospace", outline: "none" },
  maxBtn: { background: "#1f2937", border: "1px solid #374151", borderRadius: 8, padding: "0 16px", color: "#4ecdc4", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  balanceHint: { display: "block", fontSize: 11, color: "#6b7280", marginTop: 6, textAlign: "right" as const },
  preview: { background: "#0a0e17", borderRadius: 8, padding: "12px 16px", marginBottom: 16 },
  previewRow: { display: "flex", justifyContent: "space-between", fontSize: 13, color: "#d1d5db", marginBottom: 4 },
  depositBtn: { width: "100%", background: "#4ecdc4", color: "#0a0e17", border: "none", borderRadius: 8, padding: "14px", fontSize: 15, fontWeight: 700, cursor: "pointer" },
  success: { color: "#4ade80", fontSize: 13, marginTop: 12, textAlign: "center" as const },
  error: { color: "#ef4444", fontSize: 12, marginTop: 8 },
  info: { marginTop: 20, paddingTop: 16, borderTop: "1px solid #1f2937", fontSize: 11, color: "#6b7280", lineHeight: 1.8 },
};
