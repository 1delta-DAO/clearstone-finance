import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { usePrograms } from "../hooks/usePrograms";
import {
  buildRefreshReserveIx,
  reserveCollateralMint,
  reserveCollateralSupply,
  reserveLiquiditySupply,
  lendingMarketAuthority,
  feeReceiver,
} from "../lib/klend";
import * as crypto from "crypto";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

function disc(name: string): Buffer {
  return Buffer.from(
    crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8)
  );
}

export default function LendingPanel() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { config } = usePrograms();

  const [depositAmt, setDepositAmt] = useState("");
  const [borrowAmt, setBorrowAmt] = useState("");
  const [dUsdyBalance, setDUsdyBalance] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [isWhitelisted, setIsWhitelisted] = useState<boolean | null>(null);
  const [status, setStatus] = useState<{ msg: string; type: "info" | "ok" | "err" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [obligationAddr, setObligationAddr] = useState<string | null>(null);

  const showStatus = (msg: string, type: "info" | "ok" | "err" = "info") => {
    setStatus({ msg, type });
    if (type !== "info") setTimeout(() => setStatus(null), 10000);
  };

  // Derive obligation PDA
  const getObligationPda = useCallback(() => {
    if (!publicKey) return null;
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from([0]), Buffer.from([0]), publicKey.toBuffer(), config.market.lendingMarket.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
      KLEND
    );
    return pda;
  }, [publicKey, config]);

  // Fetch balances + obligation status
  useEffect(() => {
    if (!publicKey || !connected) return;
    let cancelled = false;

    (async () => {
      try {
        const dUsdyAta = getAssociatedTokenAddressSync(config.pool.wrappedMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const dBal = await connection.getTokenAccountBalance(dUsdyAta).catch(() => null);
        if (!cancelled) setDUsdyBalance(dBal ? (Number(dBal.value.amount) / 1e6).toFixed(2) : "0.00");

        try {
          const usdcAta = getAssociatedTokenAddressSync(config.market.usdcMint, publicKey, false, TOKEN_PROGRAM_ID);
          const uBal = await connection.getTokenAccountBalance(usdcAta).catch(() => null);
          if (!cancelled) setUsdcBalance(uBal ? (Number(uBal.value.amount) / 1e6).toFixed(2) : "0.00");
        } catch { if (!cancelled) setUsdcBalance("0.00"); }

        const [wlEntry] = PublicKey.findProgramAddressSync(
          [Buffer.from("whitelist"), config.pool.dmMintConfig.toBuffer(), publicKey.toBuffer()],
          config.programs.deltaMint
        );
        const wlInfo = await connection.getAccountInfo(wlEntry);
        if (!cancelled) setIsWhitelisted(!!wlInfo);

        const obPda = getObligationPda();
        if (obPda) {
          const obInfo = await connection.getAccountInfo(obPda);
          if (!cancelled) setObligationAddr(obInfo ? obPda.toBase58() : null);
        }
      } catch {
        if (!cancelled) { setDUsdyBalance("0.00"); setIsWhitelisted(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [publicKey, connected, connection, config, getObligationPda]);

  // --- Deposit dUSDY as collateral ---
  const handleDeposit = useCallback(async () => {
    if (!publicKey || !depositAmt || Number(depositAmt) <= 0) return;
    setLoading(true);
    showStatus("Depositing dUSDY collateral...");

    try {
      const market = config.market.lendingMarket;
      const reserve = config.market.dUsdyReserve;
      const oracle = config.oracles.dUsdyOracle;
      const dUsdyMint = config.pool.wrappedMint;
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND);
      const obPda = getObligationPda()!;
      const dUsdyAta = getAssociatedTokenAddressSync(dUsdyMint, publicKey, false, TOKEN_2022_PROGRAM_ID);
      const amount = Buffer.alloc(8);
      amount.writeBigUInt64LE(BigInt(Math.floor(Number(depositAmt) * 1e6)), 0);

      const tx = new Transaction();

      // Create obligation if needed
      if (!obligationAddr) {
        // UserMetadata
        const [userMeta] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), publicKey.toBuffer()], KLEND);
        const metaInfo = await connection.getAccountInfo(userMeta);
        if (!metaInfo) {
          tx.add({
            programId: KLEND,
            data: Buffer.concat([disc("init_user_metadata"), PublicKey.default.toBuffer()]),
            keys: [
              { pubkey: publicKey, isSigner: true, isWritable: false },
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: userMeta, isSigner: false, isWritable: true },
              { pubkey: KLEND, isSigner: false, isWritable: false },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
          });
        }
        // InitObligation
        tx.add({
          programId: KLEND,
          data: Buffer.concat([disc("init_obligation"), Buffer.from([0, 0])]),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: obPda, isSigner: false, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: false },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: userMeta, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
        });
      }

      // RefreshReserve → RefreshObligation → Deposit
      tx.add(buildRefreshReserveIx(reserve, market, oracle));
      tx.add({
        programId: KLEND, data: disc("refresh_obligation"),
        keys: [
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          // remaining: one per existing deposit (none if new obligation)
          ...(obligationAddr ? [{ pubkey: reserve, isSigner: false, isWritable: false }] : []),
        ],
      });
      tx.add({
        programId: KLEND,
        data: Buffer.concat([disc("deposit_reserve_liquidity_and_obligation_collateral"), amount]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: lma, isSigner: false, isWritable: false },
          { pubkey: reserve, isSigner: false, isWritable: true },
          { pubkey: dUsdyMint, isSigner: false, isWritable: false },
          { pubkey: reserveLiquiditySupply(reserve), isSigner: false, isWritable: true },
          { pubkey: reserveCollateralMint(reserve), isSigner: false, isWritable: true },
          { pubkey: reserveCollateralSupply(reserve), isSigner: false, isWritable: true },
          { pubkey: dUsdyAta, isSigner: false, isWritable: true },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
      });

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      showStatus(`Deposited ${depositAmt} dUSDY! Tx: ${sig.slice(0, 20)}...`, "ok");
      setDepositAmt("");
      setObligationAddr(obPda.toBase58());
    } catch (e: any) {
      showStatus(`Deposit failed: ${e.message?.slice(0, 100)}`, "err");
    }
    setLoading(false);
  }, [publicKey, depositAmt, connection, config, sendTransaction, getObligationPda, obligationAddr]);

  // --- Borrow USDC ---
  const handleBorrow = useCallback(async () => {
    if (!publicKey || !borrowAmt || Number(borrowAmt) <= 0 || !obligationAddr) return;
    setLoading(true);
    showStatus("Borrowing USDC...");

    try {
      const market = config.market.lendingMarket;
      const dUsdyReserve = config.market.dUsdyReserve;
      const usdcReserve = config.market.usdcReserve;
      const dUsdyOracle = config.oracles.dUsdyOracle;
      const usdcOracle = config.oracles.usdcOracle;
      const usdcMint = config.market.usdcMint;
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND);
      const obPda = new PublicKey(obligationAddr);
      const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, publicKey, false, TOKEN_PROGRAM_ID);
      const amount = Buffer.alloc(8);
      amount.writeBigUInt64LE(BigInt(Math.floor(Number(borrowAmt) * 1e6)), 0);

      const tx = new Transaction();

      // Create USDC ATA if needed
      const ataInfo = await connection.getAccountInfo(userUsdcAta);
      if (!ataInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, userUsdcAta, publicKey, usdcMint));
      }

      // RefreshReserve (collateral) → RefreshReserve (borrow) → RefreshObligation → Borrow
      tx.add(buildRefreshReserveIx(dUsdyReserve, market, dUsdyOracle));
      tx.add(buildRefreshReserveIx(usdcReserve, market, usdcOracle));
      tx.add({
        programId: KLEND, data: disc("refresh_obligation"),
        keys: [
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: dUsdyReserve, isSigner: false, isWritable: false },
        ],
      });
      tx.add({
        programId: KLEND,
        data: Buffer.concat([disc("borrow_obligation_liquidity"), amount]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: market, isSigner: false, isWritable: false },
          { pubkey: lma, isSigner: false, isWritable: false },
          { pubkey: usdcReserve, isSigner: false, isWritable: true },
          { pubkey: usdcMint, isSigner: false, isWritable: false },
          { pubkey: reserveLiquiditySupply(usdcReserve), isSigner: false, isWritable: true },
          { pubkey: feeReceiver(usdcReserve), isSigner: false, isWritable: true },
          { pubkey: userUsdcAta, isSigner: false, isWritable: true },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
      });

      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      showStatus(`Borrowed ${borrowAmt} USDC! Tx: ${sig.slice(0, 20)}...`, "ok");
      setBorrowAmt("");
    } catch (e: any) {
      showStatus(`Borrow failed: ${e.message?.slice(0, 100)}`, "err");
    }
    setLoading(false);
  }, [publicKey, borrowAmt, connection, config, sendTransaction, obligationAddr]);

  if (!connected) {
    return (
      <Card title="Connect Wallet">
        <p style={{ color: "#888" }}>Connect your wallet to access lending operations.</p>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {status && (
        <div style={{
          padding: "10px 16px", borderRadius: 6, fontSize: 13, fontFamily: "monospace", wordBreak: "break-all",
          background: status.type === "ok" ? "#1a3a1a" : status.type === "err" ? "#3a1a1a" : "#1a1a3a",
          border: `1px solid ${status.type === "ok" ? "#4caf50" : status.type === "err" ? "#f44336" : "#4a9eff"}`,
          color: status.type === "ok" ? "#4caf50" : status.type === "err" ? "#f44336" : "#4a9eff",
        }}>
          {status.msg}
        </div>
      )}

      <Card title="Your Position">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16, textAlign: "center" }}>
          <StatBox label="dUSDY Balance" value={dUsdyBalance ?? "..."} unit="dUSDY" />
          <StatBox label="USDC Balance" value={usdcBalance ?? "..."} unit="USDC" />
          <StatBox label="KYC Status" value={isWhitelisted ? "Approved" : "Not KYC'd"} color={isWhitelisted ? "#4caf50" : "#f44336"} />
          <StatBox label="Obligation" value={obligationAddr ? "Active" : "None"} color={obligationAddr ? "#4caf50" : "#888"} />
        </div>
      </Card>

      {!isWhitelisted && isWhitelisted !== null && (
        <div style={{ padding: "12px 16px", borderRadius: 6, background: "#3a2a1a", border: "1px solid #ff9800", color: "#ff9800", fontSize: 13 }}>
          Your wallet is not KYC-whitelisted. Contact the market administrator.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card title="Deposit dUSDY Collateral">
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
            Deposit dUSDY as collateral to borrow USDC. Creates an obligation if needed.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="Amount" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} style={inputStyle} type="number" />
            <ActionButton label={loading ? "..." : "Deposit"} color="#4caf50" onClick={handleDeposit} disabled={loading} />
          </div>
          <MaxButton label={`Wallet: ${dUsdyBalance ?? "—"} dUSDY`} onClick={() => setDepositAmt(dUsdyBalance || "")} />
        </Card>

        <Card title="Borrow USDC">
          <p style={{ color: "#888", fontSize: 13, margin: "0 0 12px" }}>
            Borrow USDC against your dUSDY collateral (75% LTV).
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="Amount" value={borrowAmt} onChange={(e) => setBorrowAmt(e.target.value)} style={inputStyle} type="number" />
            <ActionButton label={loading ? "..." : "Borrow"} color="#ff9800" onClick={handleBorrow} disabled={loading || !obligationAddr} />
          </div>
          {!obligationAddr && <p style={{ fontSize: 11, color: "#666", marginTop: 6 }}>Deposit first to create an obligation</p>}
        </Card>
      </div>

      {/* Wrapped Tokens */}
      {config.tokens && config.tokens.length > 0 && (
        <Card title="Available Wrapped Tokens (KYC-gated)">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333", color: "#888" }}>
                <th style={{ textAlign: "left", padding: "6px 0" }}>d-Token</th>
                <th style={{ textAlign: "left" }}>Underlying</th>
                <th style={{ textAlign: "right" }}>Price</th>
                <th style={{ textAlign: "right" }}>Oracle</th>
                <th style={{ textAlign: "right" }}>Pool</th>
              </tr>
            </thead>
            <tbody>
              {config.tokens.map((t: any) => (
                <tr key={t.symbol} style={{ borderBottom: "1px solid #222" }}>
                  <td style={{ padding: "8px 0", fontWeight: 600, color: "#4caf50" }}>d{t.symbol}</td>
                  <td style={{ color: "#aaa" }}>{t.name}</td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>${t.price >= 100 ? t.price.toFixed(2) : t.price.toFixed(4)}</td>
                  <td style={{ textAlign: "right" }}><Addr value={t.oracle?.toBase58()} /></td>
                  <td style={{ textAlign: "right" }}><Addr value={t.pool?.toBase58()} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card title="Market Info">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 12, color: "#666" }}>
          <span>Market:</span><Addr value={config.market.lendingMarket.toBase58()} />
          <span>dUSDY Reserve:</span><Addr value={config.market.dUsdyReserve.toBase58()} />
          <span>USDC Reserve:</span><Addr value={config.market.usdcReserve.toBase58()} />
          <span>dUSDY Oracle:</span><Addr value={config.oracles.dUsdyOracle.toBase58()} />
          <span>USDC Oracle:</span><Addr value={config.oracles.usdcOracle.toBase58()} />
          {obligationAddr && <><span>Obligation:</span><Addr value={obligationAddr} /></>}
        </div>
      </Card>
    </div>
  );
}

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
      <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>{unit && <span style={{ color: "#666" }}>{unit} </span>}{label}</div>
    </div>
  );
}

function ActionButton({ label, onClick, color, disabled }: { label: string; onClick: () => void; color: string; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "8px 20px", border: `1px solid ${color}`, borderRadius: 6,
      background: `${color}22`, color, cursor: disabled ? "not-allowed" : "pointer",
      fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", opacity: disabled ? 0.5 : 1,
    }}>
      {label}
    </button>
  );
}

function MaxButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}><span onClick={onClick} style={{ cursor: "pointer", textDecoration: "underline" }}>{label}</span></div>;
}

function Addr({ value }: { value?: string }) {
  if (!value) return <span>—</span>;
  return <span style={{ fontFamily: "monospace", color: "#aaa" }}>{value.slice(0, 8)}...{value.slice(-4)}</span>;
}

const inputStyle: React.CSSProperties = {
  flex: 1, padding: "8px 12px", border: "1px solid #333", borderRadius: 6,
  background: "#111", color: "#e0e0e0", fontSize: 14, fontFamily: "monospace",
};
