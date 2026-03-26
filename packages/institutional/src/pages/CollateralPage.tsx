import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as crypto from "crypto";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");
const DUSDY_RESERVE = new PublicKey("HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw");
const DUSDY_ORACLE = new PublicKey("EZxvCYEjyogA2R1Eppz1AWyxhgjZWs4nXQRk3RC2yRLt");
const DUSDY_MINT = new PublicKey("ALqRkS5GdVYWUFLzsL3xbKCxkoMxe2p23UUP9Waddwfx");

function disc(name: string) {
  return Buffer.from(crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
}

export default function CollateralPage() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [status, setStatus] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [obligationAddr, setObligationAddr] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey) return;
    // Load dUSDY balance
    const ata = getAssociatedTokenAddressSync(DUSDY_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID);
    connection.getAccountInfo(ata).then(info => {
      if (info) setBalance(Number(info.data.readBigUInt64LE(64)) / 1e6);
      else setBalance(0);
    });

    // Check obligation
    const tag = 0, id = 0;
    const [obPda] = PublicKey.findProgramAddressSync(
      [Buffer.from([tag]), Buffer.from([id]), publicKey.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
      KLEND
    );
    connection.getAccountInfo(obPda).then(info => {
      if (info) setObligationAddr(obPda.toBase58());
    });
  }, [publicKey, connection]);

  async function handleDeposit() {
    if (!publicKey || !amount) return;
    setLoading(true);
    setStatus({ msg: "Building transaction...", type: "info" });

    try {
      const amountLamports = BigInt(Math.floor(parseFloat(amount) * 1e6));
      const tx = new Transaction();

      // Init obligation if needed
      const tag = 0, id = 0;
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from([tag]), Buffer.from([id]), publicKey.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
        KLEND
      );
      const [userMeta] = PublicKey.findProgramAddressSync([Buffer.from("user_meta"), publicKey.toBuffer()], KLEND);

      if (!obligationAddr) {
        // Init user metadata if needed
        const umInfo = await connection.getAccountInfo(userMeta);
        if (!umInfo) {
          tx.add({
            programId: KLEND,
            data: Buffer.concat([disc("init_user_metadata"), Buffer.alloc(32)]),
            keys: [
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: publicKey, isSigner: true, isWritable: true },
              { pubkey: userMeta, isSigner: false, isWritable: true },
              { pubkey: MARKET, isSigner: false, isWritable: false },
              { pubkey: KLEND, isSigner: false, isWritable: false },
              { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
              { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
          });
        }

        tx.add({
          programId: KLEND,
          data: Buffer.concat([disc("init_obligation"), Buffer.from([tag, id])]),
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: false },
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: obPda, isSigner: false, isWritable: true },
            { pubkey: MARKET, isSigner: false, isWritable: false },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: userMeta, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
        });
      }

      // RefreshReserve
      tx.add({
        programId: KLEND, data: disc("refresh_reserve"),
        keys: [
          { pubkey: DUSDY_RESERVE, isSigner: false, isWritable: true },
          { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: DUSDY_ORACLE, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: KLEND, isSigner: false, isWritable: false },
        ],
      });

      // RefreshObligation
      tx.add({
        programId: KLEND, data: disc("refresh_obligation"),
        keys: [
          { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          ...(obligationAddr ? [{ pubkey: DUSDY_RESERVE, isSigner: false, isWritable: false }] : []),
        ],
      });

      // Deposit
      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [liqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), DUSDY_RESERVE.toBuffer()], KLEND);
      const [collMint] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_mint"), DUSDY_RESERVE.toBuffer()], KLEND);
      const [collSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_coll_supply"), DUSDY_RESERVE.toBuffer()], KLEND);
      const userAta = getAssociatedTokenAddressSync(DUSDY_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID);

      const amtBuf = Buffer.alloc(8);
      amtBuf.writeBigUInt64LE(amountLamports, 0);

      tx.add({
        programId: KLEND,
        data: Buffer.concat([disc("deposit_reserve_liquidity_and_obligation_collateral"), amtBuf]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: lma, isSigner: false, isWritable: false },
          { pubkey: DUSDY_RESERVE, isSigner: false, isWritable: true },
          { pubkey: DUSDY_MINT, isSigner: false, isWritable: false },
          { pubkey: liqSupply, isSigner: false, isWritable: true },
          { pubkey: collMint, isSigner: false, isWritable: true },
          { pubkey: collSupply, isSigner: false, isWritable: true },
          { pubkey: userAta, isSigner: false, isWritable: true },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
      });

      setStatus({ msg: "Confirm in wallet...", type: "info" });
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatus({ msg: `Deposited ${amount} dUSDY as collateral`, type: "success" });
      setObligationAddr(obPda.toBase58());
      setAmount("");
    } catch (e: any) {
      setStatus({ msg: `Failed: ${e.message?.slice(0, 100)}`, type: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Supply Collateral</h2>
      <p className="text-base-content/60">
        Deposit KYC-wrapped tokens as collateral to borrow against.
        Your collateral earns yield while locked.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Deposit Card */}
        <div className="card bg-base-200 border border-base-300">
          <div className="card-body p-6 gap-4">
            <h3 className="card-title">Deposit dUSDY</h3>
            <p className="text-sm text-base-content/60">
              dUSDY balance: <span className="font-mono">{balance !== null ? balance.toFixed(2) : "..."}</span>
            </p>

            <div className="flex gap-2">
              <input
                className="input input-bordered bg-base-300 text-base-content flex-1 font-mono"
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
              />
              <button
                className="btn btn-ghost btn-sm self-center"
                onClick={() => balance && setAmount(balance.toString())}
              >
                MAX
              </button>
            </div>

            <button
              className="btn btn-primary w-full"
              onClick={handleDeposit}
              disabled={loading || !amount || parseFloat(amount) <= 0}
            >
              {loading ? <span className="loading loading-spinner loading-sm" /> : "Deposit Collateral"}
            </button>

            {status && (
              <div className={`alert ${status.type === "success" ? "alert-success" : status.type === "error" ? "alert-error" : "alert-info"} text-sm`}>
                {status.msg}
              </div>
            )}
          </div>
        </div>

        {/* Info Card */}
        <div className="card bg-base-200 border border-base-300">
          <div className="card-body p-6 gap-4">
            <h3 className="card-title">Collateral Details</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-base-content/60">Asset</span>
                <span className="font-mono">dUSDY (KYC-wrapped USDY)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-base-content/60">Oracle Price</span>
                <span className="font-mono text-success">$1.08</span>
              </div>
              <div className="flex justify-between">
                <span className="text-base-content/60">LTV</span>
                <span className="font-mono">75%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-base-content/60">Liquidation Threshold</span>
                <span className="font-mono">85%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-base-content/60">Yield on Collateral</span>
                <span className="font-mono text-success">~10% APY</span>
              </div>
              <div className="divider my-1"></div>
              <div className="flex justify-between">
                <span className="text-base-content/60">Obligation</span>
                <span className="font-mono text-xs">
                  {obligationAddr ? obligationAddr.slice(0, 12) + "..." : "Not created yet"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
