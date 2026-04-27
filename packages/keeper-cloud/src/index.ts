/**
 * Cloudflare Worker — csSOL accrual-oracle refresher.
 *
 * Cron-triggered. Each fire is a single `accrual_oracle::refresh` call. The
 * accrual oracle reads SOL/USD from the Pyth-sponsored devnet push feed
 *
 *   7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE   (owner: Pyth Receiver)
 *
 * which is updated by Pyth's permissionless updater every ~30 seconds, and
 * writes `source_price * index_e9 / 1e9` into our stable accrual output. The
 * wSOL reserve reads `7UVi…` directly; only the csSOL reserve needs our
 * accrual output to stay fresh.
 *
 * Why so small: there's no VAA fetch, no Wormhole verification, no
 * post+close churn. Pyth's network does that work for free.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

interface Env {
  DEPLOY_KEYPAIR_JSON: string;
  SOLANA_RPC_URL: string;
  ACCRUAL_OUTPUT: string;
  ACCRUAL_CONFIG: string;
  ACCRUAL_ORACLE_PROGRAM: string;
  PYTH_PRICE_FEED: string; // 7UVi… on devnet
}

// First 8 bytes of sha256("global:refresh"), pre-computed.
const DISC_REFRESH = Uint8Array.from([0xaa, 0x9b, 0x16, 0xfe, 0x93, 0xb5, 0x31, 0xa1]);

function loadKeypair(json: string): Keypair {
  const arr = JSON.parse(json) as number[];
  if (arr.length !== 64) throw new Error(`DEPLOY_KEYPAIR_JSON must be 64 bytes, got ${arr.length}`);
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

function buildRefreshIx(
  programId: PublicKey,
  feedConfig: PublicKey,
  source: PublicKey,
  output: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: feedConfig, isSigner: false, isWritable: false },
      { pubkey: source, isSigner: false, isWritable: false },
      { pubkey: output, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(DISC_REFRESH),
  });
}

async function runOnce(env: Env): Promise<{ sig: string; sourcePrice: number }> {
  const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
  const payer = loadKeypair(env.DEPLOY_KEYPAIR_JSON);

  const refresh = buildRefreshIx(
    new PublicKey(env.ACCRUAL_ORACLE_PROGRAM),
    new PublicKey(env.ACCRUAL_CONFIG),
    new PublicKey(env.PYTH_PRICE_FEED),
    new PublicKey(env.ACCRUAL_OUTPUT),
  );

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 25_000 }))
    .add(refresh);

  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
    skipPreflight: false,
    maxRetries: 3,
  });

  // Read source price for log decoration only — failures here do not fail the fire.
  let sourcePrice = NaN;
  try {
    const acct = await conn.getAccountInfo(new PublicKey(env.PYTH_PRICE_FEED), "confirmed");
    if (acct?.data && acct.data.length >= 93) {
      const price = acct.data.readBigInt64LE(73);
      const expo = acct.data.readInt32LE(89);
      sourcePrice = Number(price) * Math.pow(10, expo);
    }
  } catch {
    /* swallow */
  }

  return { sig, sourcePrice };
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runOnce(env)
        .then(({ sig, sourcePrice }) => {
          const priceLog = Number.isFinite(sourcePrice) ? `SOL=$${sourcePrice.toFixed(4)} ` : "";
          console.log(`refresh ok  ${priceLog}sig=${sig}`);
        })
        .catch((e: Error) => {
          console.error(`keeper failed: ${e.message}`);
        }),
    );
  },

  async fetch(_req: Request, env: Env): Promise<Response> {
    try {
      const out = await runOnce(env);
      return new Response(JSON.stringify({ ok: true, ...out }), {
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
