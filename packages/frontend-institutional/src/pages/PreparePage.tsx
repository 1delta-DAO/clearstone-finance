import { useState, useEffect, useCallback } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";

// Solstice tokens
const SOLSTICE_USDC = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");
const SOLSTICE_USDT = new PublicKey("5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft");
const USX = new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS");
const EUSX = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");
const DEUSX = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");

// Programs
const GOVERNOR = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const DELTA_MINT = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");

// eUSX pool
const EUSX_POOL = new PublicKey("5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj");
const EUSX_DM_CONFIG = new PublicKey("JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD");

// Solstice API — use Vite proxy in dev to avoid CORS
const SOLSTICE_API_PROXY = "/api/solstice"; // proxied to instructions.solstice.finance/v1/instructions
const SOLSTICE_API_DIRECT = "https://instructions.solstice.finance/v1/instructions";

type Step = "idle" | "minting_usx" | "locking_eusx" | "wrapping_deusx" | "done";

/** Call Solstice API, parse instruction response into a Transaction */
async function callSolstice(
  apiKey: string,
  body: object,
  connection: import("@solana/web3.js").Connection,
  publicKey: PublicKey,
): Promise<Transaction> {
  // Try proxy first (dev mode), fall back to direct (may fail with CORS)
  let resp: Response | null = null;
  let lastError = "";

  for (const url of [SOLSTICE_API_PROXY, SOLSTICE_API_DIRECT]) {
    const label = url.startsWith("/") ? "proxy" : "direct";
    console.log(`[Solstice] Trying ${label}: ${url}`, { apiKey: apiKey ? "***" + apiKey.slice(-4) : "EMPTY" });
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(body),
      });
      console.log(`[Solstice] ${label} responded: ${resp.status}`);
      if (resp.ok) break;
      const errBody = await resp.text();
      lastError = `HTTP ${resp.status}: ${errBody.slice(0, 150)}`;
      console.warn(`[Solstice] ${label} error:`, lastError);
      resp = null;
    } catch (e: any) {
      lastError = `${label}: ${e.message || "Failed to fetch"}`;
      console.warn(`[Solstice] ${label} fetch error:`, e.message);
      resp = null;
      continue;
    }
  }

  if (!resp || !resp.ok) {
    throw new Error(`Solstice API failed — ${lastError}`);
  }

  const result = await resp.json();

  // Handle different response formats
  if (result.transaction) {
    // Full serialized transaction
    return Transaction.from(Buffer.from(result.transaction, "base64"));
  }

  if (result.instruction) {
    // Raw instruction: { program_id: number[], accounts: [...], data: number[] }
    const ix = result.instruction;
    const programId = new PublicKey(Buffer.from(ix.program_id));
    const keys = ix.accounts.map((acc: any) => ({
      pubkey: new PublicKey(Buffer.from(acc.pubkey)),
      isSigner: acc.is_signer,
      isWritable: acc.is_writable,
    }));
    const data = Buffer.from(ix.data);

    const tx = new Transaction();
    tx.add({ programId, keys, data });

    // Set recentBlockhash and feePayer — required for wallet to sign
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = publicKey;

    return tx;
  }

  throw new Error(`Unexpected Solstice API response: ${JSON.stringify(result).slice(0, 150)}`);
}

interface Balances {
  usdc: number;
  usdt: number;
  usx: number;
  eusx: number;
  deusx: number;
}

export default function PreparePage() {
  const { publicKey, connected, sendTransaction, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [balances, setBalances] = useState<Balances>({ usdc: 0, usdt: 0, usx: 0, eusx: 0, deusx: 0 });
  const [amount, setAmount] = useState("");
  const [collateral, setCollateral] = useState<"usdc" | "usdt">("usdc");
  const [step, setStep] = useState<Step>("idle");
  const [status, setStatus] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_SOLSTICE_API_KEY || "");

  /** Sign transaction with wallet then send raw — avoids wallet adapter issues with duplicate signers */
  async function signAndSend(tx: Transaction): Promise<string> {
    if (!signTransaction || !publicKey) throw new Error("Wallet not connected");
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  const loadBalances = useCallback(async () => {
    if (!publicKey) return;
    const bals: Balances = { usdc: 0, usdt: 0, usx: 0, eusx: 0, deusx: 0 };

    const tokens: [keyof Balances, PublicKey, PublicKey][] = [
      ["usdc", SOLSTICE_USDC, TOKEN_PROGRAM_ID],
      ["usdt", SOLSTICE_USDT, TOKEN_PROGRAM_ID],
      ["usx", USX, TOKEN_PROGRAM_ID],
      ["eusx", EUSX, TOKEN_PROGRAM_ID],
      ["deusx", DEUSX, TOKEN_2022_PROGRAM_ID],
    ];

    for (const [key, mint, prog] of tokens) {
      try {
        const ata = getAssociatedTokenAddressSync(mint, publicKey, false, prog);
        const info = await connection.getAccountInfo(ata);
        if (info) bals[key] = Number(info.data.readBigUInt64LE(64)) / 1e6;
      } catch {}
    }
    setBalances(bals);
  }, [publicKey, connection]);

  useEffect(() => { loadBalances(); }, [loadBalances]);

  // Step 1: Mint USX from USDC/USDT via Solstice API
  // Combines RequestMint + ConfirmMint into a single transaction
  async function handleMintUSX() {
    if (!publicKey || !amount || !apiKey) return;
    setLoading(true);
    setStep("minting_usx");
    setStatus({ msg: `Preparing USX mint from ${collateral.toUpperCase()}...`, type: "info" });

    try {
      // Fetch both instructions from Solstice API
      // API expects amount in base units (lamports): 1 USDC = 1000000
      const amountLamports = Math.floor(parseFloat(amount) * 1_000_000);
      const [reqTx, confTx] = await Promise.all([
        callSolstice(apiKey, {
          type: "RequestMint",
          data: { amount: amountLamports, collateral, user: publicKey.toBase58() },
        }, connection, publicKey),
        callSolstice(apiKey, {
          type: "ConfirmMint",
          data: { user: publicKey.toBase58(), collateral },
        }, connection, publicKey),
      ]);

      // Ensure USX ATA exists (ConfirmMint needs it)
      const USX_MINT = new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS");
      const usxAta = getAssociatedTokenAddressSync(USX_MINT, publicKey, false, TOKEN_PROGRAM_ID);
      const usxAtaInfo = await connection.getAccountInfo(usxAta);

      const combinedTx = new Transaction();
      if (!usxAtaInfo) {
        combinedTx.add(createAssociatedTokenAccountInstruction(publicKey, usxAta, publicKey, USX_MINT, TOKEN_PROGRAM_ID));
      }
      for (const ix of reqTx.instructions) combinedTx.add(ix);
      for (const ix of confTx.instructions) combinedTx.add(ix);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      combinedTx.recentBlockhash = blockhash;
      combinedTx.lastValidBlockHeight = lastValidBlockHeight;
      combinedTx.feePayer = publicKey;

      setStatus({ msg: "Sign mint transaction in your wallet...", type: "info" });
      const sig = await signAndSend(combinedTx);
      setStatus({ msg: `Minted ${amount} USX from ${collateral.toUpperCase()} (tx: ${sig.slice(0, 16)}...)`, type: "success" });

      await loadBalances();
    } catch (e: any) {
      const detail = e.message || "Unknown error";
      setStatus({ msg: `Mint failed: ${detail.slice(0, 150)}`, type: "error" });
    } finally {
      setLoading(false);
      setStep("idle");
    }
  }

  // Step 2: Lock USX → eUSX via Solstice API
  async function handleLockUSX() {
    if (!publicKey || !apiKey) return;
    setLoading(true);
    setStep("locking_eusx");
    setStatus({ msg: "Locking USX in YieldVault for eUSX...", type: "info" });

    try {
      const lockAmount = balances.usx;
      const lockLamports = Math.floor(lockAmount * 1_000_000);
      const lockIxTx = await callSolstice(apiKey, {
        type: "Lock",
        data: { amount: lockLamports, user: publicKey.toBase58() },
      }, connection, publicKey);

      // Ensure eUSX ATA exists
      const EUSX_MINT = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");
      const eusxAta = getAssociatedTokenAddressSync(EUSX_MINT, publicKey, false, TOKEN_PROGRAM_ID);
      const eusxAtaInfo = await connection.getAccountInfo(eusxAta);

      const tx = new Transaction();
      if (!eusxAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, eusxAta, publicKey, EUSX_MINT, TOKEN_PROGRAM_ID));
      }
      for (const ix of lockIxTx.instructions) tx.add(ix);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = publicKey;

      setStatus({ msg: "Sign lock transaction in your wallet...", type: "info" });
      const sig = await signAndSend(tx);
      setStatus({ msg: `Locked ${lockAmount.toFixed(2)} USX → eUSX (tx: ${sig.slice(0, 16)}...)`, type: "success" });
      await loadBalances();
    } catch (e: any) {
      const detail = e.message || "Unknown error";
      setStatus({ msg: `Lock failed: ${detail.slice(0, 150)}`, type: "error" });
    } finally {
      setLoading(false);
      setStep("idle");
    }
  }

  // Step 3: Wrap eUSX → ceUSX via Governor
  async function handleWrapEUSX() {
    if (!publicKey) return;
    setLoading(true);
    setStep("wrapping_deusx");
    setStatus({ msg: "Wrapping eUSX → ceUSX (KYC-gated)...", type: "info" });

    try {
      const wrapAmount = Math.floor(balances.eusx * 1e6);
      if (wrapAmount <= 0) throw new Error("No eUSX to wrap");

      const [dmAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority"), DEUSX.toBuffer()], DELTA_MINT
      );
      const [whitelistEntry] = PublicKey.findProgramAddressSync(
        [Buffer.from("whitelist"), EUSX_DM_CONFIG.toBuffer(), publicKey.toBuffer()], DELTA_MINT
      );

      const userEusxAta = getAssociatedTokenAddressSync(EUSX, publicKey, false, TOKEN_PROGRAM_ID);
      const vaultAta = getAssociatedTokenAddressSync(EUSX, EUSX_POOL, true, TOKEN_PROGRAM_ID);
      const userDeusxAta = getAssociatedTokenAddressSync(DEUSX, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const tx = new Transaction();

      // Create ceUSX ATA if needed
      const deusxAtaInfo = await connection.getAccountInfo(userDeusxAta);
      if (!deusxAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(
          publicKey, userDeusxAta, publicKey, DEUSX, TOKEN_2022_PROGRAM_ID
        ));
      }

      // Load governor IDL and call wrap
      // For simplicity, build the instruction manually using Anchor discriminator
      // Precomputed: sha256("global:wrap")[0..8] = b2280abde481ba8c
      const wrapDisc = Buffer.from([178, 40, 10, 189, 228, 129, 186, 140]);
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(BigInt(wrapAmount), 0);

      tx.add({
        programId: GOVERNOR,
        data: Buffer.concat([wrapDisc, amountBuf]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: EUSX_POOL, isSigner: false, isWritable: true },
          { pubkey: EUSX, isSigner: false, isWritable: false },    // underlying_mint
          { pubkey: userEusxAta, isSigner: false, isWritable: true }, // user_underlying_ata
          { pubkey: vaultAta, isSigner: false, isWritable: true },  // vault
          { pubkey: EUSX_DM_CONFIG, isSigner: false, isWritable: false }, // dm_mint_config
          { pubkey: DEUSX, isSigner: false, isWritable: true },     // wrapped_mint
          { pubkey: dmAuthority, isSigner: false, isWritable: false }, // dm_mint_authority
          { pubkey: whitelistEntry, isSigner: false, isWritable: false },
          { pubkey: userDeusxAta, isSigner: false, isWritable: true }, // user_wrapped_ata
          { pubkey: DELTA_MINT, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // underlying_token_program
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // wrapped_token_program
        ],
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = publicKey;

      setStatus({ msg: "Sign wrap transaction...", type: "info" });
      const sig = await signAndSend(tx);
      setStatus({ msg: `Wrapped ${(wrapAmount / 1e6).toFixed(2)} eUSX → ceUSX`, type: "success" });
      await loadBalances();
    } catch (e: any) {
      setStatus({ msg: e.message?.slice(0, 120) || "Wrap failed", type: "error" });
    } finally {
      setLoading(false);
      setStep("idle");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <span className="eyebrow">Onboard</span>
        <h2 className="text-2xl mt-1">Prepare Collateral</h2>
        <p className="text-sm text-base-content/55 mt-1">
          Convert stablecoins into yield-bearing KYC-gated collateral (ceUSX).
        </p>
      </div>

      {/* API Key — only show input if not loaded from env */}
      {apiKey ? null : (
      <div className="panel">
        <div className="card-body p-5">
          <div className="flex items-center gap-3">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-warning shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
            <input
              className="input input-bordered bg-base-300 text-base-content flex-1 font-mono text-sm"
              placeholder="Paste Solstice API Key"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              type="password"
            />
          </div>
          <p className="text-xs text-base-content/40 mt-1">
            Set <code>VITE_SOLSTICE_API_KEY</code> in <code>.env</code> to auto-load, or paste here
          </p>
        </div>
      </div>
      )}

      {/* Balances Overview */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: "USDC", value: balances.usdc, color: "text-info" },
          { label: "USDT", value: balances.usdt, color: "text-success" },
          { label: "USX", value: balances.usx, color: "text-primary" },
          { label: "eUSX", value: balances.eusx, color: "text-warning" },
          { label: "ceUSX", value: balances.deusx, color: "text-accent" },
        ].map(t => (
          <div key={t.label} className="panel">
            <div className="card-body p-4 items-center text-center gap-1">
              <div className="text-xs text-base-content/50">{t.label}</div>
              <div className={`text-lg font-bold font-mono ${t.color}`}>
                {t.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Pipeline Steps */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Step 1: Mint USX */}
        <div className="panel">
          <div className="card-body p-6 gap-4">
            <div className="flex items-center gap-2">
              <div className="badge badge-primary badge-lg font-bold">1</div>
              <h3 className="font-bold">Mint USX</h3>
            </div>
            <p className="text-xs text-base-content/50">
              Deposit {collateral.toUpperCase()} → receive USX stablecoin (1:1) via Solstice
            </p>

            {/* Collateral selector */}
            <div className="flex gap-1 bg-base-300 rounded-lg p-1">
              <button
                className={`flex-1 btn btn-sm ${collateral === "usdc" ? "btn-info" : "btn-ghost"}`}
                onClick={() => setCollateral("usdc")}
              >
                USDC ({balances.usdc.toFixed(0)})
              </button>
              <button
                className={`flex-1 btn btn-sm ${collateral === "usdt" ? "btn-success" : "btn-ghost"}`}
                onClick={() => setCollateral("usdt")}
              >
                USDT ({balances.usdt.toFixed(0)})
              </button>
            </div>

            <input
              className="input input-bordered bg-base-300 text-base-content w-full font-mono"
              placeholder="Amount"
              value={amount}
              onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
            />
            <button
              className="btn btn-primary w-full"
              onClick={handleMintUSX}
              disabled={loading || !amount || !apiKey || parseFloat(amount) <= 0 || balances[collateral] < parseFloat(amount || "0")}
            >
              {step === "minting_usx"
                ? <span className="loading loading-spinner loading-sm" />
                : `Mint USX from ${collateral.toUpperCase()}`}
            </button>
          </div>
        </div>

        {/* Step 2: Lock → eUSX */}
        <div className="panel">
          <div className="card-body p-6 gap-4">
            <div className="flex items-center gap-2">
              <div className="badge badge-warning badge-lg font-bold">2</div>
              <h3 className="font-bold">Lock for eUSX</h3>
            </div>
            <p className="text-xs text-base-content/50">
              Lock USX in YieldVault → receive eUSX (yield-bearing, ~10% APY)
            </p>
            <div className="bg-base-300 rounded-lg p-3 text-center">
              <span className="text-sm text-base-content/50">Available: </span>
              <span className="font-mono font-bold">{balances.usx.toFixed(2)} USX</span>
            </div>
            <button
              className="btn btn-warning w-full"
              onClick={handleLockUSX}
              disabled={loading || balances.usx <= 0 || !apiKey}
            >
              {step === "locking_eusx" ? <span className="loading loading-spinner loading-sm" /> : `Lock ${balances.usx.toFixed(2)} USX → eUSX`}
            </button>
          </div>
        </div>

        {/* Step 3: Wrap → ceUSX */}
        <div className="panel">
          <div className="card-body p-6 gap-4">
            <div className="flex items-center gap-2">
              <div className="badge badge-accent badge-lg font-bold">3</div>
              <h3 className="font-bold">KYC Wrap</h3>
            </div>
            <p className="text-xs text-base-content/50">
              Wrap eUSX → ceUSX (KYC-gated collateral). Requires whitelist approval.
            </p>
            <div className="bg-base-300 rounded-lg p-3 text-center">
              <span className="text-sm text-base-content/50">Available: </span>
              <span className="font-mono font-bold">{balances.eusx.toFixed(2)} eUSX</span>
            </div>
            <button
              className="btn btn-accent w-full"
              onClick={handleWrapEUSX}
              disabled={loading || balances.eusx <= 0}
            >
              {step === "wrapping_deusx" ? <span className="loading loading-spinner loading-sm" /> : `Wrap ${balances.eusx.toFixed(2)} eUSX → ceUSX`}
            </button>
          </div>
        </div>
      </div>

      {/* Status */}
      {status && (
        <div className={`alert ${status.type === "success" ? "alert-success" : status.type === "error" ? "alert-error" : "alert-info"}`}>
          {status.type === "success" && <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
          {status.type === "error" && <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
          {status.type === "info" && <span className="loading loading-spinner loading-sm" />}
          <span className="text-sm">{status.msg}</span>
        </div>
      )}

      {/* Direct eUSX wrap (skip steps 1-2 if you already have eUSX) */}
      {balances.eusx > 0 && (
        <div className="alert alert-info">
          <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span className="text-sm">
            You have {balances.eusx.toFixed(2)} eUSX. Skip to Step 3 to wrap directly into ceUSX collateral.
          </span>
        </div>
      )}

      {balances.deusx > 0 && (
        <div className="alert alert-success">
          <svg xmlns="http://www.w3.org/2000/svg" className="stroke-current shrink-0 h-5 w-5" fill="none" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span className="text-sm">
            You have {balances.deusx.toFixed(2)} ceUSX ready to deposit as collateral.
            Go to <strong>Supply Collateral</strong> tab.
          </span>
        </div>
      )}
    </div>
  );
}
