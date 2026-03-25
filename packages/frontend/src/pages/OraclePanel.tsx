import { useState, useCallback, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { usePrograms } from "../hooks/usePrograms";
import { Program, BN } from "@coral-xyz/anchor";
import * as crypto from "crypto";

const MOCK_ORACLE = new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm");
const PRICE_UPDATE_V2_DISC = Buffer.from("22f123639d7ef4cd", "hex");
const PRICE_UPDATE_V2_SIZE = 133;

function buildPriceUpdateV2(
  authority: PublicKey,
  price: number,
  expo: number,
  slot: number,
  timestamp: number
): Buffer {
  const buf = Buffer.alloc(PRICE_UPDATE_V2_SIZE);
  let off = 0;
  PRICE_UPDATE_V2_DISC.copy(buf, off); off += 8;
  authority.toBuffer().copy(buf, off); off += 32;
  buf.writeUInt8(1, off); off += 1; // Full verification
  Buffer.from("TradeDesk Oracle Feed").copy(buf, off); off += 32;
  buf.writeBigInt64LE(BigInt(Math.round(price * Math.pow(10, Math.abs(expo)))), off); off += 8;
  buf.writeBigUInt64LE(BigInt(10000), off); off += 8;
  buf.writeInt32LE(expo, off); off += 4;
  buf.writeBigInt64LE(BigInt(timestamp), off); off += 8;
  buf.writeBigInt64LE(BigInt(timestamp - 1), off); off += 8;
  buf.writeBigInt64LE(BigInt(Math.round(price * Math.pow(10, Math.abs(expo)))), off); off += 8;
  buf.writeBigUInt64LE(BigInt(10000), off); off += 8;
  buf.writeBigUInt64LE(BigInt(slot), off);
  return buf;
}

interface FeedInfo {
  address: string;
  label: string;
  price: string;
  lastUpdate: string;
}

export default function OraclePanel() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { config, ready } = usePrograms();

  const [feeds, setFeeds] = useState<FeedInfo[]>([]);
  const [newLabel, setNewLabel] = useState("USDY/USD");
  const [newPrice, setNewPrice] = useState("1.08");
  const [status, setStatus] = useState<{ msg: string; type: "info" | "ok" | "err" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [updateAddr, setUpdateAddr] = useState("");
  const [updatePrice, setUpdatePrice] = useState("");

  const showStatus = (msg: string, type: "info" | "ok" | "err" = "info") => {
    setStatus({ msg, type });
    if (type !== "info") setTimeout(() => setStatus(null), 8000);
  };

  // Load feeds from config tokens + oracles
  useEffect(() => {
    if (!ready) return;

    const loadFeeds = async () => {
      const results: FeedInfo[] = [];

      // Load wrapped token oracles
      for (const token of config.tokens || []) {
        try {
          const info = await connection.getAccountInfo(token.oracle);
          if (!info) continue;
          const d = info.data;
          // PriceUpdateV2: disc(8) + authority(32) + verification(1) + feed_id(32) + price(8) + conf(8) + expo(4) + ts(8)
          const price = d.readBigInt64LE(73);
          const expo = d.readInt32LE(89);
          const ts = d.readBigInt64LE(93);
          const usd = Number(price) * Math.pow(10, expo);
          results.push({
            address: token.oracle.toBase58(),
            label: `d${token.symbol}/USD`,
            price: "$" + usd.toFixed(usd >= 100 ? 2 : 4),
            lastUpdate: new Date(Number(ts) * 1000).toISOString().replace("T", " ").slice(0, 19),
          });
        } catch {}
      }

      // Load USDC oracle
      try {
        const info = await connection.getAccountInfo(config.oracles.usdcOracle);
        if (info) {
          const d = info.data;
          const price = d.readBigInt64LE(73);
          const expo = d.readInt32LE(89);
          const usd = Number(price) * Math.pow(10, expo);
          results.push({
            address: config.oracles.usdcOracle.toBase58(),
            label: "USDC/USD",
            price: "$" + usd.toFixed(4),
            lastUpdate: new Date(Number(d.readBigInt64LE(93)) * 1000).toISOString().replace("T", " ").slice(0, 19),
          });
        }
      } catch {}

      // Load dUSDY oracle (legacy)
      try {
        const info = await connection.getAccountInfo(config.oracles.dUsdyOracle);
        if (info) {
          const d = info.data;
          const price = d.readBigInt64LE(73);
          const expo = d.readInt32LE(89);
          const usd = Number(price) * Math.pow(10, expo);
          results.push({
            address: config.oracles.dUsdyOracle.toBase58(),
            label: "dUSDY/USD (legacy)",
            price: "$" + usd.toFixed(4),
            lastUpdate: new Date(Number(d.readBigInt64LE(93)) * 1000).toISOString().replace("T", " ").slice(0, 19),
          });
        }
      } catch {}

      setFeeds(results);
    };

    loadFeeds();
  }, [ready, connection, config]);

  // Create a new PriceUpdateV2 oracle
  const handleCreateOracle = useCallback(async () => {
    if (!publicKey || !newLabel || !newPrice) return;
    setLoading(true);
    showStatus("Creating PriceUpdateV2 oracle...");

    try {
      const price = parseFloat(newPrice);
      const oracleKp = Keypair.generate();
      const slot = await connection.getSlot();
      const ts = Math.floor(Date.now() / 1000);

      // Step 1: Create account owned by mock-oracle program
      const rent = await connection.getMinimumBalanceForRentExemption(PRICE_UPDATE_V2_SIZE);
      const createIx = SystemProgram.createAccount({
        fromPubkey: publicKey,
        newAccountPubkey: oracleKp.publicKey,
        lamports: rent,
        space: PRICE_UPDATE_V2_SIZE,
        programId: MOCK_ORACLE,
      });

      // Step 2: Write PriceUpdateV2 data via writeRaw
      const data = buildPriceUpdateV2(publicKey, price, -8, slot, ts);
      const writeRawDisc = Buffer.from(
        crypto.createHash("sha256").update("global:write_raw").digest().subarray(0, 8)
      );
      // Borsh encode: offset(u32) + data(vec<u8> = len(u32) + bytes)
      const writeArgs = Buffer.alloc(4 + 4 + data.length);
      writeArgs.writeUInt32LE(0, 0); // offset
      writeArgs.writeUInt32LE(data.length, 4); // vec length
      data.copy(writeArgs, 8);

      const writeIx = new TransactionInstruction({
        programId: MOCK_ORACLE,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: oracleKp.publicKey, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([writeRawDisc, writeArgs]),
      });

      const tx = new Transaction().add(createIx, writeIx);
      const sig = await sendTransaction(tx, connection, { signers: [oracleKp] });
      await connection.confirmTransaction(sig, "confirmed");

      showStatus(`Oracle created: ${oracleKp.publicKey.toBase58()}`, "ok");

      // Add to feeds list
      setFeeds((prev) => [
        ...prev,
        {
          address: oracleKp.publicKey.toBase58(),
          label: `${newLabel} (PriceUpdateV2)`,
          price: "$" + price.toFixed(4),
          lastUpdate: new Date().toISOString().replace("T", " ").slice(0, 19),
        },
      ]);
    } catch (e: any) {
      showStatus(`Failed: ${e.message?.slice(0, 80)}`, "err");
    }
    setLoading(false);
  }, [publicKey, connection, sendTransaction, newLabel, newPrice]);

  // Update price on an existing PriceUpdateV2 oracle
  const handleUpdatePrice = useCallback(async () => {
    if (!publicKey || !updateAddr || !updatePrice) return;
    setLoading(true);
    showStatus("Updating oracle price...");

    try {
      const price = parseFloat(updatePrice);
      const oraclePk = new PublicKey(updateAddr);
      const slot = await connection.getSlot();
      const ts = Math.floor(Date.now() / 1000);
      const data = buildPriceUpdateV2(publicKey, price, -8, slot, ts);

      const writeRawDisc = Buffer.from(
        crypto.createHash("sha256").update("global:write_raw").digest().subarray(0, 8)
      );
      const writeArgs = Buffer.alloc(4 + 4 + data.length);
      writeArgs.writeUInt32LE(0, 0);
      writeArgs.writeUInt32LE(data.length, 4);
      data.copy(writeArgs, 8);

      const ix = new TransactionInstruction({
        programId: MOCK_ORACLE,
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: oraclePk, isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([writeRawDisc, writeArgs]),
      });

      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      showStatus(`Price updated to $${price.toFixed(4)}`, "ok");

      setFeeds((prev) =>
        prev.map((f) =>
          f.address === updateAddr
            ? { ...f, price: "$" + price.toFixed(4), lastUpdate: new Date().toISOString().replace("T", " ").slice(0, 19) }
            : f
        )
      );
    } catch (e: any) {
      showStatus(`Failed: ${e.message?.slice(0, 80)}`, "err");
    }
    setLoading(false);
  }, [publicKey, connection, sendTransaction, updateAddr, updatePrice]);

  if (!connected)
    return <p style={{ color: "#888" }}>Connect wallet to manage oracles.</p>;

  const cardStyle: React.CSSProperties = {
    border: "1px solid #333",
    borderRadius: 8,
    padding: 20,
    marginBottom: 16,
    background: "#111",
  };

  return (
    <div>
      <h2>TradeDesk Oracle Manager</h2>
      <p style={{ color: "#888", marginBottom: 24 }}>
        Create and manage PriceUpdateV2 oracles for klend integration.
        These oracles are owned by the TradeDesk program and accepted by klend's Pyth parser.
      </p>

      {status && (
        <div
          style={{
            padding: "10px 16px",
            borderRadius: 6,
            marginBottom: 16,
            background: status.type === "err" ? "#3a1a1a" : status.type === "ok" ? "#1a3a1a" : "#1a1a3a",
            border: `1px solid ${status.type === "err" ? "#f44" : status.type === "ok" ? "#4f4" : "#44f"}`,
            color: status.type === "err" ? "#f88" : status.type === "ok" ? "#8f8" : "#88f",
            fontSize: 13,
            wordBreak: "break-all",
          }}
        >
          {status.msg}
        </div>
      )}

      {/* Existing Feeds */}
      <div style={cardStyle}>
        <h3 style={{ margin: "0 0 12px" }}>Active Feeds</h3>
        {feeds.length === 0 ? (
          <p style={{ color: "#666" }}>No feeds found. Create one below.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333", color: "#888" }}>
                <th style={{ textAlign: "left", padding: "6px 0" }}>Label</th>
                <th style={{ textAlign: "right" }}>Price</th>
                <th style={{ textAlign: "right" }}>Last Update</th>
                <th style={{ textAlign: "right" }}>Address</th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <tr key={f.address} style={{ borderBottom: "1px solid #222" }}>
                  <td style={{ padding: "8px 0", fontWeight: 600 }}>{f.label}</td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>{f.price}</td>
                  <td style={{ textAlign: "right", color: "#888" }}>{f.lastUpdate}</td>
                  <td
                    style={{ textAlign: "right", fontFamily: "monospace", fontSize: 11, color: "#666", cursor: "pointer" }}
                    title={f.address}
                    onClick={() => { setUpdateAddr(f.address); setUpdatePrice(f.price.replace("$", "")); }}
                  >
                    {f.address.slice(0, 8)}...
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create New Oracle */}
      <div style={cardStyle}>
        <h3 style={{ margin: "0 0 12px" }}>Create PriceUpdateV2 Oracle</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            placeholder="Label (e.g. USDY/USD)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            style={{ flex: 1, padding: 8, background: "#1a1a1a", border: "1px solid #333", borderRadius: 4, color: "#fff" }}
          />
          <input
            placeholder="Price (e.g. 1.08)"
            value={newPrice}
            onChange={(e) => setNewPrice(e.target.value)}
            style={{ width: 120, padding: 8, background: "#1a1a1a", border: "1px solid #333", borderRadius: 4, color: "#fff" }}
          />
          <button
            onClick={handleCreateOracle}
            disabled={loading || !newLabel || !newPrice}
            style={{
              padding: "8px 16px",
              background: "#2563eb",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.5 : 1,
            }}
          >
            Create
          </button>
        </div>
        <p style={{ fontSize: 11, color: "#666", margin: 0 }}>
          Creates a Pyth-compatible PriceUpdateV2 account (133 bytes). Accepted by klend without owner validation.
        </p>
      </div>

      {/* Update Price */}
      <div style={cardStyle}>
        <h3 style={{ margin: "0 0 12px" }}>Update Oracle Price</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            placeholder="Oracle address"
            value={updateAddr}
            onChange={(e) => setUpdateAddr(e.target.value)}
            style={{ flex: 1, padding: 8, background: "#1a1a1a", border: "1px solid #333", borderRadius: 4, color: "#fff", fontFamily: "monospace", fontSize: 12 }}
          />
          <input
            placeholder="New price"
            value={updatePrice}
            onChange={(e) => setUpdatePrice(e.target.value)}
            style={{ width: 120, padding: 8, background: "#1a1a1a", border: "1px solid #333", borderRadius: 4, color: "#fff" }}
          />
          <button
            onClick={handleUpdatePrice}
            disabled={loading || !updateAddr || !updatePrice}
            style={{
              padding: "8px 16px",
              background: "#059669",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.5 : 1,
            }}
          >
            Update
          </button>
        </div>
        <p style={{ fontSize: 11, color: "#666", margin: 0 }}>
          Click a feed address above to auto-fill. Updates the PriceUpdateV2 data with current timestamp and slot.
        </p>
      </div>

      {/* Info */}
      <div style={{ ...cardStyle, background: "#0a0a1a", borderColor: "#224" }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>How it works</h3>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: "#888", lineHeight: 1.8 }}>
          <li>Oracles are PriceUpdateV2 accounts (Pyth Receiver format) owned by the TradeDesk program</li>
          <li>klend only checks the 8-byte discriminator (<code>22f12363...</code>), not the account owner</li>
          <li>Price, confidence, exponent, and timestamps are written in the standard Pyth layout</li>
          <li>Set <code>maxAgePriceSeconds = u64::MAX</code> on the reserve for static oracles</li>
          <li>Oracles can be updated by the wallet that created them via <code>writeRaw</code></li>
        </ul>
      </div>
    </div>
  );
}
