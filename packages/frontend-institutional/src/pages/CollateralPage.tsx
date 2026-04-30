import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey, Transaction, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_RENT_PUBKEY, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import { getObligationPda, findObligationReserves, OB_ID } from "../lib/obligation";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");

// Governor / delta-mint for wrap flow
const GOVERNOR = new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh");
const DELTA_MINT = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");
const EUSX_POOL = new PublicKey("5TbEz3YEsaMzzRPgUL6paz6t12Bk19fFkgHYDfMsXFxj");
const EUSX_DM_CONFIG = new PublicKey("JC7tZGUahP99HZ8NwmvZWGvnXJjLg5edyYPAnTBFquDD");
const EUSX_MINT = new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt");
const DEUSX_MINT = new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT");

// Precomputed Anchor discriminators (sha256("global:<name>")[0..8])
const DISC = {
  init_user_metadata: Buffer.from([117, 169, 176, 69, 197, 23, 15, 162]),
  init_obligation: Buffer.from([251, 10, 231, 76, 27, 11, 159, 96]),
  refresh_reserve: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]),
  refresh_obligation: Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]),
  deposit_reserve_liquidity_and_obligation_collateral: Buffer.from([129, 199, 4, 2, 222, 39, 26, 46]),
  wrap: Buffer.from([178, 40, 10, 189, 228, 129, 186, 140]),
};

interface CollateralAsset {
  name: string;
  symbol: string;
  mint: PublicKey;
  reserve: PublicKey;
  oracle: PublicKey;
  tokenProgram: PublicKey;
  price: number;
  yieldApy?: string;
}

const COLLATERAL_ASSETS: CollateralAsset[] = [
  {
    name: "ceUSX (yield-bearing eUSX)",
    symbol: "ceUSX",
    mint: DEUSX_MINT,
    reserve: new PublicKey("3FkBgVfnYBnUre6GMQZv8w4dDM1x7Fp5RiGk96kZ5mVs"),
    oracle: new PublicKey("6dbNQrjLVQxk1bJhbB6AiMFWzaf8G2d3LPjH69Je498A"),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    price: 1.08,
    yieldApy: "~10% APY",
  },
  {
    name: "dtUSDY (KYC-wrapped USDY)",
    symbol: "dtUSDY",
    mint: new PublicKey("6SV8ecHhfgWYHTiec2uDMPXHUXqqT2puNjR73gj6AvYu"),
    reserve: new PublicKey("HhTUuM5XwpnQchiUiLVNxUjPkHtfbcX4aF4bWKCSSAuT"),
    oracle: new PublicKey("4Xv1RpZQHZNHatTba3xUW4foLYUM6x36NxehihVcUnPQ"),
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    price: 1.08,
  },
];

export default function CollateralPage() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [selected, setSelected] = useState(0);
  const [amount, setAmount] = useState("");
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [obligationAddr, setObligationAddr] = useState<string | null>(null);

  const asset = COLLATERAL_ASSETS[selected];

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!signTransaction || !publicKey) throw new Error("Wallet not connected");
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  useEffect(() => {
    if (!publicKey) return;
    async function load() {
      const bals: Record<string, number> = {};
      for (const a of COLLATERAL_ASSETS) {
        try {
          const ata = getAssociatedTokenAddressSync(a.mint, publicKey!, false, a.tokenProgram);
          const info = await connection.getAccountInfo(ata);
          bals[a.symbol] = info ? Number(info.data.readBigUInt64LE(64)) / 1e6 : 0;
        } catch { bals[a.symbol] = 0; }
      }
      setBalances(bals);
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from([0]), Buffer.from([OB_ID]), publicKey!.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()], KLEND);
      const obInfo = await connection.getAccountInfo(obPda);
      if (obInfo) setObligationAddr(obPda.toBase58());
    }
    load();
  }, [publicKey, connection]);

  async function handleDeposit() {
    if (!publicKey || !amount) return;
    setLoading(true);
    setStatus({ msg: "Building deposit transaction...", type: "info" });
    try {
      const amountLamports = BigInt(Math.floor(parseFloat(amount) * 1e6));

      // Fresh balance check (don't trust React state — it may be stale)
      let freshBal = 0;
      try {
        const checkAta = getAssociatedTokenAddressSync(
          asset.symbol === "eUSX" ? DEUSX_MINT : asset.mint,
          publicKey, false,
          asset.symbol === "eUSX" ? TOKEN_2022_PROGRAM_ID : asset.tokenProgram
        );
        const checkInfo = await connection.getAccountInfo(checkAta);
        freshBal = checkInfo ? Number(checkInfo.data.readBigUInt64LE(64)) / 1e6 : 0;
      } catch {}

      if (parseFloat(amount) > freshBal) {
        setStatus({ msg: `Insufficient ${asset.symbol} balance. On-chain: ${freshBal.toFixed(2)}, requested: ${amount}. Go to Prepare Collateral to get more.`, type: "error" });
        setLoading(false);
        // Also refresh displayed balances
        const bals: Record<string, number> = {};
        for (const a of COLLATERAL_ASSETS) {
          try {
            const ata = getAssociatedTokenAddressSync(a.mint, publicKey, false, a.tokenProgram);
            const info = await connection.getAccountInfo(ata);
            bals[a.symbol] = info ? Number(info.data.readBigUInt64LE(64)) / 1e6 : 0;
          } catch { bals[a.symbol] = 0; }
        }
        setBalances(bals);
        return;
      }
      const tx = new Transaction();
      // Use id=1 to avoid conflicts with old obligations that have stranded reserve deposits
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from([0]), Buffer.from([OB_ID]), publicKey.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()], KLEND);
      const [userMeta] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), publicKey.toBuffer()], KLEND);

      // Check on-chain if obligation exists (don't rely on React state which may be stale)
      const obExistsOnChain = (await connection.getAccountInfo(obPda)) !== null;
      if (!obExistsOnChain) {
        const umInfo = await connection.getAccountInfo(userMeta);
        if (!umInfo) {
          tx.add({ programId: KLEND, data: Buffer.concat([DISC.init_user_metadata, Buffer.alloc(32)]), keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },     // owner
            { pubkey: publicKey, isSigner: true, isWritable: true },      // feePayer
            { pubkey: userMeta, isSigner: false, isWritable: true },      // userMetadata
            { pubkey: KLEND, isSigner: false, isWritable: false },        // referrerUserMetadata (None → program ID)
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ]});
        }
        tx.add({ programId: KLEND, data: Buffer.concat([DISC.init_obligation, Buffer.from([0, OB_ID])]), keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false }, { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: obPda, isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: PublicKey.default, isSigner: false, isWritable: false }, { pubkey: PublicKey.default, isSigner: false, isWritable: false },
          { pubkey: userMeta, isSigner: false, isWritable: true }, { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]});
      }

      // If eUSX selected: auto-wrap to ceUSX first
      if (asset.symbol === "eUSX") {
        const [dmAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint_authority"), DEUSX_MINT.toBuffer()], DELTA_MINT);
        const [whitelistEntry] = PublicKey.findProgramAddressSync([Buffer.from("whitelist"), EUSX_DM_CONFIG.toBuffer(), publicKey.toBuffer()], DELTA_MINT);
        const userEusxAta = getAssociatedTokenAddressSync(EUSX_MINT, publicKey, false, TOKEN_PROGRAM_ID);
        const vaultAta = getAssociatedTokenAddressSync(EUSX_MINT, EUSX_POOL, true, TOKEN_PROGRAM_ID);
        const userDeusxAta = getAssociatedTokenAddressSync(DEUSX_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID);

        // Create ceUSX ATA if needed
        const deusxAtaInfo = await connection.getAccountInfo(userDeusxAta);
        if (!deusxAtaInfo) {
          tx.add(createAssociatedTokenAccountInstruction(publicKey, userDeusxAta, publicKey, DEUSX_MINT, TOKEN_2022_PROGRAM_ID));
        }

        // Wrap eUSX → ceUSX
        const wrapAmtBuf = Buffer.alloc(8);
        wrapAmtBuf.writeBigUInt64LE(amountLamports, 0);
        tx.add({
          programId: GOVERNOR,
          data: Buffer.concat([DISC.wrap, wrapAmtBuf]),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: EUSX_POOL, isSigner: false, isWritable: true },
            { pubkey: EUSX_MINT, isSigner: false, isWritable: false },
            { pubkey: userEusxAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: EUSX_DM_CONFIG, isSigner: false, isWritable: false },
            { pubkey: DEUSX_MINT, isSigner: false, isWritable: true },
            { pubkey: dmAuthority, isSigner: false, isWritable: false },
            { pubkey: whitelistEntry, isSigner: false, isWritable: false },
            { pubkey: userDeusxAta, isSigner: false, isWritable: true },
            { pubkey: DELTA_MINT, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          ],
        });
      }

      // For deposit: use ceUSX mint and Token-2022 program (even if user selected eUSX — we just wrapped it)
      const depositMint = asset.symbol === "eUSX" ? DEUSX_MINT : asset.mint;
      const depositTokenProgram = asset.symbol === "eUSX" ? TOKEN_2022_PROGRAM_ID : asset.tokenProgram;

      // Refresh ALL reserves the obligation has positions in (+ the deposit reserve)
      // IMPORTANT: The deposit reserve MUST be refreshed LAST (klend check_refresh verifies order)
      const RESERVE_ORACLES: Record<string, PublicKey> = {
        "3FkBgVfnYBnUre6GMQZv8w4dDM1x7Fp5RiGk96kZ5mVs": new PublicKey("6dbNQrjLVQxk1bJhbB6AiMFWzaf8G2d3LPjH69Je498A"), // ceUSX
        "AYhwFLgzxWwqznhxv6Bg1NVnNeoDNu9SBGLzM1W3hSfb": new PublicKey("EN2FsFZFdpiFAWpKDZqeJ2PY8EyE7xzz9Ew8ZQVhtHCJ"), // sUSDC
        "HhTUuM5XwpnQchiUiLVNxUjPkHtfbcX4aF4bWKCSSAuT": new PublicKey("4Xv1RpZQHZNHatTba3xUW4foLYUM6x36NxehihVcUnPQ"), // dtUSDY
      };
      const obData = await connection.getAccountInfo(obPda);
      const obligationReserves = obData ? findObligationReserves(Buffer.from(obData.data)) : [];
      // Collect all reserves to refresh, with the DEPOSIT reserve LAST
      const depositReserveAddr = asset.reserve.toBase58();
      const otherReserves = obligationReserves
        .map(r => r.toBase58())
        .filter(r => r !== depositReserveAddr);
      const refreshOrder = [...new Set(otherReserves), depositReserveAddr];
      for (const reserveAddr of refreshOrder) {
        const oracle = RESERVE_ORACLES[reserveAddr] || asset.oracle;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: new PublicKey(reserveAddr), isSigner: false, isWritable: true },
          { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        ...obligationReserves.map(r => ({ pubkey: r, isSigner: false, isWritable: false })),
      ]});

      // Deposit
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), asset.reserve.toBuffer()], KLEND);
      const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), asset.reserve.toBuffer()], KLEND);
      const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), asset.reserve.toBuffer()], KLEND);
      const userAta = getAssociatedTokenAddressSync(depositMint, publicKey, false, depositTokenProgram);
      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amountLamports, 0);

      tx.add({ programId: KLEND, data: Buffer.concat([DISC.deposit_reserve_liquidity_and_obligation_collateral, amtBuf]), keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true }, { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: lma, isSigner: false, isWritable: false },
        { pubkey: asset.reserve, isSigner: false, isWritable: true }, { pubkey: depositMint, isSigner: false, isWritable: false },
        { pubkey: liqSupply, isSigner: false, isWritable: true }, { pubkey: collMint, isSigner: false, isWritable: true },
        { pubkey: collSupply, isSigner: false, isWritable: true }, { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: depositTokenProgram, isSigner: false, isWritable: false }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ]});

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;

      setStatus({ msg: "Sign deposit in wallet...", type: "info" });
      const sig = await signAndSend(tx);
      setStatus({ msg: "Deposited " + amount + " " + asset.symbol + " as collateral (tx: " + sig.slice(0, 16) + "...)", type: "success" });
      setObligationAddr(obPda.toBase58());
      setAmount("");
    } catch (e: any) {
      setStatus({ msg: "Failed: " + (e.message?.slice(0, 120) || "Unknown"), type: "error" });
    } finally { setLoading(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <span className="eyebrow">Lending</span>
        <h2 className="text-2xl mt-1">Supply Collateral</h2>
        <p className="text-sm text-base-content/55 mt-1">Deposit KYC-wrapped tokens as collateral to borrow Solstice USDC.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="panel">
          <div className="card-body p-6 gap-4">
            <h3 className="card-title">Deposit Collateral</h3>
            <div className="flex gap-1 bg-base-300 rounded-lg p-1">
              {COLLATERAL_ASSETS.map((a, i) => (
                <button key={a.symbol} className={"flex-1 btn btn-sm " + (selected === i ? "btn-primary" : "btn-ghost")} onClick={() => setSelected(i)}>
                  {a.symbol} {a.yieldApy && <span className="badge badge-warning badge-xs ml-1">yield</span>}
                </button>
              ))}
            </div>
            <p className="text-sm text-base-content/50">
              {asset.symbol} balance: <span className="font-mono font-bold">{(balances[asset.symbol] || 0).toFixed(2)}</span>
            </p>
            <div className="flex gap-2">
              <input className="input input-bordered bg-base-300 text-base-content flex-1 font-mono" placeholder="0.00"
                value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
              <button className="btn btn-ghost btn-sm self-center" onClick={() => setAmount((balances[asset.symbol] || 0).toString())}>MAX</button>
            </div>
            <button className="btn btn-primary w-full" onClick={handleDeposit} disabled={loading || !amount || parseFloat(amount) <= 0}>
              {loading ? <span className="loading loading-spinner loading-sm" /> : "Deposit " + asset.symbol}
            </button>
            {status && <div className={"alert text-sm " + (status.type === "success" ? "alert-success" : status.type === "error" ? "alert-error" : "alert-info")}>{status.msg}</div>}
          </div>
        </div>
        <div className="panel">
          <div className="card-body p-6 gap-3">
            <h3 className="card-title">{asset.symbol} Details</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-base-content/60">Asset</span><span className="font-mono">{asset.name}</span></div>
              <div className="flex justify-between"><span className="text-base-content/60">Oracle Price</span><span className="font-mono text-success">${asset.price.toFixed(2)}</span></div>
              <div className="flex justify-between"><span className="text-base-content/60">LTV</span><span className="font-mono">75%</span></div>
              <div className="flex justify-between"><span className="text-base-content/60">Liquidation Threshold</span><span className="font-mono">85%</span></div>
              {asset.yieldApy && <div className="flex justify-between"><span className="text-base-content/60">Yield on Collateral</span><span className="font-mono text-success">{asset.yieldApy}</span></div>}
              <div className="divider my-1"></div>
              <div className="flex justify-between"><span className="text-base-content/60">Borrow Asset</span><span className="font-mono">Solstice USDC</span></div>
              <div className="flex justify-between"><span className="text-base-content/60">Borrow Rate</span><span className="font-mono text-warning">~5% APY</span></div>
              {asset.yieldApy && <><div className="divider my-1"></div><div className="flex justify-between font-bold"><span className="text-success">Net Carry Trade</span><span className="font-mono text-success">~+5% APY</span></div></>}
              <div className="divider my-1"></div>
              <div className="flex justify-between"><span className="text-base-content/60">Obligation</span><span className="font-mono text-xs">{obligationAddr ? obligationAddr.slice(0, 16) + "..." : "Not created yet"}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
