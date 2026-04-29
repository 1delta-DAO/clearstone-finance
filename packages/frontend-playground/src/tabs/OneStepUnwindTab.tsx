import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
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
  CSSOL_VAULT,
  CSSOL_VRT_MINT,
  CSSOL_WT_MINT,
  JITO_VAULT_PROGRAM,
  POOL_PENDING_WSOL_ACCOUNT,
  POOL_PDA,
} from "../lib/addresses";
import {
  buildEnqueueWithdrawViaPoolIx,
  buildMatureWithdrawalTicketsIx,
  buildRedeemCsSolWtIx,
  decodeJitoConfigEpochLength,
  decodeTicketSlotUnstaked,
  decodeWithdrawQueue,
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

      // Ticket PDA seeds (verified by string-grep on the Jito vault
      // binary): [b"vault_staker_withdrawal_ticket", vault, base].
      // Base is an ephemeral keypair generated per-call so each enqueue
      // produces a unique ticket address (lets a user have multiple
      // in-flight tickets simultaneously).
      const baseKp = Keypair.generate();
      const [vaultStakerWithdrawalTicket] = PublicKey.findProgramAddressSync(
        [
          new TextEncoder().encode("vault_staker_withdrawal_ticket"),
          CSSOL_VAULT.toBuffer(),
          baseKp.publicKey.toBuffer(),
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
          base: baseKp.publicKey,
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
      // Pass the ephemeral base keypair as an extra signer; user signs
      // via the wallet (covers fee_payer + staker slots).
      await send(tx, "enqueue unwind", [baseKp]);
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
