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

function loadKeypair(raw: string): Keypair {
  // Accept either the JSON array form Solana CLI writes (`[12,34,...,255]`)
  // or a base58-encoded 64-byte secret string. Saves us re-uploading the
  // secret if the operator paste-formats it the wrong way.
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    if (arr.length !== 64) throw new Error(`DEPLOY_KEYPAIR_JSON JSON array must be 64 bytes, got ${arr.length}`);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  // Base58 fallback. @solana/web3.js bundles bs58 transitively via tweetnacl;
  // we use Keypair.fromSecretKey on a manually-decoded buffer.
  const decoded = base58Decode(trimmed);
  if (decoded.length !== 64) throw new Error(`DEPLOY_KEYPAIR_JSON base58 must decode to 64 bytes, got ${decoded.length}`);
  return Keypair.fromSecretKey(decoded);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(s: string): Uint8Array {
  const map = new Map<string, number>();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) map.set(BASE58_ALPHABET[i], i);
  let bytes: number[] = [0];
  for (const c of s) {
    const v = map.get(c);
    if (v === undefined) throw new Error(`invalid base58 char: ${c}`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      const x = bytes[j] * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading zero bytes for each leading '1'.
  for (const c of s) { if (c !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
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

async function runOnce(env: Env): Promise<{ sig: string; signer: string; balanceSol: number; sourcePrice: number }> {
  const conn = new Connection(env.SOLANA_RPC_URL, "confirmed");
  const payer = loadKeypair(env.DEPLOY_KEYPAIR_JSON);
  const signer = payer.publicKey.toBase58();

  // Surface the signer's balance so a "no SOL" deploy is obvious from the
  // very first response instead of looking like a confirmation timeout.
  const balanceLamports = await conn.getBalance(payer.publicKey, "confirmed");
  const balanceSol = balanceLamports / 1e9;
  if (balanceLamports < 50_000) {
    throw new Error(`signer ${signer} has only ${balanceSol} SOL — airdrop with: solana airdrop 1 ${signer} --url devnet`);
  }

  const refresh = buildRefreshIx(
    new PublicKey(env.ACCRUAL_ORACLE_PROGRAM),
    new PublicKey(env.ACCRUAL_CONFIG),
    new PublicKey(env.PYTH_PRICE_FEED),
    new PublicKey(env.ACCRUAL_OUTPUT),
  );

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
    // 200_000 µL × 60k CU ≈ 12 priority lamports — tiny next to base fees,
    // but enough to clear devnet's leader queue most of the time.
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }))
    .add(refresh);
  tx.sign(payer);

  // Fire-and-forget: the refresh is idempotent and the cron fires every
  // 5 min, so if a tx silently expires the next fire just re-runs. We
  // skip `sendAndConfirmTransaction` because its 60s confirmation window
  // races devnet's blockhash expiry — and an unconfirmed-but-submitted
  // sig still typically lands seconds later.
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
    preflightCommitment: "confirmed",
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

  return { sig, signer, balanceSol, sourcePrice };
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runOnce(env)
        .then(({ sig, signer, balanceSol, sourcePrice }) => {
          const priceLog = Number.isFinite(sourcePrice) ? `SOL=$${sourcePrice.toFixed(4)} ` : "";
          console.log(`refresh submitted  ${priceLog}signer=${signer} balance=${balanceSol.toFixed(4)} sig=${sig}`);
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
