import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
// Keep Keypair import path resolved by send() helper signature even though
// we no longer instantiate one — extraSigners parameter still types as Keypair[].
import type { Keypair } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CSSOL_MINT,
  CSSOL_RESERVE,
  CSSOL_RESERVE_ORACLE,
  CSSOL_VAULT,
  CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  CSSOL_VRT_MINT,
  CSSOL_WT_MINT,
  CSSOL_WT_RESERVE,
  DEPOSIT_LUT,
  JITO_VAULT_PROGRAM,
  POOL_PENDING_WSOL_ACCOUNT,
  POOL_PDA,
} from "../lib/addresses";
import {
  buildDepositLiquidityAndCollateralIx,
  buildFlashBorrowIx,
  buildFlashRepayIx,
  buildRefreshObligationIx,
  buildRefreshReserveIx,
  buildWithdrawCollateralAndRedeemIx,
} from "../lib/klend";
import {
  buildEnqueueWithdrawViaPoolIx,
  buildMatureWithdrawalTicketsIx,
  buildRedeemCsSolWtIx,
  decodeJitoConfigEpochLength,
  decodeTicketSlotUnstaked,
  decodeWithdrawQueue,
  withdrawBasePda,
  withdrawQueuePda,
  type DecodedQueue,
} from "../lib/cssolWt";
import { readVaultState } from "../lib/jitoVault";

function short(p: string | PublicKey, n = 6): string {
  const s = typeof p === "string" ? p : p.toBase58();
  return `${s.slice(0, n)}…${s.slice(-4)}`;
}

export default function OneStepUnwindTab() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [queue, setQueue] = useState<DecodedQueue | null>(null);
  const [cssolBal, setCssolBal] = useState<bigint>(0n);
  const [cssolWtBal, setCssolWtBal] = useState<bigint>(0n);
  const [feeWallet, setFeeWallet] = useState<PublicKey | null>(null);
  const [amount, setAmount] = useState<string>("0.005");
  const [redeemAmount, setRedeemAmount] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Per-ticket unlock targets — keyed by ticket PDA base58. Populated
  // when the queue is loaded and used to render countdowns.
  const [ticketUnlockSlot, setTicketUnlockSlot] = useState<Record<string, bigint>>({});
  const [epochLength, setEpochLength] = useState<bigint | null>(null);
  // Cluster reference points so we can extrapolate "now in slot-space"
  // each second without hitting RPC. `clusterNowMs` is the wall-clock
  // when we last sampled `clusterSlot`; we project forward at ~400ms/slot.
  const [clusterSlot, setClusterSlot] = useState<bigint | null>(null);
  const [clusterNowMs, setClusterNowMs] = useState<number>(Date.now());
  const [tick, setTick] = useState(0); // forces 1Hz re-render for countdowns
  const SLOT_DURATION_MS = 400; // devnet/mainnet target slot time

  const refresh = async () => {
    try {
      const queueAddr = withdrawQueuePda();
      const queueInfo = await connection.getAccountInfo(queueAddr, "confirmed");
      const decodedQueue = queueInfo ? decodeWithdrawQueue(queueInfo.data) : null;
      setQueue(decodedQueue);

      // Cache vault state once for fee_wallet (used in mature_withdrawal_tickets)
      try {
        const v = await readVaultState(connection, CSSOL_VAULT);
        setFeeWallet(v.feeWallet);
      } catch { /* ignore */ }

      // Sample current cluster slot for countdown extrapolation.
      try {
        const slot = await connection.getSlot("confirmed");
        setClusterSlot(BigInt(slot));
        setClusterNowMs(Date.now());
      } catch { /* keep stale slot if RPC stutters */ }

      // Load Jito Config's epoch_length once + each live ticket's
      // slot_unstaked. Unlock condition: ticket withdrawable when
      // current_epoch >= ticket_unstake_epoch + 2 — that's
      // (floor(slot_unstaked / epoch_length) + 2) * epoch_length.
      try {
        const [jitoCfg] = PublicKey.findProgramAddressSync(
          [new TextEncoder().encode("config")],
          JITO_VAULT_PROGRAM,
        );
        const cfgInfo = await connection.getAccountInfo(jitoCfg, "confirmed");
        const epochLen = cfgInfo ? decodeJitoConfigEpochLength(cfgInfo.data) : null;
        setEpochLength(epochLen);

        if (epochLen && epochLen > 0n && decodedQueue) {
          const live = decodedQueue.tickets.filter((t) => !t.redeemed);
          if (live.length > 0) {
            const infos = await connection.getMultipleAccountsInfo(
              live.map((t) => t.ticketPda), "confirmed",
            );
            const unlocks: Record<string, bigint> = {};
            for (let i = 0; i < live.length; i++) {
              const info = infos[i];
              if (!info) continue;
              const slotUnstaked = decodeTicketSlotUnstaked(info.data);
              const unstakeEpoch = slotUnstaked / epochLen;
              const unlockEpoch = unstakeEpoch + 2n;
              unlocks[live[i].ticketPda.toBase58()] = unlockEpoch * epochLen;
            }
            setTicketUnlockSlot(unlocks);
          } else {
            setTicketUnlockSlot({});
          }
        }
      } catch { /* ignore — countdowns just won't render */ }

      if (wallet.publicKey) {
        const csAta = getAssociatedTokenAddressSync(CSSOL_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        try {
          const bal = await connection.getTokenAccountBalance(csAta, "confirmed");
          setCssolBal(BigInt(bal.value.amount));
        } catch { setCssolBal(0n); }

        if (CSSOL_WT_MINT) {
          const wtAta = getAssociatedTokenAddressSync(CSSOL_WT_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
          try {
            const bal = await connection.getTokenAccountBalance(wtAta, "confirmed");
            setCssolWtBal(BigInt(bal.value.amount));
          } catch { setCssolWtBal(0n); }
        }
      }
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [wallet.publicKey, connection]);

  // 1Hz tick to re-render countdowns. The slot-space cursor is
  // extrapolated from (clusterSlot, clusterNowMs) using SLOT_DURATION_MS,
  // so we don't hammer RPC each second. A full `refresh()` happens on
  // mount + after each tx + on the user clicking Refresh — that
  // re-syncs the cluster slot reference.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Live "what slot is it right now" extrapolated from the last RPC sample.
  function projectedSlot(): bigint | null {
    if (clusterSlot === null) return null;
    void tick; // keeps this function reactive to the 1Hz tick
    const elapsedMs = Date.now() - clusterNowMs;
    const elapsedSlots = BigInt(Math.floor(elapsedMs / SLOT_DURATION_MS));
    return clusterSlot + elapsedSlots;
  }

  // Format "Nd Nh Nm Ns" style countdown from a number of seconds.
  function fmtCountdown(seconds: number): string {
    if (seconds <= 0) return "ready";
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  async function send(tx: Transaction, label: string, extraSigners: Keypair[] = []) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not connected");
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    // Partial-sign with each ephemeral keypair (e.g. enqueue's `base`).
    // Wallet's signTransaction adds the user's signature on top.
    if (extraSigners.length > 0) tx.partialSign(...extraSigners);
    setLog((l) => [...l, `signing ${label} …`]);
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    setLog((l) => [...l, `submitted ${label}: ${sig}`]);
    await connection.confirmTransaction(sig, "confirmed");
    const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (receipt?.meta?.err) {
      const logs = receipt.meta.logMessages?.slice(-10).join("\n") ?? "";
      throw new Error(`${label} on-chain err: ${JSON.stringify(receipt.meta.err)}\n${logs}`);
    }
    setLog((l) => [...l, `✓ confirmed ${label}`]);
    return sig;
  }

  // Cache LUT once for the leveraged unwind path.
  const [lutAccount, setLutAccount] = useState<AddressLookupTableAccount | null>(null);
  useEffect(() => {
    if (!DEPOSIT_LUT) return;
    let cancelled = false;
    void connection.getAddressLookupTable(DEPOSIT_LUT, { commitment: "confirmed" })
      .then((r) => { if (!cancelled) setLutAccount(r.value ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [connection]);

  /**
   * Single-signature leveraged-position unwind via klend flash-loan.
   *
   * Flow (one atomic tx, fits with the deposit LUT):
   *   1. flashBorrow(WT_RESERVE, X) → user_cssol_wt_ata gets X tokens (loan)
   *   2. refresh_reserve(WT) + refresh_reserve(csSOL)
   *   3. refresh_obligation([csSOL])  // pre-deposit state
   *   4. deposit_reserve_liquidity_and_obligation_collateral(WT, X)
   *      → cTokens minted into obligation (LTV improves: csSOL + WT both back the borrow)
   *   5. refresh_reserve(csSOL) + refresh_obligation([csSOL, WT])
   *   6. withdraw_obligation_collateral_and_redeem_reserve_collateral(csSOL, X)
   *      → X cTokens redeemed back to X csSOL liquidity in user's csSOL ATA
   *   7. governor::enqueue_withdraw_via_pool(X)
   *      → burns X csSOL, mints X csSOL-WT, queues VRT in Jito ticket
   *   8. flashRepay(WT_RESERVE, X, borrow_ix_idx=N)
   *      → repays the flash loan with the freshly-minted csSOL-WT
   *
   * Net effect: csSOL collateral atomically swapped for csSOL-WT
   * collateral; user's wSOL borrow position untouched throughout (LTV
   * preserved within eMode 2). Zero price impact (no AMM), zero fees
   * (flashLoanFee=0, verified on-chain).
   */
  async function leveragedUnwind() {
    if (!wallet.publicKey || !CSSOL_WT_MINT || !CSSOL_WT_RESERVE || !DEPOSIT_LUT) return;
    if (!lutAccount) { setError("LUT not loaded"); return; }
    setBusy(true); setError(null);
    setLog([`assembling leveraged-unwind for ${amount} csSOL …`]);
    try {
      const owner = wallet.publicKey;
      const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");

      const [jitoConfig] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")], JITO_VAULT_PROGRAM,
      );

      // Per-call base = governor PDA derived from (pool, queue.total_minted).
      // No client-side keypair; the program signs via invoke_signed.
      if (!queue) throw new Error("queue not loaded yet — refresh and retry");
      const basePubkey = withdrawBasePda(queue.totalCssolWtMinted);
      const [vaultStakerWithdrawalTicket] = PublicKey.findProgramAddressSync(
        [
          new TextEncoder().encode("vault_staker_withdrawal_ticket"),
          CSSOL_VAULT.toBuffer(), basePubkey.toBuffer(),
        ],
        JITO_VAULT_PROGRAM,
      );
      const ticketVrtAta = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, vaultStakerWithdrawalTicket, true,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      // ATAs we need pre-existing.
      const userCssolAta = getAssociatedTokenAddressSync(
        CSSOL_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const userCssolWtAta = getAssociatedTokenAddressSync(
        CSSOL_WT_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const userVrtAta = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      // Where in the outer ix list will flashBorrow sit? Indexes are
      // 0-based and DO count ATA-create + ComputeBudget ixes. We'll
      // assemble first, then fill in the borrow_ix_idx for flashRepay
      // based on actual position.
      const ixes: TransactionInstruction[] = [];

      // 0-1: compute budget. Successful tx consumed ~1.18M of the prior
      // 1.4M cap; 1.2M is comfortable headroom and reduces the
      // "high-CU == suspicious" heuristic flag in some wallets.
      ixes.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }));
      ixes.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }));

      // 2-5: idempotent ATA creates (some may already exist)
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userCssolAta, owner, CSSOL_MINT,
        TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userCssolWtAta, owner, CSSOL_WT_MINT,
        TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, userVrtAta, owner, CSSOL_VRT_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));
      ixes.push(createAssociatedTokenAccountIdempotentInstruction(
        owner, ticketVrtAta, vaultStakerWithdrawalTicket, CSSOL_VRT_MINT,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ));

      // 6: flash_borrow csSOL-WT — record this position for flash_repay's borrow_ix_idx.
      const borrowIxIdx = ixes.length;
      const wtLiqSupply = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("reserve_liq_supply"), CSSOL_WT_RESERVE.toBuffer()],
        new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      )[0];
      ixes.push(await buildFlashBorrowIx({
        user: owner, reserve: CSSOL_WT_RESERVE, liquidityMint: CSSOL_WT_MINT,
        reserveSourceLiquidity: wtLiqSupply, userDestinationLiquidity: userCssolWtAta,
        liquidityTokenProgram: TOKEN_2022_PROGRAM_ID, amount: lamports,
      }));

      // Read the obligation's current deposit reserves so refresh_obligation
      // gets the right remaining-accounts list. After a previous
      // leveraged-unwind, the obligation has BOTH csSOL and csSOL-WT;
      // hardcoding [csSOL] trips InvalidAccountInput (6006).
      const obAddr = PublicKey.findProgramAddressSync(
        [
          new TextEncoder().encode("user_meta"), // unused; placeholder for syntactic correctness
        ], JITO_VAULT_PROGRAM, // unused
      )[0]; void obAddr;
      const obligationAddr = PublicKey.findProgramAddressSync(
        [Uint8Array.from([0]), Uint8Array.from([0]), owner.toBuffer(),
         new PublicKey("2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW").toBuffer(),
         PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
        new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
      )[0];
      const obAccount = await connection.getAccountInfo(obligationAddr, "confirmed");
      const preDepositReserves: PublicKey[] = [];
      if (obAccount && obAccount.data.length >= 2286) {
        for (let i = 0; i < 8; i++) {
          const off = 96 + i * 136;
          const slotBytes = obAccount.data.subarray(off, off + 32);
          if (slotBytes.some((b) => b !== 0)) {
            preDepositReserves.push(new PublicKey(slotBytes));
          }
        }
      }
      // For the post-deposit refresh, the WT reserve will also be present.
      // CSSOL_WT_RESERVE is null-checked at function entry; alias for narrowing.
      const wtReserve = CSSOL_WT_RESERVE;
      const postDepositReserves = preDepositReserves.some((r) => r.equals(wtReserve))
        ? preDepositReserves
        : [...preDepositReserves, wtReserve];

      // Refresh every reserve referenced by the obligation BEFORE any
      // refresh_obligation. Same-tx refreshes stay fresh for the whole
      // tx, so each reserve only needs one upfront refresh. klend's
      // positional check_refresh requires the IMMEDIATE N-2 to be
      // refresh_reserve(<that reserve>) for each deposit/withdraw ix —
      // we satisfy that by the targeted refresh_reserve calls below.
      for (const r of preDepositReserves) {
        if (!r.equals(CSSOL_RESERVE) && !r.equals(CSSOL_WT_RESERVE)) {
          // any other reserve uses the csSOL accrual oracle in v1
          ixes.push(await buildRefreshReserveIx(r, CSSOL_RESERVE_ORACLE));
        }
      }
      ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));

      // refresh_reserve(WT) + refresh_obligation(preDepositReserves)
      // — N-2 / N-1 for the deposit ix below. preDepositReserves
      // mirrors what's already on the obligation so klend's
      // expected==actual check passes.
      ixes.push(await buildRefreshReserveIx(CSSOL_WT_RESERVE, CSSOL_RESERVE_ORACLE));
      ixes.push(await buildRefreshObligationIx(owner, preDepositReserves));

      // deposit X csSOL-WT into obligation as collateral
      ixes.push(await buildDepositLiquidityAndCollateralIx({
        user: owner, reserve: CSSOL_WT_RESERVE,
        liquidityMint: CSSOL_WT_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
        userSourceLiquidity: userCssolWtAta, amount: lamports,
      }));

      // The deposit just modified the WT reserve's liquidity supply,
      // which marks last_update.stale=1. Re-refresh WT before the
      // refresh_obligation that follows — otherwise klend trips
      // ReserveStale when iterating the obligation's deposits.
      ixes.push(await buildRefreshReserveIx(CSSOL_WT_RESERVE, CSSOL_RESERVE_ORACLE));

      // refresh_reserve(csSOL) at N-2 + refresh_obligation(post-deposit list)
      // at N-1 for the withdraw ix. Obligation now holds preDepositReserves
      // plus WT. Same-tx refreshes stay valid, so we only need
      // refresh_reserve(csSOL) here as the positional N-2 placeholder.
      ixes.push(await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE));
      ixes.push(await buildRefreshObligationIx(owner, postDepositReserves));

      // withdraw X csSOL collateral as liquidity (assumes 1:1 cToken↔liquidity at fresh exchange rate).
      // refreshObligationDeposits is what stays on the obligation AFTER
      // this withdraw — i.e. postDepositReserves minus the reserve being
      // partially withdrawn (csSOL). For partial withdraws, csSOL stays
      // in the list (some collateral remains).
      const remainingAfterWithdraw = postDepositReserves; // partial withdraw → csSOL still present
      ixes.push(await buildWithdrawCollateralAndRedeemIx({
        user: owner, reserve: CSSOL_RESERVE,
        liquidityMint: CSSOL_MINT, liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
        userDestinationLiquidity: userCssolAta, collateralAmount: lamports,
        refreshObligationDeposits: remainingAfterWithdraw,
      }));

      // 13: governor::enqueue_withdraw_via_pool — burns the just-withdrawn csSOL,
      // mints fresh csSOL-WT to the user (which they'll use to repay the flash).
      const enqueueIx = await buildEnqueueWithdrawViaPoolIx({
        user: owner, base: basePubkey, amount: lamports,
        cssolWtMint: CSSOL_WT_MINT, vrtMint: CSSOL_VRT_MINT,
        vaultStakerWithdrawalTicket, vaultStakerWithdrawalTicketTokenAccount: ticketVrtAta,
        jitoVaultConfig: jitoConfig,
      });
      ixes.push(enqueueIx);

      // 14: flash_repay
      ixes.push(await buildFlashRepayIx({
        user: owner, reserve: CSSOL_WT_RESERVE, liquidityMint: CSSOL_WT_MINT,
        reserveDestinationLiquidity: wtLiqSupply, userSourceLiquidity: userCssolWtAta,
        liquidityTokenProgram: TOKEN_2022_PROGRAM_ID,
        amount: lamports, borrowInstructionIndex: borrowIxIdx,
      }));

      // Compile to v0 with LUT (compresses static accounts to 1-byte indices)
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: owner, recentBlockhash: blockhash, instructions: ixes,
      }).compileToV0Message([lutAccount]);
      const vtx = new VersionedTransaction(msg);
      const serialized = vtx.serialize();
      setLog((l) => [...l, `tx assembled: ${ixes.length} ixes, ${serialized.length} bytes (limit 1232)`]);
      if (serialized.length > 1232) throw new Error(`tx too large: ${serialized.length} > 1232`);

      // Single-signer now: user via wallet. Base is a governor PDA
      // signed via invoke_signed inside the program.
      if (!wallet.signTransaction) throw new Error("wallet has no signTransaction");
      const signed = await wallet.signTransaction(vtx);
      setLog((l) => [...l, "submitting …"]);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      setLog((l) => [...l, `submitted: ${sig}`]);
      await connection.confirmTransaction(sig, "confirmed");
      const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (receipt?.meta?.err) {
        const logs = receipt.meta.logMessages?.slice(-12).join("\n") ?? "";
        throw new Error(`leveraged unwind on-chain err: ${JSON.stringify(receipt.meta.err)}\n${logs}`);
      }
      setLog((l) => [...l, "✓ confirmed"]);
      await refresh();
    } catch (e: any) {
      setError(`${e.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  async function enqueueUnwind() {
    if (!wallet.publicKey || !CSSOL_WT_MINT) return;
    setBusy(true); setError(null);
    setLog([`assembling enqueue-unwind for ${amount} csSOL …`]);
    try {
      const owner = wallet.publicKey;
      const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");

      const [jitoConfig] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")],
        JITO_VAULT_PROGRAM,
      );

      // Ticket PDA seeds: [b"vault_staker_withdrawal_ticket", vault, base].
      // `base` is a governor-derived PDA per (pool, queue.total_minted),
      // signed via invoke_signed inside the program — no client-side
      // ephemeral keypair, no extra wallet-signer slot.
      if (!queue) throw new Error("queue not loaded yet — refresh and retry");
      const basePubkey = withdrawBasePda(queue.totalCssolWtMinted);
      const [vaultStakerWithdrawalTicket] = PublicKey.findProgramAddressSync(
        [
          new TextEncoder().encode("vault_staker_withdrawal_ticket"),
          CSSOL_VAULT.toBuffer(),
          basePubkey.toBuffer(),
        ],
        JITO_VAULT_PROGRAM,
      );
      // Ticket's VRT ATA, owned by the ticket PDA off-curve.
      const vaultStakerWithdrawalTicketTokenAccount = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, vaultStakerWithdrawalTicket, true,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      // User must have a csSOL-WT ATA to receive the freshly-minted WT.
      const userCssolWtAta = getAssociatedTokenAddressSync(
        CSSOL_WT_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      // User's VRT ATA — VRT moves pool→here transiently inside the
      // governor ix before Jito EnqueueWithdrawal consumes it.
      const userVrtAta = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const ixes: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
        // Idempotent ATA creates — cheap and safe to always include.
        createAssociatedTokenAccountIdempotentInstruction(
          owner, userCssolWtAta, owner, CSSOL_WT_MINT,
          TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        // User's VRT ATA — receives VRT transiently from the pool inside
        // the governor ix, then Jito drains it into the ticket.
        createAssociatedTokenAccountIdempotentInstruction(
          owner, userVrtAta, owner, CSSOL_VRT_MINT,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        // Pre-create the ticket's VRT ATA. Jito's EnqueueWithdrawal
        // expects this canonical ATA to already exist as an SPL Token
        // account — it does spl_token::transfer_checked into it but
        // doesn't allocate it itself (verified by inspecting an
        // existing on-chain ticket at c7JUyWj8…/3h653SPD…). Owner =
        // ticket_pda (off-curve), funder = user.
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          vaultStakerWithdrawalTicketTokenAccount,
          vaultStakerWithdrawalTicket,
          CSSOL_VRT_MINT,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        await buildEnqueueWithdrawViaPoolIx({
          user: owner,
          base: basePubkey,
          amount: lamports,
          cssolWtMint: CSSOL_WT_MINT,
          vrtMint: CSSOL_VRT_MINT,
          vaultStakerWithdrawalTicket,
          vaultStakerWithdrawalTicketTokenAccount,
          jitoVaultConfig: jitoConfig,
        }),
      ];

      const tx = new Transaction();
      ixes.forEach((ix) => tx.add(ix));
      // Single-signer flow now: user signs via the wallet, base is a
      // governor PDA signed via invoke_signed inside the program.
      await send(tx, "enqueue unwind");
      await refresh();
    } catch (e: any) {
      const onchainLogs = e?.transactionLogs ?? e?.logs ?? null;
      setError(`${e.message ?? e}${onchainLogs ? "\n\n" + onchainLogs.slice(-8).join("\n") : ""}`);
    } finally {
      setBusy(false);
    }
  }

  async function matureTicket(ticketPda: PublicKey) {
    if (!wallet.publicKey || !POOL_PENDING_WSOL_ACCOUNT || !feeWallet) return;
    setBusy(true); setError(null);
    setLog([`maturing ticket ${short(ticketPda)} …`]);
    try {
      const owner = wallet.publicKey;
      const [jitoConfig] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")],
        JITO_VAULT_PROGRAM,
      );
      const ticketTokenAccount = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, ticketPda, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      const vaultFeeAta = getAssociatedTokenAddressSync(
        CSSOL_VRT_MINT, feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      // Program fee ATA — same as vault fee until Jito Config's
      // program_fee_wallet is plumbed through.
      const programFeeAta = vaultFeeAta;
      const userWsolAta = getAssociatedTokenAddressSync(
        NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
        // Pre-create user's wSOL ATA — Jito's BurnWithdrawalTicket
        // CPI sends wSOL here as the staker_token_account. Same
        // "WritableAccount no init" pattern as the enqueue ticket ATA.
        .add(createAssociatedTokenAccountIdempotentInstruction(
          owner, userWsolAta, owner, NATIVE_MINT,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ))
        .add(await buildMatureWithdrawalTicketsIx({
          user: owner,
          vaultStakerWithdrawalTicket: ticketPda,
          vaultStakerWithdrawalTicketTokenAccount: ticketTokenAccount,
          vaultFeeTokenAccount: vaultFeeAta,
          programFeeTokenAccount: programFeeAta,
          jitoVaultConfig: jitoConfig,
          poolPendingWsolAccount: POOL_PENDING_WSOL_ACCOUNT,
        }));

      await send(tx, "mature ticket");
      await refresh();
    } catch (e: any) {
      setError(`${e.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    if (!wallet.publicKey || !CSSOL_WT_MINT || !POOL_PENDING_WSOL_ACCOUNT) return;
    setBusy(true); setError(null);
    setLog([`redeeming ${redeemAmount} csSOL-WT …`]);
    try {
      const owner = wallet.publicKey;
      const lamports = BigInt(Math.round(Number(redeemAmount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");
      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
        .add(createAssociatedTokenAccountIdempotentInstruction(
          owner, userWsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ))
        .add(await buildRedeemCsSolWtIx({
          user: owner,
          amount: lamports,
          cssolWtMint: CSSOL_WT_MINT,
          poolPendingWsolAccount: POOL_PENDING_WSOL_ACCOUNT,
        }));

      await send(tx, "redeem csSOL-WT");
      await refresh();
    } catch (e: any) {
      setError(`${e.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.publicKey) {
    return (
      <section className="max-w-3xl">
        <h2 className="text-2xl font-bold mb-2">Unwind — csSOL → wSOL → SOL</h2>
        <p className="opacity-70 mb-6">
          Three-stage unwind through the Jito vault: enqueue (burn csSOL, mint csSOL-WT, queue VRT
          for unstaking), wait for epoch unlock, then claim wSOL.
        </p>
        <div className="alert alert-warning"><span>Connect a wallet to start.</span></div>
      </section>
    );
  }

  const setupMissing = !CSSOL_WT_MINT || !POOL_PENDING_WSOL_ACCOUNT || !queue;
  const liveTickets = queue ? queue.tickets.filter((t) => !t.redeemed) : [];

  return (
    <section className="max-w-3xl space-y-6">
      <header>
        <h2 className="text-2xl font-bold">Unwind — csSOL → csSOL-WT → wSOL</h2>
        <p className="opacity-70 mt-1 text-sm">
          Burns csSOL, mints csSOL-WT (Token-2022, KYC-gated), queues the underlying VRT in a
          Jito withdrawal ticket. After Jito's epoch unlock window the ticket can be matured
          permissionlessly; csSOL-WT then redeems 1:1 for wSOL from the pool's pending pool.
        </p>
      </header>

      {setupMissing ? (
        <div className="alert alert-warning text-xs">
          <div>
            <p className="font-bold">csSOL-WT pipeline not fully deployed yet.</p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>VITE_CSSOL_WT_MINT: {CSSOL_WT_MINT ? "✓" : "missing — run scripts/setup-cssol-wt-mint.ts"}</li>
              <li>VITE_POOL_PENDING_WSOL_ACCOUNT: {POOL_PENDING_WSOL_ACCOUNT ? "✓" : "missing — run scripts/init-pool-pending-wsol.ts"}</li>
              <li>WithdrawQueue PDA: {queue ? "✓" : "not initialized — run scripts/init-withdraw-queue.ts"}</li>
            </ul>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Withdraw queue</div>
            {queue ? (
              <>
                <div>address: <code>{short(withdrawQueuePda())}</code></div>
                <div>pending wSOL pool: <code>{(Number(queue.pendingWsol) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
                <div>lifetime minted: <code>{(Number(queue.totalCssolWtMinted) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
                <div>lifetime redeemed: <code>{(Number(queue.totalCssolWtRedeemed) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
                <div>live tickets: <code>{liveTickets.length}</code> / 32</div>
              </>
            ) : <div className="opacity-60">queue not initialized</div>}
          </div>
        </div>

        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Wallet balances</div>
            <div>csSOL: <code>{(Number(cssolBal) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
            <div>csSOL-WT: <code>{(Number(cssolWtBal) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
          </div>
        </div>
      </div>

      {CSSOL_WT_RESERVE && DEPOSIT_LUT ? (
        <div className="card bg-base-300 border border-primary/30">
          <div className="card-body p-4 space-y-3">
            <div className="font-bold">Leveraged unwind via flash-loan collateral swap</div>
            <p className="text-xs opacity-80">
              For positions with active wSOL borrow against csSOL collateral. Single signature
              swaps your csSOL collateral for csSOL-WT collateral inside klend's eMode 2 (LTV
              preserved), then queues the underlying unstake — without ever needing external
              SOL liquidity to repay your borrow. Zero AMM impact, zero flash-loan fee
              (verified <code>flashLoanFeeSf = 0</code> on the WT reserve).
            </p>
            <p className="text-xs opacity-60">
              ix sequence: <code>flashBorrow(WT) → deposit_collateral(WT) → withdraw_collateral(csSOL) → enqueue → flashRepay(WT)</code>
            </p>
            <div className="flex items-center gap-2">
              <span className="text-sm opacity-70">amount: same as Step 1</span>
              <button className="btn btn-primary" onClick={leveragedUnwind} disabled={busy || setupMissing}>
                {busy ? <span className="loading loading-spinner loading-sm" /> : null}
                Unwind {amount} csSOL via flash-loan
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-3">
          <div className="font-bold">Step 1: enqueue unwind</div>
          <p className="text-xs opacity-70">
            Burns X csSOL, queues X VRT in a fresh Jito withdrawal ticket (pool PDA = staker), mints X csSOL-WT to your wallet.
          </p>
          <div className="flex items-center gap-2">
            <input type="number" step="0.001" min="0" className="input input-bordered w-48"
              value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
            <span className="text-sm opacity-70">csSOL</span>
            <button className="btn btn-primary" onClick={enqueueUnwind} disabled={busy || setupMissing}>
              {busy ? <span className="loading loading-spinner loading-sm" /> : null}
              Enqueue unwind
            </button>
          </div>
        </div>
      </div>

      {liveTickets.length > 0 ? (
        <div className="card bg-base-200">
          <div className="card-body p-4 space-y-3">
            <div className="font-bold">Step 2: mature tickets (permissionless)</div>
            <p className="text-xs opacity-70">
              Each ticket is locked until the next Jito vault epoch flip. Once unlocked, anyone can
              click <em>Mature</em> to burn the ticket and sweep wSOL into the pool's pending pool.
              Devnet epoch ≈ 75 s; mainnet ≈ 2 days.
            </p>
            <table className="table table-xs">
              <thead><tr><th>ticket</th><th>amount</th><th>unlocks in</th><th></th></tr></thead>
              <tbody>
                {liveTickets.map((t, i) => {
                  const unlockSlot = ticketUnlockSlot[t.ticketPda.toBase58()];
                  const nowSlot = projectedSlot();
                  let countdownLabel = "—";
                  let ready = false;
                  if (unlockSlot !== undefined && nowSlot !== null) {
                    if (nowSlot >= unlockSlot) {
                      ready = true;
                      countdownLabel = "✓ ready";
                    } else {
                      const slotsLeft = Number(unlockSlot - nowSlot);
                      const secondsLeft = (slotsLeft * SLOT_DURATION_MS) / 1000;
                      countdownLabel = fmtCountdown(secondsLeft);
                    }
                  }
                  const isMine = !!wallet.publicKey && t.staker.equals(wallet.publicKey);
                  return (
                    <tr key={i} className={isMine ? "" : "opacity-60"}>
                      <td><code>{short(t.ticketPda)}</code> {isMine ? <span className="badge badge-xs badge-primary ml-1">yours</span> : null}</td>
                      <td>{(Number(t.cssolWtAmount) / LAMPORTS_PER_SOL).toFixed(6)}</td>
                      <td className={ready ? "text-success" : "text-warning"}><code>{countdownLabel}</code></td>
                      <td>
                        <button className="btn btn-xs btn-primary" disabled={busy || !ready || !isMine}
                          title={
                            !isMine ? "Only the original ticket creator can mature it (Jito enforces ticket.staker == provided_staker)"
                              : !ready ? "Ticket still in Jito's epoch lock — wait for the countdown"
                              : undefined
                          }
                          onClick={() => void matureTicket(t.ticketPda)}>
                          Mature
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {epochLength ? (
              <p className="text-xs opacity-60 mt-2">
                Unlock = ticket's <code>slot_unstaked</code> + 2 × Jito epoch_length
                ({epochLength.toString()} slots ≈ {(Number(epochLength) * SLOT_DURATION_MS / 1000 / 86400).toFixed(2)}d).
                Devnet test vault uses a mainnet-style ~2-day epoch, so first ticket needs roughly 2-4 days before maturation.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {queue && queue.pendingWsol > 0n ? (
        <div className="card bg-base-200">
          <div className="card-body p-4 space-y-3">
            <div className="font-bold">Step 3: redeem csSOL-WT for wSOL</div>
            <p className="text-xs opacity-70">
              Burns your csSOL-WT and pays out wSOL from the pool's pending pool 1:1.
              Available: {(Number(queue.pendingWsol) / LAMPORTS_PER_SOL).toFixed(6)} wSOL.
            </p>
            <div className="flex items-center gap-2">
              <input type="number" step="0.001" min="0" className="input input-bordered w-48"
                value={redeemAmount} onChange={(e) => setRedeemAmount(e.target.value)} disabled={busy} />
              <span className="text-sm opacity-70">csSOL-WT</span>
              <button className="btn btn-primary" onClick={redeem} disabled={busy || !redeemAmount}>
                {busy ? <span className="loading loading-spinner loading-sm" /> : null}
                Redeem
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <pre className="alert alert-error text-xs whitespace-pre-wrap">{error}</pre> : null}
      {log.length > 0 ? <pre className="bg-base-300 p-2 text-xs whitespace-pre-wrap rounded">{log.join("\n")}</pre> : null}

      <details className="text-xs opacity-70">
        <summary className="cursor-pointer">v0 scope notes</summary>
        <p className="mt-2">
          This tab is the v0 unwind UX: simple "free csSOL → unstake" path. The full
          institutional unwind also supports collateral-swapping the user's klend csSOL collateral
          into csSOL-WT collateral via a klend flash-loan in one tx (so users with leveraged
          positions can unwind without sourcing external SOL liquidity to repay borrows). That
          path needs the csSOL-WT klend reserve to be deployed — see
          <code className="mx-1">scripts/setup-cssol-wt-reserve.ts</code> (stub). When that lands,
          this tab gains a "Unwind leveraged position" card that bundles flashBorrow → deposit
          collateral → withdraw csSOL collateral → enqueue → flashRepay in one signature.
        </p>
      </details>
    </section>
  );
}
