import { useEffect, useState, useCallback } from "react";
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

const USDC_RESERVE = new PublicKey("AYhwFLgzxWwqznhxv6Bg1NVnNeoDNu9SBGLzM1W3hSfb");
const USDC_ORACLE = new PublicKey("EN2FsFZFdpiFAWpKDZqeJ2PY8EyE7xzz9Ew8ZQVhtHCJ");
const USDC_MINT = new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g");

// Collateral assets that can be deposited
interface CollateralAsset {
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
    symbol: "ceUSX", mint: new PublicKey("8Uy7rmtAZvnQA1SuYZJKKBXFovHDPEYXiYH3H6iQMRwT"),
    reserve: new PublicKey("3FkBgVfnYBnUre6GMQZv8w4dDM1x7Fp5RiGk96kZ5mVs"),
    oracle: new PublicKey("6dbNQrjLVQxk1bJhbB6AiMFWzaf8G2d3LPjH69Je498A"),
    tokenProgram: TOKEN_2022_PROGRAM_ID, price: 1.08, yieldApy: "~10%",
  },
  {
    symbol: "dtUSDY", mint: new PublicKey("6SV8ecHhfgWYHTiec2uDMPXHUXqqT2puNjR73gj6AvYu"),
    reserve: new PublicKey("HhTUuM5XwpnQchiUiLVNxUjPkHtfbcX4aF4bWKCSSAuT"),
    oracle: new PublicKey("4Xv1RpZQHZNHatTba3xUW4foLYUM6x36NxehihVcUnPQ"),
    tokenProgram: TOKEN_2022_PROGRAM_ID, price: 1.08,
  },
];

const RESERVE_ORACLES: Record<string, PublicKey> = {};
COLLATERAL_ASSETS.forEach(a => { RESERVE_ORACLES[a.reserve.toBase58()] = a.oracle; });
RESERVE_ORACLES[USDC_RESERVE.toBase58()] = USDC_ORACLE;

const RESERVE_META: Record<string, { symbol: string; price: number }> = {};
COLLATERAL_ASSETS.forEach(a => { RESERVE_META[a.reserve.toBase58()] = { symbol: a.symbol, price: a.price }; });
RESERVE_META[USDC_RESERVE.toBase58()] = { symbol: "sUSDC", price: 1.00 };

const DISC = {
  init_user_metadata: Buffer.from([117, 169, 176, 69, 197, 23, 15, 162]),
  init_obligation: Buffer.from([251, 10, 231, 76, 27, 11, 159, 96]),
  refresh_reserve: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]),
  refresh_obligation: Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]),
  deposit_reserve_liquidity_and_obligation_collateral: Buffer.from([129, 199, 4, 2, 222, 39, 26, 46]),
  borrow_obligation_liquidity: Buffer.from([121, 127, 18, 204, 73, 245, 225, 65]),
  repay_obligation_liquidity: Buffer.from([145, 178, 13, 225, 76, 240, 147, 72]),
  withdraw_obligation_collateral_and_redeem_reserve_collateral: Buffer.from([75, 93, 93, 220, 34, 150, 218, 196]),
};

interface Deposit { reserve: string; symbol: string; amount: number; valueUsd: number; }
interface Borrow { reserve: string; symbol: string; amount: number; valueUsd: number; }
interface PositionData {
  address: string;
  deposits: Deposit[];
  borrows: Borrow[];
  totalCollateralUsd: number;
  totalBorrowUsd: number;
  healthFactor: number | null;
  ltvPct: number;
  liqThreshPct: number;
  walletBalances: Record<string, number>; // symbol → balance
  usdcBalance: number;
  maxBorrow: number;
  availableLiquidity: number;
  liquidationPrice: number | null; // collateral price at which HF=1
  borrowAPR: number | null; // current borrow APR from on-chain curve
}

export default function PositionsPage() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [position, setPosition] = useState<PositionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [status, setStatus] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);
  const [depositAmt, setDepositAmt] = useState("");
  const [depositAsset, setDepositAsset] = useState<CollateralAsset | null>(null);
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [withdrawAsset, setWithdrawAsset] = useState<CollateralAsset | null>(null);
  const [borrowAmt, setBorrowAmt] = useState("");
  const [repayAmt, setRepayAmt] = useState("");
  const [showBorrow, setShowBorrow] = useState(false);
  const [showRepay, setShowRepay] = useState(false);
  const [showMarketParams, setShowMarketParams] = useState(false);

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!signTransaction || !publicKey) throw new Error("Wallet not connected");
    const signed = await signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  const loadPosition = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    try {
      const obPda = getObligationPda(publicKey);
      const info = await connection.getAccountInfo(obPda);

      // Wallet balances for all collateral assets
      const walletBalances: Record<string, number> = {};
      for (const asset of COLLATERAL_ASSETS) {
        try {
          const ata = getAssociatedTokenAddressSync(asset.mint, publicKey, false, asset.tokenProgram);
          const ai = await connection.getAccountInfo(ata);
          walletBalances[asset.symbol] = ai ? Number(ai.data.readBigUInt64LE(64)) / 1e6 : 0;
        } catch { walletBalances[asset.symbol] = 0; }
      }
      let usdcBalance = 0;
      try {
        const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey, false, TOKEN_PROGRAM_ID);
        const ui = await connection.getAccountInfo(usdcAta);
        if (ui) usdcBalance = Number(ui.data.readBigUInt64LE(64)) / 1e6;
      } catch {}

      // Read USDC reserve for available liquidity + borrow rate
      const reserveInfo = await connection.getAccountInfo(USDC_RESERVE);
      let availableLiquidity = 0;
      let borrowAPR: number | null = null;
      if (reserveInfo && reserveInfo.data.length >= 5008) {
        const rd = reserveInfo.data;
        const available = Number(rd.readBigUInt64LE(224));
        const sfLo = rd.readBigUInt64LE(232);
        const sfHi = rd.readBigUInt64LE(240);
        const borrowed = Number((sfLo + (sfHi << 64n)) >> 60n);
        availableLiquidity = available / 1e6;
        const total = available + borrowed;
        const util = total > 0 ? borrowed / total : 0;
        // Decode borrow rate curve (11 points: {utilBps: u32, rateBps: u32})
        const CURVE_OFF = 4920;
        const pts: { u: number; r: number }[] = [];
        for (let i = 0; i < 11; i++) {
          const u = rd.readUInt32LE(CURVE_OFF + i * 8);
          const r = rd.readUInt32LE(CURVE_OFF + i * 8 + 4);
          pts.push({ u, r });
          if (u >= 10000) break;
        }
        const utilBps = Math.round(util * 10000);
        let rateBps = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          if (utilBps >= pts[i].u && utilBps <= pts[i + 1].u) {
            const t = pts[i + 1].u === pts[i].u ? 0 : (utilBps - pts[i].u) / (pts[i + 1].u - pts[i].u);
            rateBps = pts[i].r + t * (pts[i + 1].r - pts[i].r);
            break;
          }
        }
        if (utilBps >= (pts[pts.length - 1]?.u ?? 10000)) rateBps = pts[pts.length - 1]?.r ?? 0;
        borrowAPR = rateBps / 10000; // fraction
      }

      if (!info) {
        setPosition({ address: obPda.toBase58(), deposits: [], borrows: [], totalCollateralUsd: 0, totalBorrowUsd: 0, healthFactor: null, ltvPct: 95, liqThreshPct: 98, walletBalances, usdcBalance, maxBorrow: 0, availableLiquidity, liquidationPrice: null, borrowAPR });
        setLoading(false);
        return;
      }

      const data = info.data;
      const deposits: Deposit[] = [];
      const borrows: Borrow[] = [];

      for (const [addr, meta] of Object.entries(RESERVE_META)) {
        const buf = new PublicKey(addr).toBuffer();
        for (let i = 64; i < Math.min(data.length - 32, 1200); i++) {
          if (data.subarray(i, i + 32).equals(buf)) {
            const amount = Number(data.readBigUInt64LE(i + 32)) / 1e6;
            if (amount > 0) deposits.push({ reserve: addr, symbol: meta.symbol, amount, valueUsd: amount * meta.price });
            break;
          }
        }
        for (let i = 1200; i < Math.min(data.length - 32, 2400); i++) {
          if (data.subarray(i, i + 32).equals(buf)) {
            const sfLo = data.readBigUInt64LE(i + 88);
            const sfHi = data.readBigUInt64LE(i + 96);
            const amount = Number((sfLo + (sfHi << 64n)) / (1n << 60n)) / 1e6;
            if (amount > 0.001) borrows.push({ reserve: addr, symbol: meta.symbol, amount, valueUsd: amount * meta.price });
            break;
          }
        }
      }

      const totalCollateralUsd = deposits.reduce((s, d) => s + d.valueUsd, 0);
      const totalBorrowUsd = borrows.reduce((s, b) => s + b.valueUsd, 0);
      let ltvPct = 95, liqThreshPct = 98;
      if (deposits.length > 0) {
        const ri = await connection.getAccountInfo(new PublicKey(deposits[0].reserve));
        if (ri) { ltvPct = ri.data[4872]; liqThreshPct = ri.data[4873]; }
      }
      const healthFactor = totalBorrowUsd > 0 ? (totalCollateralUsd * (liqThreshPct / 100)) / totalBorrowUsd : null;
      const maxBorrow = Math.max(0, totalCollateralUsd * (ltvPct / 100) - totalBorrowUsd);
      // Liquidation price: collateral price at which HF = 1
      // HF = (collateral_amount * price * liqThresh%) / borrows = 1
      // price = borrows / (collateral_amount * liqThresh%)
      const totalCollateralTokens = deposits.reduce((s, d) => s + d.amount, 0);
      const liquidationPrice = totalBorrowUsd > 0 && totalCollateralTokens > 0
        ? totalBorrowUsd / (totalCollateralTokens * (liqThreshPct / 100))
        : null;

      setPosition({ address: obPda.toBase58(), deposits, borrows, totalCollateralUsd, totalBorrowUsd, healthFactor, ltvPct, liqThreshPct, walletBalances, usdcBalance, maxBorrow, availableLiquidity, liquidationPrice, borrowAPR });
    } catch (e) { console.warn("Load failed:", e); }
    setLoading(false);
  }, [publicKey, connection]);

  useEffect(() => { loadPosition(); }, [loadPosition]);

  // --- Action handlers ---

  function buildRefreshAll(tx: Transaction, obData: Buffer | null) {
    const reserves = obData ? findObligationReserves(Buffer.from(obData)) : [];
    const allReserves = new Set([...reserves.map(r => r.toBase58())]);
    for (const addr of allReserves) {
      const oracle = RESERVE_ORACLES[addr];
      if (!oracle) continue;
      tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
        { pubkey: new PublicKey(addr), isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: false },
        { pubkey: KLEND, isSigner: false, isWritable: false },
        { pubkey: KLEND, isSigner: false, isWritable: false },
        { pubkey: KLEND, isSigner: false, isWritable: false },
      ]});
    }
    tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: getObligationPda(publicKey!), isSigner: false, isWritable: true },
      ...reserves.map(r => ({ pubkey: r, isSigner: false, isWritable: false })),
    ]});
  }

  async function handleDeposit() {
    if (!publicKey || !depositAmt || !depositAsset) return;
    setActionLoading(true);
    const asset = depositAsset;
    setStatus({ msg: `Depositing ${asset.symbol}...`, type: "info" });
    try {
      const amt = BigInt(Math.floor(parseFloat(depositAmt) * 1e6));

      // Check user has the token ATA with balance
      const userAta = getAssociatedTokenAddressSync(asset.mint, publicKey, false, asset.tokenProgram);
      const ataInfo = await connection.getAccountInfo(userAta);
      if (!ataInfo) throw new Error(`No ${asset.symbol} token account found. Prepare collateral first (Step 2).`);
      const obPda = getObligationPda(publicKey);
      const obInfo = await connection.getAccountInfo(obPda);
      const [userMeta] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), publicKey.toBuffer()], KLEND);
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), asset.reserve.toBuffer()], KLEND);
      const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), asset.reserve.toBuffer()], KLEND);
      const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), asset.reserve.toBuffer()], KLEND);

      const tx = new Transaction();
      if (!obInfo) {
        const umInfo = await connection.getAccountInfo(userMeta);
        if (!umInfo) {
          tx.add({ programId: KLEND, data: Buffer.concat([DISC.init_user_metadata, Buffer.alloc(32)]), keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: userMeta, isSigner: false, isWritable: true },
            { pubkey: KLEND, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ]});
        }
        tx.add({ programId: KLEND, data: Buffer.concat([DISC.init_obligation, Buffer.from([0, OB_ID])]), keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: PublicKey.default, isSigner: false, isWritable: false },
          { pubkey: PublicKey.default, isSigner: false, isWritable: false },
          { pubkey: userMeta, isSigner: false, isWritable: true },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ]});
      }

      // Refresh: other reserves first, deposit reserve LAST
      const reserves = obInfo ? findObligationReserves(Buffer.from(obInfo.data)) : [];
      const others = reserves.filter(r => !r.equals(asset.reserve));
      for (const r of [...others, asset.reserve]) {
        const oracle = RESERVE_ORACLES[r.toBase58()];
        if (!oracle) continue;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: r, isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      // Only refresh obligation if it already exists (new obligations have nothing to refresh)
      if (obInfo) {
        tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
          { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
          ...reserves.map(r => ({ pubkey: r, isSigner: false, isWritable: false })),
        ]});
      }

      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amt, 0);
      tx.add({ programId: KLEND, data: Buffer.concat([DISC.deposit_reserve_liquidity_and_obligation_collateral, amtBuf]), keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true }, { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: lma, isSigner: false, isWritable: false },
        { pubkey: asset.reserve, isSigner: false, isWritable: true }, { pubkey: asset.mint, isSigner: false, isWritable: false },
        { pubkey: liqSupply, isSigner: false, isWritable: true }, { pubkey: collMint, isSigner: false, isWritable: true },
        { pubkey: collSupply, isSigner: false, isWritable: true }, { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: asset.tokenProgram, isSigner: false, isWritable: false }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ]});

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;
      const sig = await signAndSend(tx);
      setStatus({ msg: `Deposited ${depositAmt} ${asset.symbol} (${sig.slice(0, 16)}...)`, type: "success" });
      setDepositAmt(""); setDepositAsset(null); await loadPosition();
    } catch (e: any) { setStatus({ msg: `Deposit failed: ${e.message?.slice(0, 100)}`, type: "error" }); }
    setActionLoading(false);
  }

  async function handleWithdraw() {
    if (!publicKey || !withdrawAmt || !withdrawAsset) return;
    setActionLoading(true);
    const asset = withdrawAsset;
    setStatus({ msg: `Withdrawing ${asset.symbol}...`, type: "info" });
    try {
      const amt = BigInt(Math.floor(parseFloat(withdrawAmt) * 1e6));
      const obPda = getObligationPda(publicKey);
      const obInfo = await connection.getAccountInfo(obPda);
      if (!obInfo) throw new Error("No obligation.");
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), asset.reserve.toBuffer()], KLEND);
      const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), asset.reserve.toBuffer()], KLEND);
      const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), asset.reserve.toBuffer()], KLEND);
      const userAta = getAssociatedTokenAddressSync(asset.mint, publicKey, false, asset.tokenProgram);

      const tx = new Transaction();
      // Refresh: withdraw reserve LAST
      const reserves = findObligationReserves(Buffer.from(obInfo.data));
      const others = reserves.filter(r => !r.equals(asset.reserve));
      for (const r of [...others, asset.reserve]) {
        const oracle = RESERVE_ORACLES[r.toBase58()]; if (!oracle) continue;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: r, isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        ...reserves.map(r => ({ pubkey: r, isSigner: false, isWritable: false })),
      ]});

      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amt, 0);
      tx.add({ programId: KLEND, data: Buffer.concat([DISC.withdraw_obligation_collateral_and_redeem_reserve_collateral, amtBuf]), keys: [
        { pubkey: publicKey, isSigner: true, isWritable: true },
        { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false },
        { pubkey: lma, isSigner: false, isWritable: false },
        { pubkey: asset.reserve, isSigner: false, isWritable: true },
        { pubkey: asset.mint, isSigner: false, isWritable: false },
        { pubkey: collMint, isSigner: false, isWritable: true },
        { pubkey: collSupply, isSigner: false, isWritable: true },
        { pubkey: liqSupply, isSigner: false, isWritable: true },
        { pubkey: userAta, isSigner: false, isWritable: true },
        { pubkey: KLEND, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: asset.tokenProgram, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ]});

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;
      const sig = await signAndSend(tx);
      setStatus({ msg: `Withdrew ${withdrawAmt} ${asset.symbol} (${sig.slice(0, 16)}...)`, type: "success" });
      setWithdrawAmt(""); setWithdrawAsset(null); await loadPosition();
    } catch (e: any) { setStatus({ msg: `Withdraw failed: ${e.message?.slice(0, 100)}`, type: "error" }); }
    setActionLoading(false);
  }

  async function handleBorrow() {
    if (!publicKey || !borrowAmt) return;
    setActionLoading(true);
    setStatus({ msg: "Borrowing USDC...", type: "info" });
    try {
      const amt = BigInt(Math.floor(parseFloat(borrowAmt) * 1e6));
      const obPda = getObligationPda(publicKey);
      // Wait for RPC to reflect latest state (important after a deposit in the same session)
      await new Promise(r => setTimeout(r, 1000));
      const obInfo = await connection.getAccountInfo(obPda, "confirmed");
      if (!obInfo) throw new Error("No obligation. Deposit collateral first.");
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [usdcLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), USDC_RESERVE.toBuffer()], KLEND);
      const [usdcFeeRecv] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), USDC_RESERVE.toBuffer()], KLEND);
      const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey);

      // Ensure USDC ATA exists FIRST (before building the rest of the tx)
      const usdcAtaInfo = await connection.getAccountInfo(userUsdcAta);

      const tx = new Transaction();

      // Create USDC ATA if needed (must be before refresh instructions)
      if (!usdcAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, userUsdcAta, publicKey, USDC_MINT));
      }

      // Refresh: borrow reserve LAST
      const reserves = findObligationReserves(Buffer.from(obInfo.data));
      // Ensure both ceUSX and USDC reserves are refreshed
      const allReserves = new Set([...reserves.map(r => r.toBase58()), USDC_RESERVE.toBase58()]);
      const refreshOrder = [...[...allReserves].filter(r => r !== USDC_RESERVE.toBase58()), USDC_RESERVE.toBase58()];
      for (const rAddr of refreshOrder) {
        const oracle = RESERVE_ORACLES[rAddr]; if (!oracle) continue;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: new PublicKey(rAddr), isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        ...reserves.map(r => ({ pubkey: r, isSigner: false, isWritable: false })),
      ]});
      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amt, 0);
      tx.add({ programId: KLEND, data: Buffer.concat([DISC.borrow_obligation_liquidity, amtBuf]), keys: [
        { pubkey: publicKey, isSigner: true, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: lma, isSigner: false, isWritable: false },
        { pubkey: USDC_RESERVE, isSigner: false, isWritable: true }, { pubkey: USDC_MINT, isSigner: false, isWritable: false },
        { pubkey: usdcLiqSupply, isSigner: false, isWritable: true }, { pubkey: usdcFeeRecv, isSigner: false, isWritable: true },
        { pubkey: userUsdcAta, isSigner: false, isWritable: true }, { pubkey: KLEND, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ]});
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;
      const sig = await signAndSend(tx);
      setStatus({ msg: `Borrowed ${borrowAmt} USDC (${sig.slice(0, 16)}...)`, type: "success" });
      setBorrowAmt(""); setShowBorrow(false); await loadPosition();
    } catch (e: any) { setStatus({ msg: `Borrow failed: ${e.message?.slice(0, 100)}`, type: "error" }); }
    setActionLoading(false);
  }

  async function handleRepay() {
    if (!publicKey || !repayAmt) return;
    setActionLoading(true);
    setStatus({ msg: "Repaying USDC...", type: "info" });
    try {
      const isMax = repayAmt === "max";
      const amt = isMax ? BigInt("18446744073709551615") : BigInt(Math.floor(parseFloat(repayAmt) * 1e6));
      const obPda = getObligationPda(publicKey);
      const obInfo = await connection.getAccountInfo(obPda);
      if (!obInfo) throw new Error("No obligation.");
      const [usdcLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), USDC_RESERVE.toBuffer()], KLEND);
      const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey);

      const tx = new Transaction();
      const reserves = findObligationReserves(Buffer.from(obInfo.data));
      const others = reserves.filter(r => !r.equals(USDC_RESERVE));
      for (const r of [...others, USDC_RESERVE]) {
        const oracle = RESERVE_ORACLES[r.toBase58()]; if (!oracle) continue;
        tx.add({ programId: KLEND, data: DISC.refresh_reserve, keys: [
          { pubkey: r, isSigner: false, isWritable: true }, { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: oracle, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false }, { pubkey: KLEND, isSigner: false, isWritable: false },
        ]});
      }
      tx.add({ programId: KLEND, data: DISC.refresh_obligation, keys: [
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        ...reserves.map(r => ({ pubkey: r, isSigner: false, isWritable: false })),
      ]});
      const amtBuf = Buffer.alloc(8); amtBuf.writeBigUInt64LE(amt, 0);
      tx.add({ programId: KLEND, data: Buffer.concat([DISC.repay_obligation_liquidity, amtBuf]), keys: [
        { pubkey: publicKey, isSigner: true, isWritable: false }, { pubkey: obPda, isSigner: false, isWritable: true },
        { pubkey: MARKET, isSigner: false, isWritable: false }, { pubkey: USDC_RESERVE, isSigner: false, isWritable: true },
        { pubkey: USDC_MINT, isSigner: false, isWritable: false }, { pubkey: usdcLiqSupply, isSigner: false, isWritable: true },
        { pubkey: userUsdcAta, isSigner: false, isWritable: true }, { pubkey: KLEND, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ]});
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = publicKey;
      const sig = await signAndSend(tx);
      setStatus({ msg: `Repaid ${isMax ? "all" : repayAmt} USDC (${sig.slice(0, 16)}...)`, type: "success" });
      setRepayAmt(""); setShowRepay(false); await loadPosition();
    } catch (e: any) { setStatus({ msg: `Repay failed: ${e.message?.slice(0, 100)}`, type: "error" }); }
    setActionLoading(false);
  }

  if (loading) return <div className="flex justify-center py-20"><span className="loading loading-spinner loading-lg" /></div>;

  const p = position;

  return (
    <div className="space-y-6">
      <div>
        <span className="eyebrow">Lending</span>
        <h2 className="text-2xl mt-1">Positions</h2>
        <p className="text-sm text-base-content/55 mt-1">Live view of your collateral, borrows, and obligation health.</p>
      </div>

      {status && (
        <div className={`alert ${status.type === "success" ? "alert-success" : status.type === "error" ? "alert-error" : "alert-info"} text-sm`}>
          {status.msg}
        </div>
      )}

      {/* Summary */}
      {p && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="panel"><div className="card-body p-4 gap-1">
            <div className="text-xs opacity-50">Collateral</div>
            <div className="font-mono font-bold text-success">${p.totalCollateralUsd.toFixed(2)}</div>
          </div></div>
          <div className="panel"><div className="card-body p-4 gap-1">
            <div className="text-xs opacity-50">Borrows</div>
            <div className="font-mono font-bold text-warning">${p.totalBorrowUsd.toFixed(2)}</div>
          </div></div>
          <div className="panel"><div className="card-body p-4 gap-1">
            <div className="text-xs opacity-50">Available to Borrow</div>
            <div className="font-mono font-bold text-primary">${Math.min(p.maxBorrow, p.availableLiquidity).toFixed(2)}</div>
          </div></div>
          <div className="panel"><div className="card-body p-4 gap-1">
            <div className="text-xs opacity-50">Health Factor</div>
            <div className={`font-mono font-bold ${!p.healthFactor ? "opacity-40" : p.healthFactor > 1.5 ? "text-success" : p.healthFactor > 1.1 ? "text-warning" : "text-error"}`}>
              {p.healthFactor ? p.healthFactor.toFixed(2) : "—"}
            </div>
          </div></div>
          <div className="panel"><div className="card-body p-4 gap-1">
            <div className="text-xs opacity-50">Liq. Price</div>
            <div className="font-mono font-bold text-error">
              {p.liquidationPrice ? `$${p.liquidationPrice.toFixed(4)}` : "—"}
            </div>
            <div className="text-xs opacity-30">current: $1.08</div>
          </div></div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Collateral */}
        <div className="panel">
          <div className="card-body p-6 gap-3">
            <h3 className="card-title text-lg">Collateral</h3>
            <table className="table table-sm">
              <thead><tr><th>Asset</th><th className="text-right">Deposited</th><th className="text-right">Value</th><th className="text-right">Wallet</th><th></th></tr></thead>
              <tbody>
                {COLLATERAL_ASSETS.map(asset => {
                  const dep = p?.deposits.find(d => d.symbol === asset.symbol);
                  const walBal = p?.walletBalances[asset.symbol] || 0;
                  return (
                    <tr key={asset.symbol}>
                      <td>
                        <span className="font-mono font-semibold">{asset.symbol}</span>
                        {asset.yieldApy && <span className="badge badge-warning badge-xs ml-1">{asset.yieldApy}</span>}
                      </td>
                      <td className="text-right font-mono">{dep ? dep.amount.toFixed(2) : "0.00"}</td>
                      <td className="text-right font-mono text-success">{dep ? `$${dep.valueUsd.toFixed(2)}` : "—"}</td>
                      <td className="text-right font-mono text-xs opacity-50">{walBal.toFixed(2)}</td>
                      <td className="text-right">
                        <div className="flex gap-1 justify-end">
                          {dep && dep.amount > 0 && (
                            <button className="btn btn-error btn-xs btn-outline"
                              onClick={() => { setWithdrawAsset(asset); setWithdrawAmt(""); setDepositAsset(null); }}>
                              Withdraw
                            </button>
                          )}
                          {walBal > 0 && (
                            <button className="btn btn-success btn-xs"
                              onClick={() => { setDepositAsset(asset); setDepositAmt(""); setWithdrawAsset(null); }}>
                              Supply
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Deposit form — shown when an asset is selected */}
            {depositAsset && (
              <div className="bg-base-300 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs opacity-50">
                    Supply {depositAsset.symbol} — wallet: {(p?.walletBalances[depositAsset.symbol] || 0).toFixed(2)}
                  </div>
                  <button className="btn btn-ghost btn-xs" onClick={() => setDepositAsset(null)}>Cancel</button>
                </div>
                <div className="flex gap-2">
                  <input className="input input-bordered bg-base-200 flex-1 font-mono text-sm" placeholder="0.00" value={depositAmt}
                    onChange={e => setDepositAmt(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
                  <button className="btn btn-ghost btn-xs self-center"
                    onClick={() => p && setDepositAmt((p.walletBalances[depositAsset.symbol] || 0).toFixed(2))}>MAX</button>
                </div>
                {/* Preview */}
                {depositAmt && parseFloat(depositAmt) > 0 && p && (
                  <div className="text-xs space-y-1 opacity-70">
                    <div className="flex justify-between">
                      <span>New collateral value</span>
                      <span className="font-mono">${(p.totalCollateralUsd + parseFloat(depositAmt) * depositAsset.price).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>New max borrow</span>
                      <span className="font-mono">${((p.totalCollateralUsd + parseFloat(depositAmt) * depositAsset.price) * (p.ltvPct / 100) - p.totalBorrowUsd).toFixed(2)}</span>
                    </div>
                    {p.totalBorrowUsd > 0 && (
                      <div className="flex justify-between">
                        <span>New health factor</span>
                        <span className="font-mono text-success">
                          {((p.totalCollateralUsd + parseFloat(depositAmt) * depositAsset.price) * (p.liqThreshPct / 100) / p.totalBorrowUsd).toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                <button className="btn btn-success btn-sm w-full" onClick={handleDeposit}
                  disabled={actionLoading || !depositAmt || parseFloat(depositAmt) <= 0}>
                  {actionLoading ? <span className="loading loading-spinner loading-xs" /> : `Deposit ${depositAsset.symbol}`}
                </button>
              </div>
            )}

            {/* Withdraw form */}
            {withdrawAsset && p && (() => {
              const dep = p.deposits.find(d => d.symbol === withdrawAsset.symbol);
              const maxWithdraw = dep ? dep.amount : 0;
              return (
                <div className="bg-base-300 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-xs opacity-50">
                      Withdraw {withdrawAsset.symbol} — deposited: {maxWithdraw.toFixed(2)}
                    </div>
                    <button className="btn btn-ghost btn-xs" onClick={() => setWithdrawAsset(null)}>Cancel</button>
                  </div>
                  <div className="flex gap-2">
                    <input className="input input-bordered bg-base-200 flex-1 font-mono text-sm" placeholder="0.00" value={withdrawAmt}
                      onChange={e => setWithdrawAmt(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
                    <button className="btn btn-ghost btn-xs self-center" onClick={() => setWithdrawAmt(maxWithdraw.toFixed(2))}>MAX</button>
                  </div>
                  {withdrawAmt && parseFloat(withdrawAmt) > 0 && (() => {
                    const newCollUsd = p.totalCollateralUsd - parseFloat(withdrawAmt) * withdrawAsset.price;
                    const newHF = p.totalBorrowUsd > 0 ? newCollUsd * (p.liqThreshPct / 100) / p.totalBorrowUsd : null;
                    const newMaxBorrow = Math.max(0, newCollUsd * (p.ltvPct / 100) - p.totalBorrowUsd);
                    const wouldLiquidate = newHF !== null && newHF < 1.0;
                    return (
                      <div className="text-xs space-y-1 opacity-70">
                        <div className="flex justify-between"><span>New collateral</span><span className="font-mono">${newCollUsd.toFixed(2)}</span></div>
                        {p.totalBorrowUsd > 0 && (
                          <div className="flex justify-between"><span>New health factor</span>
                            <span className={`font-mono ${!newHF ? "" : newHF > 1.5 ? "text-success" : newHF > 1.1 ? "text-warning" : "text-error"}`}>
                              {newHF ? newHF.toFixed(2) : "∞"}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between"><span>Remaining borrow capacity</span><span className="font-mono">${newMaxBorrow.toFixed(2)}</span></div>
                        {wouldLiquidate && <div className="text-error font-semibold">Cannot withdraw — would liquidate position!</div>}
                      </div>
                    );
                  })()}
                  <button className="btn btn-error btn-sm w-full" onClick={handleWithdraw}
                    disabled={actionLoading || !withdrawAmt || parseFloat(withdrawAmt) <= 0 || parseFloat(withdrawAmt) > maxWithdraw ||
                      (p.totalBorrowUsd > 0 && (p.totalCollateralUsd - parseFloat(withdrawAmt) * withdrawAsset.price) * (p.liqThreshPct / 100) / p.totalBorrowUsd < 1.0)}>
                    {actionLoading ? <span className="loading loading-spinner loading-xs" /> : `Withdraw ${withdrawAsset.symbol}`}
                  </button>
                </div>
              );
            })()}
          </div>
        </div>

        {/* Borrows */}
        <div className="panel">
          <div className="card-body p-6 gap-3">
            <div className="flex items-center justify-between">
              <h3 className="card-title text-lg">Borrows</h3>
              <div className="flex gap-1">
                {p && p.totalBorrowUsd > 0 && (
                  <button className="btn btn-info btn-sm" onClick={() => { setShowRepay(!showRepay); setShowBorrow(false); }}>
                    {showRepay ? "Cancel" : "Repay"}
                  </button>
                )}
                <button className="btn btn-warning btn-sm" onClick={() => { setShowBorrow(!showBorrow); setShowRepay(false); }}>
                  {showBorrow ? "Cancel" : "+ Borrow"}
                </button>
              </div>
            </div>
            <table className="table table-sm">
              <thead><tr><th>Asset</th><th className="text-right">Amount</th><th className="text-right">Value</th></tr></thead>
              <tbody>
                {!p || p.borrows.length === 0 ? (
                  <tr><td colSpan={3} className="text-center opacity-40">No borrows</td></tr>
                ) : p.borrows.map(b => (
                  <tr key={b.reserve}>
                    <td className="font-mono font-semibold">{b.symbol}</td>
                    <td className="text-right font-mono">{b.amount.toFixed(2)}</td>
                    <td className="text-right font-mono text-warning">${b.valueUsd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {showBorrow && p && (
              <div className="bg-base-300 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs opacity-50">Borrow USDC — pool: {p.availableLiquidity.toFixed(2)} | capacity: {p.maxBorrow.toFixed(2)}{p.borrowAPR !== null ? ` | ${(p.borrowAPR * 100).toFixed(2)}% APR` : ""}</div>
                  <button className="btn btn-ghost btn-xs" onClick={() => setShowBorrow(false)}>Cancel</button>
                </div>
                <div className="flex gap-2">
                  <input className="input input-bordered bg-base-200 flex-1 font-mono text-sm" placeholder="0.00" value={borrowAmt}
                    onChange={e => setBorrowAmt(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
                  <button className="btn btn-ghost btn-xs self-center" onClick={() => setBorrowAmt(Math.floor(Math.min(p.maxBorrow, p.availableLiquidity) * 100) / 100 + "")}>MAX</button>
                </div>
                {borrowAmt && parseFloat(borrowAmt) > 0 && (() => {
                  const newBorrow = p.totalBorrowUsd + parseFloat(borrowAmt);
                  const newHF = p.totalCollateralUsd * (p.liqThreshPct / 100) / newBorrow;
                  const totalTokens = p.deposits.reduce((s, d) => s + d.amount, 0);
                  const newLiqPrice = totalTokens > 0 ? newBorrow / (totalTokens * (p.liqThreshPct / 100)) : 0;
                  return (
                    <div className="text-xs space-y-1 opacity-70">
                      <div className="flex justify-between"><span>New total debt</span><span className="font-mono">${newBorrow.toFixed(2)}</span></div>
                      <div className="flex justify-between"><span>New health factor</span>
                        <span className={`font-mono ${newHF > 1.5 ? "text-success" : newHF > 1.1 ? "text-warning" : "text-error"}`}>{newHF.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between"><span>New liq. price</span><span className="font-mono text-error">${newLiqPrice.toFixed(4)}</span></div>
                      {parseFloat(borrowAmt) > Math.min(p.maxBorrow, p.availableLiquidity) && <div className="text-error font-semibold">Exceeds capacity!</div>}
                    </div>
                  );
                })()}
                <button className="btn btn-warning btn-sm w-full" onClick={handleBorrow}
                  disabled={actionLoading || !borrowAmt || parseFloat(borrowAmt) <= 0 || parseFloat(borrowAmt) > Math.min(p.maxBorrow, p.availableLiquidity)}>
                  {actionLoading ? <span className="loading loading-spinner loading-xs" /> : "Borrow USDC"}
                </button>
              </div>
            )}

            {showRepay && p && (
              <div className="bg-base-300 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs opacity-50">Repay USDC — wallet: {p.usdcBalance.toFixed(2)} | debt: {p.totalBorrowUsd.toFixed(2)}</div>
                  <button className="btn btn-ghost btn-xs" onClick={() => setShowRepay(false)}>Cancel</button>
                </div>
                <div className="flex gap-2">
                  <input className="input input-bordered bg-base-200 flex-1 font-mono text-sm"
                    placeholder="0.00" value={repayAmt === "max" ? `${p.totalBorrowUsd.toFixed(2)} (all)` : repayAmt}
                    onChange={e => setRepayAmt(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" />
                  <button className="btn btn-ghost btn-xs self-center" onClick={() => setRepayAmt("max")}>ALL</button>
                </div>
                {repayAmt && repayAmt !== "max" && parseFloat(repayAmt) > 0 && (() => {
                  const remaining = Math.max(0, p.totalBorrowUsd - parseFloat(repayAmt));
                  const newHF = remaining > 0 ? p.totalCollateralUsd * (p.liqThreshPct / 100) / remaining : null;
                  return (
                    <div className="text-xs space-y-1 opacity-70">
                      <div className="flex justify-between"><span>Remaining debt</span><span className="font-mono">${remaining.toFixed(2)}</span></div>
                      <div className="flex justify-between"><span>New health factor</span>
                        <span className="font-mono text-success">{newHF ? newHF.toFixed(2) : "∞ (no debt)"}</span>
                      </div>
                    </div>
                  );
                })()}
                {repayAmt === "max" && (
                  <div className="text-xs opacity-70">Repaying full debt — health factor → ∞</div>
                )}
                <button className="btn btn-info btn-sm w-full" onClick={handleRepay}
                  disabled={actionLoading || !repayAmt}>
                  {actionLoading ? <span className="loading loading-spinner loading-xs" /> : repayAmt === "max" ? "Repay All" : "Repay USDC"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Market Parameters (collapsible) */}
      {p && (
        <div className="panel">
          <div className="card-body p-4 gap-2">
            <button className="flex items-center justify-between w-full text-sm" onClick={() => setShowMarketParams(!showMarketParams)}>
              <span className="font-semibold opacity-70">Market Parameters</span>
              <span className="opacity-40">{showMarketParams ? "▲" : "▼"}</span>
            </button>
            {showMarketParams && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mt-2">
                <div><span className="opacity-40">LTV</span><div className="font-mono font-bold">{p.ltvPct}%</div></div>
                <div><span className="opacity-40">Liq Threshold</span><div className="font-mono font-bold">{p.liqThreshPct}%</div></div>
                <div><span className="opacity-40">Pool Liquidity</span><div className="font-mono font-bold">{p.availableLiquidity.toFixed(2)} USDC</div></div>
                <div><span className="opacity-40">Collateral Yield</span><div className="font-mono font-bold text-success">~8-12% APY</div></div>
                <div><span className="opacity-40">Obligation ID</span><div className="font-mono">{OB_ID}</div></div>
                <div><span className="opacity-40">Obligation</span><div className="font-mono text-xs">{p.address.slice(0, 16)}...</div></div>
                <div><span className="opacity-40">Market</span><div className="font-mono text-xs">{MARKET.toBase58().slice(0, 16)}...</div></div>
                <div><span className="opacity-40">Borrow Rate</span><div className="font-mono">{p.borrowAPR !== null ? `${(p.borrowAPR * 100).toFixed(2)}% APR` : "—"}</div></div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
