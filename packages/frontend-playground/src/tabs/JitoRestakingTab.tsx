import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import {
  CSSOL_VAULT,
  CSSOL_VRT_MINT,
} from "../lib/addresses";
import {
  buildDepositTx,
  classifyWallet,
  getVrtBalance,
  readVaultState,
  type VaultState,
  type WalletRole,
} from "../lib/jitoVault";

function short(p: string | PublicKey, n = 6): string {
  const s = typeof p === "string" ? p : p.toBase58();
  return `${s.slice(0, n)}…${s.slice(-4)}`;
}

function fmtSol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
}

export default function JitoRestakingTab() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [state, setState] = useState<VaultState | null>(null);
  const [vrt, setVrt] = useState<bigint>(0n);
  const [solBal, setSolBal] = useState<bigint>(0n);
  const [amount, setAmount] = useState<string>("0.005");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await readVaultState(connection, CSSOL_VAULT);
      setState(s);
      if (wallet.publicKey) {
        const [v, sol] = await Promise.all([
          getVrtBalance(connection, wallet.publicKey, s.vrtMint),
          connection.getBalance(wallet.publicKey).then(BigInt),
        ]);
        setVrt(v);
        setSolBal(sol);
      }
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [wallet.publicKey, connection]);

  const ratio = state && state.vrtSupply > 0n
    ? Number(state.tokensDeposited) / Number(state.vrtSupply)
    : 1;
  const role: WalletRole = state ? classifyWallet(state, wallet.publicKey) : "none";
  const canDeposit = role === "admin" || role === "mintBurnAdmin";

  async function deposit() {
    if (!wallet.publicKey || !wallet.signTransaction) return;
    setBusy(true);
    setError(null);
    setLog([`building deposit tx for ${amount} SOL …`]);
    try {
      const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");
      const built = await buildDepositTx(connection, wallet.publicKey, lamports);
      const tx = built.tx;
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      setLog((l) => [
        ...l,
        built.mode === "admin"
          ? "mode: admin → atomic rotate-mint-restore (3-ix gate cycle)"
          : "mode: mintBurnAdmin → straight MintTo",
      ]);
      const signed = await wallet.signTransaction(tx);
      setLog((l) => [...l, "submitted, waiting for confirmation …"]);
      // Skip preflight — Phantom already simulated, and its sim can spuriously
      // fail on multi-ix gate cycles (stale state across ixs). We trust the
      // committed result fetched below instead.
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      await connection.confirmTransaction(sig, "confirmed");
      setLog((l) => [...l, `signature: ${sig}`]);

      // Verify against on-chain state regardless of what the wallet's
      // toast says. Phantom often shows a red ✕ on these tx because its
      // preflight assumes the gate is closed when MintTo runs, even though
      // the rotate ix opens it first within the same tx.
      const receipt = await connection.getTransaction(sig, {
        commitment: "confirmed", maxSupportedTransactionVersion: 0,
      });
      if (receipt?.meta?.err) {
        throw new Error("on-chain err: " + JSON.stringify(receipt.meta.err));
      }
      setLog((l) => [
        ...l,
        receipt
          ? `✓ on-chain confirmed: err=${receipt.meta?.err ?? "null"}, fee=${receipt.meta?.fee ?? "?"} lamports`
          : "(receipt not yet visible; refresh balances below)",
      ]);
      await refresh();
    } catch (e: any) {
      const logs = e?.transactionLogs ?? e?.logs ?? null;
      setError(`${e.message ?? e}${logs ? "\n\n" + logs.slice(-6).join("\n") : ""}`);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.publicKey) {
    return (
      <section className="max-w-3xl">
        <h2 className="text-2xl font-bold mb-2">Jito Restaking — SOL → VRT</h2>
        <p className="opacity-70 mb-6">
          Deposits native SOL into our gated Jito Vault and returns Vault Receipt
          Tokens (VRT) 1:1 (plus accrued reward distributions if any).
        </p>
        <div className="alert alert-warning">
          <span>Connect a wallet to start.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="max-w-3xl space-y-6">
      <header>
        <h2 className="text-2xl font-bold">Jito Restaking — SOL → VRT</h2>
        <p className="opacity-70 mt-1 text-sm">
          One-shot deposit into our gated Jito Vault. wSOL → VRT, 1:1 at the start;
          ratio drifts as NCN reward distributions land.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Vault state</div>
            <div>address: <code>{short(CSSOL_VAULT)}</code></div>
            {state ? (
              <>
                <div>VRT mint: <code>{short(state.vrtMint)}</code></div>
                <div>supportedMint: <code>{short(state.supportedMint)}</code></div>
                <div>tokensDeposited: <code>{state.tokensDeposited.toString()}</code></div>
                <div>vrtSupply: <code>{state.vrtSupply.toString()}</code></div>
                <div>exchange rate: <code>{ratio.toFixed(8)}</code> SOL / VRT</div>
                <div>admin: <code>{short(state.admin)}</code></div>
                <div>fee wallet: <code>{short(state.feeWallet)}</code></div>
                <div>mintBurnAdmin: <code>{short(state.mintBurnAdmin)}</code></div>
              </>
            ) : (
              <div className="opacity-60">loading …</div>
            )}
          </div>
        </div>

        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Connected wallet</div>
            <div>pubkey: <code>{short(wallet.publicKey)}</code></div>
            <div>SOL balance: <code>{fmtSol(solBal)}</code></div>
            <div>VRT balance: <code>{vrt.toString()}</code> ({fmtSol(vrt)} VRT)</div>
            <div className={`text-xs mt-2 ${role === "none" ? "text-warning" : "text-success"}`}>
              {!state ? "loading vault state…"
                : role === "mintBurnAdmin"
                  ? "✓ Wallet holds mintBurnAdmin → straight MintTo (gate already open for you)."
                  : role === "admin"
                    ? "✓ Wallet is vault admin → atomic rotate-mint-restore (3-ix tx; gate is restored on commit)."
                    : "⚠ Wallet has no role on this vault. To deposit, connect with the admin or mintBurnAdmin keypair."}
            </div>
          </div>
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-3">
          <div className="font-bold">Deposit</div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.001"
              min="0"
              className="input input-bordered w-48"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
            />
            <span className="text-sm opacity-70">SOL</span>
            <button
              className="btn btn-primary"
              onClick={deposit}
              disabled={busy || !state || !canDeposit}
              title={!canDeposit ? "Wallet has neither admin nor mintBurnAdmin role on this vault" : undefined}
            >
              {busy ? <span className="loading loading-spinner loading-sm" /> : null}
              {role === "admin" ? "Deposit (admin: rotate → mint → restore)" : "Deposit & receive VRT"}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={busy}>
              Refresh
            </button>
          </div>
          {error ? (
            <pre className="alert alert-error text-xs whitespace-pre-wrap">{error}</pre>
          ) : null}
          {log.length > 0 ? (
            <pre className="bg-base-300 p-2 text-xs whitespace-pre-wrap rounded">
              {log.join("\n")}
            </pre>
          ) : null}
        </div>
      </div>

      <details className="text-xs opacity-70">
        <summary className="cursor-pointer">⚠ Phantom may show "Failed" — ignore it; check the on-chain receipt</summary>
        <p className="mt-2">
          Phantom's pre-broadcast simulation runs each ix against the pre-tx
          snapshot. For our admin path the tx is:
        </p>
        <pre className="bg-base-300 p-2 rounded mt-2 whitespace-pre-wrap">{`SetSecondaryAdmin(MintBurnAdmin = user)   ← opens gate
MintTo(amount)                            ← needs gate open
SetSecondaryAdmin(MintBurnAdmin = governor PDA)  ← restores gate`}</pre>
        <p className="mt-2">
          Phantom simulates <code>MintTo</code> assuming the gate is still
          closed (hasn't applied the prior ix's state mutation), so its
          confirmation toast often says ✕. The actual on-chain transaction
          processes the ixs in order and succeeds — verify in the
          confirmation log above (we fetch the receipt directly with
          <code> getTransaction</code>) or via the explorer link below.
        </p>
      </details>
      <details className="text-xs opacity-70">
        <summary className="cursor-pointer">What this tx actually does</summary>
        <ol className="list-decimal pl-5 mt-2 space-y-1">
          <li>Idempotently creates the user's wSOL, VRT, and fee-VRT ATAs.</li>
          <li>Transfers <code>amount</code> lamports of native SOL into the user's wSOL ATA, then <code>sync_native</code>.</li>
          <li>Calls Jito Vault <code>MintTo</code> — pulls wSOL from user → vault token account, mints VRT to user.</li>
          <li>VRT amount = <code>amount × vault.vrtSupply / vault.tokensDeposited</code>.</li>
        </ol>
        <p className="mt-2">
          On mainnet the <code>supportedMint</code> would be JitoSOL instead of wSOL, and the
          deposit chains through governor's KYC gate before reaching this ix.
        </p>
      </details>
    </section>
  );
}
