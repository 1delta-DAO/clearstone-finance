import { useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import * as crypto from "crypto";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");
const DUSDY_RESERVE = new PublicKey("HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw");
const DUSDY_ORACLE = new PublicKey("EZxvCYEjyogA2R1Eppz1AWyxhgjZWs4nXQRk3RC2yRLt");
const USDC_RESERVE = new PublicKey("7fYbqqcWnUvz3ffH6knnRRoRhDYaK4MgHH8Cj1Uwii4j");
const USDC_ORACLE = new PublicKey("CRhtYFcS32PBbRBrP31JafW15DpPpydZPKMnbkyuiD7W");
const USDC_MINT = new PublicKey("6qcmJLYuJbBQscq1aB5XW9md6oUkkaoKx8XsEW5TaAgp");

function disc(name: string) {
  return Buffer.from(crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
}

export default function BorrowPage() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleBorrow() {
    if (!publicKey || !amount) return;
    setLoading(true);
    setStatus({ msg: "Building borrow transaction...", type: "info" });

    try {
      const amountLamports = BigInt(Math.floor(parseFloat(amount) * 1e6));

      // Find obligation
      const [obPda] = PublicKey.findProgramAddressSync(
        [Buffer.from([0]), Buffer.from([0]), publicKey.toBuffer(), MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
        KLEND
      );
      const obInfo = await connection.getAccountInfo(obPda);
      if (!obInfo) {
        setStatus({ msg: "No obligation found. Deposit collateral first.", type: "error" });
        setLoading(false);
        return;
      }

      const [lma] = PublicKey.findProgramAddressSync([Buffer.from("lma"), MARKET.toBuffer()], KLEND);
      const [usdcLiqSupply] = PublicKey.findProgramAddressSync([Buffer.from("reserve_liq_supply"), USDC_RESERVE.toBuffer()], KLEND);
      const [usdcFeeRecv] = PublicKey.findProgramAddressSync([Buffer.from("fee_receiver"), USDC_RESERVE.toBuffer()], KLEND);
      const userUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, publicKey);

      const tx = new Transaction();

      // Refresh both reserves
      for (const [reserve, oracle] of [[DUSDY_RESERVE, DUSDY_ORACLE], [USDC_RESERVE, USDC_ORACLE]]) {
        tx.add({
          programId: KLEND, data: disc("refresh_reserve"),
          keys: [
            { pubkey: reserve, isSigner: false, isWritable: true },
            { pubkey: MARKET, isSigner: false, isWritable: false },
            { pubkey: oracle, isSigner: false, isWritable: false },
            { pubkey: KLEND, isSigner: false, isWritable: false },
            { pubkey: KLEND, isSigner: false, isWritable: false },
            { pubkey: KLEND, isSigner: false, isWritable: false },
          ],
        });
      }

      // RefreshObligation (1 deposit: dUSDY)
      tx.add({
        programId: KLEND, data: disc("refresh_obligation"),
        keys: [
          { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: DUSDY_RESERVE, isSigner: false, isWritable: false },
        ],
      });

      // Create USDC ATA if needed
      const usdcAtaInfo = await connection.getAccountInfo(userUsdcAta);
      if (!usdcAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(publicKey, userUsdcAta, publicKey, USDC_MINT));
      }

      // Borrow
      const amtBuf = Buffer.alloc(8);
      amtBuf.writeBigUInt64LE(amountLamports, 0);
      tx.add({
        programId: KLEND,
        data: Buffer.concat([disc("borrow_obligation_liquidity"), amtBuf]),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: false },
          { pubkey: obPda, isSigner: false, isWritable: true },
          { pubkey: MARKET, isSigner: false, isWritable: false },
          { pubkey: lma, isSigner: false, isWritable: false },
          { pubkey: USDC_RESERVE, isSigner: false, isWritable: true },
          { pubkey: USDC_MINT, isSigner: false, isWritable: false },
          { pubkey: usdcLiqSupply, isSigner: false, isWritable: true },
          { pubkey: usdcFeeRecv, isSigner: false, isWritable: true },
          { pubkey: userUsdcAta, isSigner: false, isWritable: true },
          { pubkey: KLEND, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
      });

      setStatus({ msg: "Confirm in wallet...", type: "info" });
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      setStatus({ msg: `Borrowed ${amount} USDC`, type: "success" });
      setAmount("");
    } catch (e: any) {
      setStatus({ msg: `Failed: ${e.message?.slice(0, 120)}`, type: "error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Borrow USDC</h2>
      <p className="text-base-content/60">
        Borrow USDC against your deposited collateral. Maximum borrow is 75% of collateral value.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card bg-base-200 border border-base-300">
          <div className="card-body p-6 gap-4">
            <h3 className="card-title">Borrow USDC</h3>

            <div className="flex gap-2">
              <input
                className="input input-bordered bg-base-300 text-base-content flex-1 font-mono"
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
              />
              <span className="self-center text-sm text-base-content/60 font-mono">USDC</span>
            </div>

            <button
              className="btn btn-warning w-full"
              onClick={handleBorrow}
              disabled={loading || !amount || parseFloat(amount) <= 0}
            >
              {loading ? <span className="loading loading-spinner loading-sm" /> : "Borrow USDC"}
            </button>

            {status && (
              <div className={`alert ${status.type === "success" ? "alert-success" : status.type === "error" ? "alert-error" : "alert-info"} text-sm`}>
                {status.msg}
              </div>
            )}
          </div>
        </div>

        <div className="card bg-base-200 border border-base-300">
          <div className="card-body p-6 gap-4">
            <h3 className="card-title">Borrow Details</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-base-content/60">Borrow Asset</span>
                <span className="font-mono">USDC</span>
              </div>
              <div className="flex justify-between">
                <span className="text-base-content/60">Interest Rate</span>
                <span className="font-mono">~5% APY</span>
              </div>
              <div className="flex justify-between">
                <span className="text-base-content/60">Max LTV</span>
                <span className="font-mono">75%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-base-content/60">Collateral Yield</span>
                <span className="font-mono text-success">~10% APY</span>
              </div>
              <div className="divider my-1"></div>
              <div className="flex justify-between font-bold">
                <span className="text-base-content/60">Net Carry</span>
                <span className="font-mono text-success">~+5% APY</span>
              </div>
            </div>

            <div className="alert alert-warning text-xs mt-2">
              Borrowing creates a debt obligation. If your health factor drops below 1.0,
              your collateral may be liquidated.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
