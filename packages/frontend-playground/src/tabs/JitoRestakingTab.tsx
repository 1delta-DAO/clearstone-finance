import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import {
  CSSOL_VAULT,
  CSSOL_VRT_MINT,
} from "../lib/addresses";
import {
  buildDepositTx,
  getVrtBalance,
  readVaultState,
  type VaultState,
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

  async function deposit() {
    if (!wallet.publicKey || !wallet.signTransaction) return;
    setBusy(true);
    setError(null);
    setLog([`building deposit tx for ${amount} SOL …`]);
    try {
      const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");
      const tx = await buildDepositTx(connection, wallet.publicKey, lamports);
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const signed = await wallet.signTransaction(tx);
      setLog((l) => [...l, "submitted, waiting for confirmation …"]);
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(sig, "confirmed");
      setLog((l) => [...l, `confirmed: ${sig}`]);
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
                <div>fee wallet: <code>{short(state.feeWallet)}</code></div>
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
            <div className="opacity-70 mt-2 text-xs">
              ⓘ The vault's <code>mintBurnAdmin</code> is the governor pool PDA.
              Only that authority can sign <code>MintTo</code>. To deposit from
              this UI, the connected wallet must currently hold that role
              (rotate via <code>SetSecondaryAdmin</code> for testing).
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
              disabled={busy || !state}
            >
              {busy ? <span className="loading loading-spinner loading-sm" /> : null}
              Deposit & receive VRT
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
