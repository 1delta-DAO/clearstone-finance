import { useState, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
import { usePrograms } from "../hooks/usePrograms";

export default function AdminPanel() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { governor, config, ready } = usePrograms();

  const [whitelistAddr, setWhitelistAddr] = useState("");
  const [mintAmount, setMintAmount] = useState("");
  const [mintRecipient, setMintRecipient] = useState("");
  const [status, setStatus] = useState<{ msg: string; type: "info" | "ok" | "err" } | null>(null);
  const [loading, setLoading] = useState(false);

  const showStatus = (msg: string, type: "info" | "ok" | "err" = "info") => {
    setStatus({ msg, type });
    if (type !== "info") setTimeout(() => setStatus(null), 8000);
  };

  // --- Whitelist a wallet ---
  const handleWhitelist = useCallback(async () => {
    if (!governor || !publicKey || !whitelistAddr) return;
    setLoading(true);
    showStatus("Whitelisting...");
    try {
      const wallet = new PublicKey(whitelistAddr);
      const [whitelistEntry] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), wallet.toBuffer()],
        config.programs.deltaMint
      );

      const sig = await (governor.methods as any)
        .addParticipant({ holder: {} })
        .accounts({
          authority: publicKey,
          poolConfig: config.pool.poolConfig,
          dmMintConfig: config.pool.dmMintConfig,
          wallet,
          whitelistEntry,
          deltaMintProgram: config.programs.deltaMint,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      showStatus(`Whitelisted! Tx: ${sig.slice(0, 20)}...`, "ok");
      setWhitelistAddr("");
    } catch (e: any) {
      showStatus(`Failed: ${e.message}`, "err");
    }
    setLoading(false);
  }, [governor, publicKey, whitelistAddr, config]);

  // --- Mint dUSDY ---
  const handleMint = useCallback(async () => {
    if (!governor || !publicKey || !mintRecipient || !mintAmount) return;
    setLoading(true);
    showStatus("Minting dUSDY...");
    try {
      const recipient = new PublicKey(mintRecipient);
      const amount = new BN(parseFloat(mintAmount) * 1e6);

      // Ensure recipient has a dUSDY ATA
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        // We can't sign with the wallet adapter for getOrCreateAssociatedTokenAccount,
        // so we just compute the ATA address
        { publicKey, signTransaction: async (tx: any) => tx, signAllTransactions: async (txs: any) => txs } as any,
        config.pool.wrappedMint,
        recipient,
        false,
        "confirmed",
        undefined,
        TOKEN_2022_PROGRAM_ID,
      );

      const [whitelistEntry] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), recipient.toBuffer()],
        config.programs.deltaMint
      );

      const sig = await (governor.methods as any)
        .mintWrapped(amount)
        .accounts({
          authority: publicKey,
          poolConfig: config.pool.poolConfig,
          dmMintConfig: config.pool.dmMintConfig,
          wrappedMint: config.pool.wrappedMint,
          dmMintAuthority: config.pool.dmMintAuthority,
          whitelistEntry,
          destination: ata.address,
          deltaMintProgram: config.programs.deltaMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      showStatus(`Minted ${mintAmount} dUSDY! Tx: ${sig.slice(0, 20)}...`, "ok");
      setMintAmount("");
    } catch (e: any) {
      showStatus(`Mint failed: ${e.message}`, "err");
    }
    setLoading(false);
  }, [governor, publicKey, mintRecipient, mintAmount, connection, config]);

  if (!connected) {
    return (
      <Card title="Connect Wallet">
        <p style={{ color: "#888" }}>Connect your wallet to access admin controls.</p>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {status && (
        <div style={{
          padding: "10px 16px",
          borderRadius: 6,
          background: status.type === "ok" ? "#1a3a1a" : status.type === "err" ? "#3a1a1a" : "#1a1a3a",
          border: `1px solid ${status.type === "ok" ? "#4caf50" : status.type === "err" ? "#f44336" : "#4a9eff"}`,
          color: status.type === "ok" ? "#4caf50" : status.type === "err" ? "#f44336" : "#4a9eff",
          fontSize: 13,
          fontFamily: "monospace",
        }}>
          {status.msg}
        </div>
      )}

      {/* KYC Whitelist */}
      <Card title="1. KYC Whitelist Management">
        <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
          Add a wallet to the KYC whitelist to allow them to hold dUSDY.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="Wallet address to whitelist"
            value={whitelistAddr}
            onChange={(e) => setWhitelistAddr(e.target.value)}
            style={inputStyle}
          />
          <ActionButton label="Whitelist" onClick={handleWhitelist} disabled={loading || !whitelistAddr} />
        </div>
      </Card>

      {/* Mint Tokens */}
      <Card title="2. Mint dUSDY">
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
            type="number"
          />
          <ActionButton label="Mint" onClick={handleMint} disabled={loading || !mintRecipient || !mintAmount} />
        </div>
      </Card>

      {/* Market Status */}
      <Card title="Deployment Status">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 13, color: "#aaa" }}>
          <span>Authority:</span>
          <Addr value={publicKey?.toBase58()} />
          <span>Cluster:</span><span>Devnet</span>
          <span>Governor Pool:</span>
          <Addr value={config.pool.poolConfig.toBase58()} />
          <span>dUSDY Mint:</span>
          <Addr value={config.pool.wrappedMint.toBase58()} />
          <span>delta-mint:</span>
          <Addr value={config.programs.deltaMint.toBase58()} />
          <span>governor:</span>
          <Addr value={config.programs.governor.toBase58()} />
          <span>klend:</span>
          <Addr value={config.programs.klend.toBase58()} />
          <span>SDK ready:</span>
          <span style={{ color: ready ? "#4caf50" : "#f44336" }}>{ready ? "Yes" : "No (connect wallet)"}</span>
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

function ActionButton({ label, onClick, disabled, style }: {
  label: string; onClick: () => void; disabled?: boolean; style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 16px", border: "1px solid #4a9eff", borderRadius: 6,
        background: disabled ? "#111" : "#1a2a4a", color: disabled ? "#555" : "#4a9eff",
        cursor: disabled ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap",
        ...style,
      }}
    >
      {label}
    </button>
  );
}

function Addr({ value }: { value?: string }) {
  if (!value) return <span style={{ color: "#555" }}>—</span>;
  return (
    <span style={{ fontFamily: "monospace", color: "#e0e0e0" }}>
      {value.slice(0, 8)}...{value.slice(-4)}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1, padding: "8px 12px", border: "1px solid #333", borderRadius: 6,
  background: "#111", color: "#e0e0e0", fontSize: 13, fontFamily: "monospace",
};
