import { useState, useCallback } from "react";
import {
  useWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { fixedYield } from "@delta/calldata-sdk-solana";
import BN from "bn.js";
import {
  PublicKey,
  AddressLookupTableAccount,
  TransactionInstruction,
} from "@solana/web3.js";
import { useFixedYieldMarkets } from "../hooks/useFixedYieldMarkets";
import type { FixedYieldMarket } from "../hooks/useFixedYieldMarkets";
import { usePtPositions } from "../hooks/usePtPositions";
import type { PtPosition } from "../hooks/usePtPositions";
import {
  useCuratorVaults,
  useCuratorVaultPositions,
} from "../hooks/useCuratorVaults";
import type { CuratorVault } from "../hooks/useCuratorVaults";
import { MarketCard } from "../components/MarketCard";
import { DepositPtModal } from "../components/DepositPtModal";
import { PtPositionCard } from "../components/PtPositionCard";
import { SavingsAccountCard } from "../components/SavingsAccountCard";
import {
  SavingsDepositModal,
  type SavingsDepositSubmission,
} from "../components/SavingsDepositModal";
import { CuratorPositionCard } from "../components/CuratorPositionCard";

/**
 * Retail-facing fixed-yield savings page.
 *
 * Two sections:
 *   - Markets grid — open PT markets, deposit modal opens the zap-in flow.
 *   - Positions grid — user's PT holdings with a one-click Redeem button.
 *
 * Wire-up status:
 *   - Market list: backend-edge /fixed-yield/markets if `VITE_EDGE_URL`
 *     is set; fixture otherwise.
 *   - Positions: fixture for now. `usePtPositions` swaps to a backend
 *     query per (vault, user) when ready.
 *   - Deposit / Redeem tx: build via SDK, sign via wallet adapter, send
 *     via connection. Requires markets with real on-chain PDAs (so
 *     fixture-mode markets will fail at simulation).
 */
export function TermDepositsApp() {
  const { connected, publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const { markets, loading, error: marketsError } = useFixedYieldMarkets();
  const { positions, refresh: refreshPositions } = usePtPositions(markets);
  const { vaults: curatorVaults } = useCuratorVaults();
  const { positions: curatorPositions } = useCuratorVaultPositions(
    curatorVaults,
    publicKey ?? null
  );

  const [selected, setSelected] = useState<FixedYieldMarket | null>(null);
  const [selectedVault, setSelectedVault] = useState<CuratorVault | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const reset = () => {
    setStatusMsg(null);
    setErrorMsg(null);
  };

  // -------------------------------------------------------------------------
  // Deposit flow: build, sign, send.
  // -------------------------------------------------------------------------

  const handleDeposit = useCallback(
    async (args: { market: FixedYieldMarket; amountBase: BN }) => {
      if (!publicKey || !signTransaction) return;
      reset();
      setSubmitting(true);

      try {
        const m = args.market;
        if (!m.accounts) {
          throw new Error(
            "Market metadata incomplete — backend /fixed-yield/markets didn't include the adapter account block. Deposit unavailable until the indexer returns real on-chain state."
          );
        }

        const a = m.accounts;
        const ata = (mint: PublicKey) =>
          getAssociatedTokenAddressSync(
            mint,
            publicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );

        const baseSrc = ata(m.baseMint);
        const sySrc = ata(a.syMint);
        const ptDst = ata(a.mintPt);
        const ytDst = ata(a.mintYt);

        // Ensure SY/PT/YT ATAs exist. Strip creates tokens into these;
        // the idempotent variant is a no-op if they're already there.
        const preIxs: TransactionInstruction[] = [
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, sySrc, publicKey, a.syMint,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, ptDst, publicKey, a.mintPt,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, ytDst, publicKey, a.mintYt,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
        ];

        // Resolve ALTs. Frontend tolerates either being missing —
        // compileToV0Message falls back to inlining the accounts.
        const alts: AddressLookupTableAccount[] = [];
        for (const altKey of [a.vaultAlt, a.marketAlt]) {
          const res = await connection.getAddressLookupTable(altKey);
          if (res.value) alts.push(res.value);
        }

        const { blockhash } = await connection.getLatestBlockhash();

        // Build the zap ixs at the lower level so we can prepend
        // ATA-idempotent creation, then pack via packV0Tx.
        const zapIxs = fixedYield.zap.buildZapInToPt({
          user: publicKey,
          syMarket: a.syMarket,
          baseMint: m.baseMint,
          syMint: a.syMint,
          baseVault: a.baseVault,
          authority: a.vaultAuthority,
          vault: m.vault,
          yieldPosition: a.yieldPosition,
          addressLookupTable: a.vaultAlt,
          coreEventAuthority: a.coreEventAuthority,
          baseSrc,
          sySrc,
          escrowSy: a.escrowSy,
          ytDst,
          ptDst,
          mintPt: a.mintPt,
          mintYt: a.mintYt,
          amountBase: args.amountBase,
          sellYt: {
            ytIn: args.amountBase,
            minSyOut: new BN(0),
            market: m.market,
            marketEscrowSy: a.marketEscrowSy,
            marketEscrowPt: a.marketEscrowPt,
            marketAlt: a.marketAlt,
            tokenFeeTreasurySy: a.tokenFeeTreasurySy,
          },
          syProgram: a.syProgram,
        });

        const tx = fixedYield.tx.packV0Tx({
          ixs: [...preIxs, ...zapIxs],
          payer: publicKey,
          recentBlockhash: blockhash,
          lookupTables: alts,
          computeBudget: { unitLimit: 400_000 },
        });

        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        setStatusMsg(`Deposit confirmed: ${sig.slice(0, 12)}…`);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Deposit failed"
        );
      } finally {
        setSubmitting(false);
        setSelected(null);
        refreshPositions();
      }
    },
    [publicKey, signTransaction, connection, refreshPositions]
  );

  // -------------------------------------------------------------------------
  // Redeem flow: build buildZapOutToBaseV0Tx, sign, send.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Savings-account (curator-vault) deposit. One-tx flow:
  //   idempotent ATA → curator.deposit(amount_base)
  // -------------------------------------------------------------------------

  const handleSavingsDeposit = useCallback(
    async (args: SavingsDepositSubmission) => {
      const { vault, amountBase, enableAutoRoll, maxSlippageBps, ttlSlots } =
        args;
      if (!publicKey || !signTransaction) return;
      reset();
      setSubmitting(true);

      try {
        const baseSrc = getAssociatedTokenAddressSync(
          vault.baseMint,
          publicKey,
          false,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );

        const position = fixedYield.curator.curatorUserPositionPda(
          vault.vault,
          publicKey
        );

        const preIxs: TransactionInstruction[] = [
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            baseSrc,
            publicKey,
            vault.baseMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          ),
        ];

        const depositIx = fixedYield.curator.buildCuratorDeposit({
          owner: publicKey,
          vault: vault.vault,
          baseMint: vault.baseMint,
          baseEscrow: vault.baseEscrow,
          baseSrc,
          position,
          amountBase,
        });

        const ixs: TransactionInstruction[] = [...preIxs, depositIx];

        // If the user enabled auto-roll, bundle a create_delegation ix.
        // Single signature covers both — deposit and delegation happen
        // atomically; if either fails, nothing persists.
        if (enableAutoRoll) {
          ixs.push(
            fixedYield.delegation.buildCreateDelegation({
              user: publicKey,
              vault: vault.vault,
              maxSlippageBps,
              ttlSlots,
            })
          );
        }

        const { blockhash } = await connection.getLatestBlockhash();
        const tx = fixedYield.tx.packV0Tx({
          ixs,
          payer: publicKey,
          recentBlockhash: blockhash,
          lookupTables: [],
          computeBudget: { unitLimit: 240_000 },
        });

        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        setStatusMsg(
          enableAutoRoll
            ? `Deposit + auto-roll enabled: ${sig.slice(0, 12)}…`
            : `Deposit confirmed: ${sig.slice(0, 12)}…`
        );
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Savings deposit failed"
        );
      } finally {
        setSubmitting(false);
        setSelectedVault(null);
      }
    },
    [publicKey, signTransaction, connection]
  );

  // Revoke an active delegation. Single-ix tx; UX parity with deposit.
  const handleRevokeDelegation = useCallback(
    async (vault: CuratorVault) => {
      if (!publicKey || !signTransaction) return;
      reset();
      try {
        const ix = fixedYield.delegation.buildCloseDelegation({
          user: publicKey,
          vault: vault.vault,
        });
        const { blockhash } = await connection.getLatestBlockhash();
        const tx = fixedYield.tx.packV0Tx({
          ixs: [ix],
          payer: publicKey,
          recentBlockhash: blockhash,
          lookupTables: [],
          computeBudget: { unitLimit: 50_000 },
        });
        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        setStatusMsg(`Auto-roll revoked: ${sig.slice(0, 12)}…`);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Revoke failed"
        );
      }
    },
    [publicKey, signTransaction, connection]
  );

  const handleRedeem = useCallback(
    async (position: PtPosition, amountPy: BN) => {
      if (!publicKey || !signTransaction) return;
      reset();
      setRedeemingId(position.market.id);

      try {
        const m = position.market;
        if (!m.accounts) {
          throw new Error(
            "Market metadata incomplete — backend /fixed-yield/markets didn't include the adapter account block."
          );
        }

        const a = m.accounts;
        const ata = (mint: PublicKey) =>
          getAssociatedTokenAddressSync(
            mint,
            publicKey,
            false,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );

        const baseDst = ata(m.baseMint);
        const sySrc = ata(a.syMint);
        const ptSrc = ata(a.mintPt);
        const ytSrc = ata(a.mintYt);

        // Base ATA must exist to receive redeem proceeds. SY/PT/YT ATAs
        // already exist (user must have PT/YT to redeem), but we
        // idempotent-create for safety.
        const preIxs: TransactionInstruction[] = [
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey, baseDst, publicKey, m.baseMint,
            TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
          ),
        ];

        const alts: AddressLookupTableAccount[] = [];
        const vaultAltRes = await connection.getAddressLookupTable(a.vaultAlt);
        if (vaultAltRes.value) alts.push(vaultAltRes.value);

        const { blockhash } = await connection.getLatestBlockhash();

        const mergeIx = fixedYield.zap.buildZapOutToBase({
          user: publicKey,
          syMarket: a.syMarket,
          baseMint: m.baseMint,
          syMint: a.syMint,
          baseVault: a.baseVault,
          authority: a.vaultAuthority,
          vault: m.vault,
          yieldPosition: a.yieldPosition,
          addressLookupTable: a.vaultAlt,
          coreEventAuthority: a.coreEventAuthority,
          sySrc,
          baseDst,
          escrowSy: a.escrowSy,
          ytSrc,
          ptSrc,
          mintPt: a.mintPt,
          mintYt: a.mintYt,
          amountPy,
          syProgram: a.syProgram,
        });

        const tx = fixedYield.tx.packV0Tx({
          ixs: [...preIxs, mergeIx],
          payer: publicKey,
          recentBlockhash: blockhash,
          lookupTables: alts,
          computeBudget: { unitLimit: 300_000 },
        });

        const signed = await signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize());
        await connection.confirmTransaction(sig, "confirmed");
        setStatusMsg(`Redeem confirmed: ${sig.slice(0, 12)}…`);
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Redeem failed"
        );
      } finally {
        setRedeemingId(null);
        refreshPositions();
      }
    },
    [publicKey, signTransaction, connection, refreshPositions]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-base-100">
      <header className="navbar bg-base-200 border-b border-base-300">
        <div className="flex-1 px-4">
          <span className="text-xl font-semibold">Clearstone · Savings</span>
        </div>
        <div className="flex-none px-4">
          <WalletMultiButton />
        </div>
      </header>

      <main className="mx-auto max-w-5xl p-6">
        <section>
          <div className="mb-6">
            <h1 className="text-2xl font-semibold">
              Fixed-Rate Term Deposits
            </h1>
            <p className="mt-1 text-sm opacity-70">
              Deposit now, earn a locked-in rate through maturity. Redeem
              any time at the prevailing PT price on the AMM.
            </p>
          </div>

          {!connected && (
            <div className="alert alert-info mb-6">
              <span>Connect a wallet to deposit.</span>
            </div>
          )}

          {marketsError && (
            <div className="alert alert-warning mb-6">
              <span>
                Live market data unavailable ({marketsError.message}) —
                showing fixture data.
              </span>
            </div>
          )}

          {statusMsg && (
            <div className="alert alert-info mb-6">
              <span>{statusMsg}</span>
            </div>
          )}
          {errorMsg && (
            <div className="alert alert-error mb-6">
              <span>{errorMsg}</span>
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 opacity-70">
              <span className="loading loading-spinner loading-sm" />
              <span>Loading markets…</span>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {markets.map((m) => (
                <MarketCard
                  key={m.id}
                  market={m}
                  onDeposit={(mk) => setSelected(mk)}
                />
              ))}
            </div>
          )}
        </section>

        {curatorVaults.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xl font-semibold mb-1">Auto-roll savings</h2>
            <p className="text-sm opacity-70 mb-4">
              Deposit once and let the curator reroll your position across
              maturities. Withdraw any time up to vault idle liquidity.
            </p>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {curatorVaults.map((v) => (
                <SavingsAccountCard
                  key={v.id}
                  vault={v}
                  onDeposit={(vk) => setSelectedVault(vk)}
                />
              ))}
            </div>
          </section>
        )}

        {connected &&
          (positions.length > 0 || curatorPositions.length > 0) && (
            <section className="mt-10">
              <h2 className="text-xl font-semibold mb-4">Your positions</h2>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {positions.map((p) => (
                  <PtPositionCard
                    key={p.market.id}
                    position={p}
                    redeeming={redeemingId === p.market.id}
                    onRedeem={handleRedeem}
                  />
                ))}
                {curatorPositions.map((p) => (
                  <CuratorPositionCard
                    key={`sav-${p.vault.id}`}
                    position={p}
                    user={publicKey!}
                    connection={connection}
                    onRevoke={() => handleRevokeDelegation(p.vault)}
                  />
                ))}
              </div>
            </section>
          )}

        <DepositPtModal
          market={selected}
          onClose={() => (submitting ? null : setSelected(null))}
          onSubmit={handleDeposit}
          submitting={submitting}
        />

        <SavingsDepositModal
          vault={selectedVault}
          onClose={() => (submitting ? null : setSelectedVault(null))}
          onSubmit={handleSavingsDeposit}
          submitting={submitting}
        />
      </main>
    </div>
  );
}
