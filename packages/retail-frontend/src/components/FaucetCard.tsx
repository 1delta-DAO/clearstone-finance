import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { DEVNET_CONFIG } from "../config/devnet";

const FAUCET_API = import.meta.env.VITE_FAUCET_URL || "http://localhost:3099";

interface Props {
  usdcBalance: number | null;
  onMinted: () => void;
}

export function FaucetCard({ usdcBalance, onMinted }: Props) {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<"idle" | "minting" | "success" | "error">("idle");
  const [error, setError] = useState("");

  const requestUsdc = useCallback(async () => {
    if (!publicKey) return;
    setStatus("minting");
    setError("");

    try {
      // First ensure the ATA exists (user pays for creation)
      const mint = DEVNET_CONFIG.usdc.mint;
      const ata = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_PROGRAM_ID);

      const ataInfo = await connection.getAccountInfo(ata);
      if (!ataInfo) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            publicKey, ata, publicKey, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
        const sig = await sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, "confirmed");
      }

      // Call faucet API
      const res = await fetch(`${FAUCET_API}/faucet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58(), amount: 1000 }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `Faucet error ${res.status}`);
      }

      setStatus("success");
      setTimeout(() => { setStatus("idle"); onMinted(); }, 2000);
    } catch (e: any) {
      setError(e.message?.slice(0, 120) || "Failed");
      setStatus("error");
    }
  }, [publicKey, connection, sendTransaction, onMinted]);

  if (!publicKey) return null;

  const hasEnough = (usdcBalance ?? 0) >= 10;

  return (
    <div style={{
      background: "#1a1a2e", borderRadius: 12, padding: 24,
      border: "1px solid #2a2a4e",
    }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 16, color: "#e0e0e0" }}>
        Test USDC Faucet
      </h3>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: "#888" }}>
        Get free test USDC to try depositing. Devnet only.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 14, color: "#aaa" }}>
          Balance: <span style={{ color: "#fff", fontWeight: 600 }}>
            {usdcBalance !== null ? `${usdcBalance.toFixed(2)} USDC` : "—"}
          </span>
        </div>

        <button
          onClick={requestUsdc}
          disabled={status === "minting" || hasEnough}
          style={{
            marginLeft: "auto",
            padding: "8px 20px",
            borderRadius: 8,
            border: "none",
            background: hasEnough ? "#333" : "#4a90d9",
            color: hasEnough ? "#666" : "#fff",
            fontWeight: 600,
            cursor: hasEnough ? "default" : "pointer",
            fontSize: 14,
          }}
        >
          {status === "minting" ? "Minting..." :
           status === "success" ? "Done!" :
           hasEnough ? "Funded" :
           "Get 1,000 USDC"}
        </button>
      </div>

      {status === "error" && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#ff6b6b" }}>
          {error || "Failed to mint. Is the faucet server running? (pnpm faucet:serve)"}
        </div>
      )}
    </div>
  );
}
