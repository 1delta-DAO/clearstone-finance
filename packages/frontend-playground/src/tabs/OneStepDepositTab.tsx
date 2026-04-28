import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import {
  CSSOL_MINT,
  CSSOL_RESERVE,
  CSSOL_RESERVE_ORACLE,
  CSSOL_VAULT,
  CSSOL_VAULT_ST_TOKEN_ACCOUNT,
  ELEVATION_GROUP_LST_SOL,
  JITO_VAULT_PROGRAM,
  KLEND_MARKET,
} from "../lib/addresses";
import {
  buildDepositCsSolIx,
  buildInitObligationIx,
  buildInitUserMetadataIx,
  buildRefreshObligationIx,
  buildRefreshReserveIx,
  buildRequestElevationGroupIx,
  obligationPda,
  userMetadataPda,
} from "../lib/klend";
import {
  buildWrapWithJitoVaultIx,
  isWhitelisted,
  readVaultState,
} from "../lib/jitoVault";

function short(p: string | PublicKey, n = 6): string {
  const s = typeof p === "string" ? p : p.toBase58();
  return `${s.slice(0, n)}…${s.slice(-4)}`;
}

interface KlendState {
  userMetaExists: boolean;
  obligationExists: boolean;
  obligationAddr: PublicKey;
  userMetaAddr: PublicKey;
  // Decoded only when obligationExists. Layout offsets derived from
  // klend-sdk@7.3.20's Obligation borsh schema (see node_modules/.../accounts/Obligation.ts).
  obligationHasDeposits: boolean;
  obligationElevationGroup: number;
}

const OBLIGATION_DEPOSIT0_RESERVE_OFFSET = 96;       // after disc(8)+tag(8)+lastUpdate(16)+market(32)+owner(32)
const OBLIGATION_ELEVATION_GROUP_OFFSET = 2285;       // after deposits[8](1088)+u64+u128+borrows[5](1000)+4*u128+13 padding

async function readKlendState(conn: ReturnType<typeof useConnection>["connection"], owner: PublicKey): Promise<KlendState> {
  const userMetaAddr = userMetadataPda(owner);
  const obligationAddr = obligationPda(owner);
  const [userMeta, obligation] = await conn.getMultipleAccountsInfo([userMetaAddr, obligationAddr], "confirmed");

  let obligationHasDeposits = false;
  let obligationElevationGroup = 0;
  if (obligation && obligation.data.length >= OBLIGATION_ELEVATION_GROUP_OFFSET + 1) {
    const firstReserveBytes = obligation.data.subarray(OBLIGATION_DEPOSIT0_RESERVE_OFFSET, OBLIGATION_DEPOSIT0_RESERVE_OFFSET + 32);
    obligationHasDeposits = firstReserveBytes.some((b) => b !== 0);
    obligationElevationGroup = obligation.data[OBLIGATION_ELEVATION_GROUP_OFFSET];
  }

  return {
    userMetaExists: !!userMeta,
    obligationExists: !!obligation,
    userMetaAddr,
    obligationAddr,
    obligationHasDeposits,
    obligationElevationGroup,
  };
}

export default function OneStepDepositTab() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [klend, setKlend] = useState<KlendState | null>(null);
  const [whitelisted, setWhitelisted] = useState<boolean | null>(null);
  const [solBal, setSolBal] = useState<bigint>(0n);
  const [cssolBal, setCssolBal] = useState<bigint>(0n);
  const [amount, setAmount] = useState<string>("0.005");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!wallet.publicKey) return;
    try {
      const [k, wl, lamports] = await Promise.all([
        readKlendState(connection, wallet.publicKey),
        isWhitelisted(connection, wallet.publicKey),
        connection.getBalance(wallet.publicKey).then(BigInt),
      ]);
      setKlend(k); setWhitelisted(wl); setSolBal(lamports);
      const cssolAta = getAssociatedTokenAddressSync(CSSOL_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      try {
        const bal = await connection.getTokenAccountBalance(cssolAta, "confirmed");
        setCssolBal(BigInt(bal.value.amount));
      } catch { setCssolBal(0n); }
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [wallet.publicKey, connection]);

  async function send(tx: Transaction, label: string) {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("wallet not connected");
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    setLog((l) => [...l, `signing ${label} …`]);
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    setLog((l) => [...l, `submitted ${label}: ${sig}`]);
    await connection.confirmTransaction(sig, "confirmed");
    const receipt = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (receipt?.meta?.err) {
      const logs = receipt.meta.logMessages?.slice(-8).join("\n") ?? "";
      throw new Error(`${label} on-chain err: ${JSON.stringify(receipt.meta.err)}\n${logs}`);
    }
    setLog((l) => [...l, `✓ confirmed ${label}`]);
    return sig;
  }

  async function setupKlend() {
    if (!wallet.publicKey) return;
    setBusy(true); setError(null); setLog(["building klend setup tx …"]);
    try {
      const owner = wallet.publicKey;
      const k = klend ?? (await readKlendState(connection, owner));
      const state = await readVaultState(connection, CSSOL_VAULT);

      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userVrt = getAssociatedTokenAddressSync(state.vrtMint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const userCssol = getAssociatedTokenAddressSync(CSSOL_MINT, owner, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const feeVrt = getAssociatedTokenAddressSync(state.vrtMint, state.feeWallet, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        // ATAs need to exist before the deposit tx — we move them out of
        // the wrap+deposit tx because that tx is already at the 1232-byte
        // ceiling. These idempotent creates are cheap if the ATAs exist.
        .add(createAssociatedTokenAccountIdempotentInstruction(
          owner, userWsol, owner, NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ))
        .add(createAssociatedTokenAccountIdempotentInstruction(
          owner, userVrt, owner, state.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ))
        .add(createAssociatedTokenAccountIdempotentInstruction(
          owner, userCssol, owner, CSSOL_MINT, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ))
        .add(createAssociatedTokenAccountIdempotentInstruction(
          owner, feeVrt, state.feeWallet, state.vrtMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        ));

      if (!k.userMetaExists) {
        tx.add(await buildInitUserMetadataIx(owner, owner));
      }
      if (!k.obligationExists) {
        tx.add(await buildInitObligationIx(owner, owner));
      }
      // Note: request_elevation_group is NOT in this setup tx. Klend
      // rejects it on an empty obligation (ObligationDepositsEmpty,
      // 6020) — the obligation must have at least one deposit before it
      // can join an elevation group. We append the elevation request to
      // the deposit tx instead, after the first deposit lands.

      await send(tx, "klend setup");
      await refresh();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  async function wrapAndDeposit() {
    if (!wallet.publicKey) return;
    setBusy(true); setError(null);
    setLog([`building 1-tx wrap+deposit for ${amount} SOL …`]);
    try {
      const owner = wallet.publicKey;
      const lamports = BigInt(Math.round(Number(amount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("amount must be > 0");

      const state = await readVaultState(connection, CSSOL_VAULT);
      const [jitoConfig] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("config")],
        JITO_VAULT_PROGRAM,
      );

      const userWsol = getAssociatedTokenAddressSync(NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      const wrapIx = await buildWrapWithJitoVaultIx({
        user: owner, amount: lamports,
        vrtMint: state.vrtMint, feeWallet: state.feeWallet,
        jitoVaultConfig: jitoConfig, vaultStTokenAccount: CSSOL_VAULT_ST_TOKEN_ACCOUNT,
      });

      const k = await readKlendState(connection, owner);

      // klend deposit ix expects refresh_obligation at [N-2] and
      // refresh_reserve at [N-1]. The pre-deposit refresh_obligation
      // remaining_accounts list must match the deposits already in the
      // obligation: empty for first deposit, [csSOL] thereafter.
      const preRefreshObIx = await buildRefreshObligationIx(
        owner,
        k.obligationHasDeposits ? [CSSOL_RESERVE] : [],
      );
      const refreshResIx = await buildRefreshReserveIx(CSSOL_RESERVE, CSSOL_RESERVE_ORACLE);
      const depositIx = await buildDepositCsSolIx(owner, lamports);

      // ATAs are pre-created by setupKlend(); skipping idempotent ATA
      // creates here keeps the tx under the 1232-byte limit (wrap +
      // deposit alone reference 24+ unique accounts).
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }))
        .add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: userWsol, lamports: Number(lamports) }))
        .add(createSyncNativeInstruction(userWsol))
        .add(wrapIx)
        .add(preRefreshObIx)
        .add(refreshResIx)
        .add(depositIx);

      await send(tx, "wrap+klend deposit");

      // First-time path: bundling refresh_obligation + request_elevation_group
      // into the deposit tx pushes it past Solana's 1232-byte limit (the wrap
      // ix alone has 19 accounts, deposit has 14). Send the elevation upgrade
      // as a separate follow-up tx — by now the deposit has confirmed and the
      // obligation has the csSOL deposit recorded, so klend accepts the join.
      if (k.obligationElevationGroup !== ELEVATION_GROUP_LST_SOL) {
        const elevTx = new Transaction()
          .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
          .add(await buildRefreshObligationIx(owner, [CSSOL_RESERVE]))
          .add(await buildRequestElevationGroupIx(owner, ELEVATION_GROUP_LST_SOL));
        await send(elevTx, "join elevation group 2");
      }

      await refresh();
    } catch (e: any) {
      const onchainLogs = e?.transactionLogs ?? e?.logs ?? null;
      setError(`${e.message ?? e}${onchainLogs ? "\n\n" + onchainLogs.slice(-8).join("\n") : ""}`);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.publicKey) {
    return (
      <section className="max-w-3xl">
        <h2 className="text-2xl font-bold mb-2">1-tx Deposit — SOL → csSOL → klend collateral</h2>
        <p className="opacity-70 mb-6">
          Atomic institutional deposit. One signature wraps native SOL into Jito-backed csSOL,
          then deposits the csSOL as klend collateral inside elevation group 2 (csSOL/wSOL eMode,
          90% LTV). Whitelist-only at the delta-mint layer.
        </p>
        <div className="alert alert-warning"><span>Connect a wallet to start.</span></div>
      </section>
    );
  }

  const setupNeeded = !!klend && (!klend.userMetaExists || !klend.obligationExists);
  const canDeposit = !setupNeeded && !!whitelisted;

  return (
    <section className="max-w-3xl space-y-6">
      <header>
        <h2 className="text-2xl font-bold">1-tx Deposit — SOL → csSOL → klend collateral</h2>
        <p className="opacity-70 mt-1 text-sm">
          One user signature: wraps native SOL into csSOL via the Jito vault and immediately
          deposits the resulting csSOL as klend collateral inside elevation group&nbsp;
          {ELEVATION_GROUP_LST_SOL} (90% LTV csSOL → wSOL borrow).
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Klend account</div>
            {klend ? (
              <>
                <div>obligation: <code>{short(klend.obligationAddr)}</code> {klend.obligationExists ? "✓" : "(needs init)"}</div>
                <div>userMetadata: <code>{short(klend.userMetaAddr)}</code> {klend.userMetaExists ? "✓" : "(needs init)"}</div>
                <div>elevation group: <code>{klend.obligationElevationGroup}</code> {klend.obligationElevationGroup === ELEVATION_GROUP_LST_SOL ? "✓ (csSOL/wSOL eMode)" : "(will join on first deposit)"}</div>
                <div>has csSOL deposit: <code>{klend.obligationHasDeposits ? "yes" : "no"}</code></div>
                <div>market: <code>{short(KLEND_MARKET)}</code></div>
                <div>csSOL reserve: <code>{short(CSSOL_RESERVE)}</code></div>
                <div>csSOL oracle: <code>{short(CSSOL_RESERVE_ORACLE)}</code></div>
              </>
            ) : <div className="opacity-60">loading …</div>}
          </div>
        </div>

        <div className="card bg-base-200">
          <div className="card-body p-4 text-sm space-y-1">
            <div className="font-bold">Wallet</div>
            <div>pubkey: <code>{short(wallet.publicKey)}</code></div>
            <div>SOL: <code>{(Number(solBal) / LAMPORTS_PER_SOL).toFixed(6)}</code></div>
            <div>csSOL (free): <code>{cssolBal.toString()}</code></div>
            <div className={`text-xs mt-2 ${whitelisted ? "text-success" : "text-warning"}`}>
              {whitelisted === null ? "checking whitelist…"
                : whitelisted ? "✓ KYC-whitelisted on delta-mint."
                : "⚠ NOT whitelisted. The wrap will fail at delta-mint::mint_to. Run governor.add_participant(Holder, your_pubkey) from an admin wallet."}
            </div>
          </div>
        </div>
      </div>

      {setupNeeded ? (
        <div className="card bg-base-200">
          <div className="card-body p-4 space-y-3">
            <div className="font-bold">First-time setup</div>
            <p className="text-sm opacity-70">
              Your klend obligation hasn't been created yet. One setup tx initializes
              <code className="mx-1">user_metadata</code>, <code className="mx-1">obligation</code> (default tag/id),
              and joins elevation group <code>{ELEVATION_GROUP_LST_SOL}</code>.
            </p>
            <div className="flex items-center gap-2">
              <button className="btn btn-primary" onClick={setupKlend} disabled={busy}>
                {busy ? <span className="loading loading-spinner loading-sm" /> : null}
                Initialize klend account
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={busy}>Refresh</button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="card bg-base-200">
        <div className="card-body p-4 space-y-3">
          <div className="font-bold">Wrap & deposit</div>
          <div className="flex items-center gap-2">
            <input type="number" step="0.001" min="0" className="input input-bordered w-48"
              value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
            <span className="text-sm opacity-70">SOL</span>
            <button className="btn btn-primary" onClick={wrapAndDeposit}
              disabled={busy || !canDeposit}
              title={
                setupNeeded ? "Initialize klend account first"
                  : !whitelisted ? "Wallet is not KYC-whitelisted"
                  : undefined
              }>
              {busy ? <span className="loading loading-spinner loading-sm" /> : null}
              Wrap & deposit as collateral
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void refresh()} disabled={busy}>Refresh</button>
          </div>
          {error ? <pre className="alert alert-error text-xs whitespace-pre-wrap">{error}</pre> : null}
          {log.length > 0 ? <pre className="bg-base-300 p-2 text-xs whitespace-pre-wrap rounded">{log.join("\n")}</pre> : null}
        </div>
      </div>

      <details className="text-xs opacity-70">
        <summary className="cursor-pointer">What this tx actually does</summary>
        <ol className="list-decimal pl-5 mt-2 space-y-1">
          <li>Idempotently creates user's wSOL, VRT, csSOL, and fee-VRT ATAs.</li>
          <li>Transfers <code>amount</code> lamports of SOL into user's wSOL ATA + <code>sync_native</code>.</li>
          <li><code>governor::wrap_with_jito_vault(amount)</code> — Jito MintTo via PDA-signed CPI,
            VRT swept to pool, csSOL minted to user (KYC-checked).</li>
          <li>klend <code>refresh_obligation</code> (slot N-2 of the deposit ix).</li>
          <li>klend <code>refresh_reserve(csSOL_RESERVE)</code> reading the accrual-oracle output.</li>
          <li>klend <code>deposit_reserve_liquidity_and_obligation_collateral(amount)</code> —
            csSOL leaves user's ATA into the reserve, cTokens recorded as obligation collateral
            inside elevation group <code>{ELEVATION_GROUP_LST_SOL}</code>.</li>
        </ol>
      </details>
    </section>
  );
}
