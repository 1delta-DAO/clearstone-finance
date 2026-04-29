/**
 * extend-lut-cssol-wt.ts — Extends the existing deposit LUT with the
 * csSOL-WT addresses needed for the leveraged-unwind flash-loan path
 * (flashBorrow → deposit_collateral → withdraw_collateral → enqueue →
 * flashRepay) so that single-tx fits under Solana's 1232-byte limit.
 *
 * Idempotent: skips entries that are already in the LUT.
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx scripts/extend-lut-cssol-wt.ts
 */
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOLANA_RPC_URL || "https://devnet.helius-rpc.com/?api-key=b4b7a200-6ff5-41ec-80ef-d7e7163d06ec";

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const payer = loadKp(process.env.DEPLOY_KEYPAIR || path.join(process.env.HOME!, ".config/solana/id.json"));

  const cfgs = path.join(__dirname, "..", "configs", "devnet");
  const poolCfg = JSON.parse(fs.readFileSync(path.join(cfgs, "cssol-pool.json"), "utf8"));
  const wtCfg = JSON.parse(fs.readFileSync(path.join(cfgs, "cssol-wt.json"), "utf8"));
  const wtDeploy = JSON.parse(fs.readFileSync(path.join(cfgs, "cssol-wt-deployed.json"), "utf8"));

  const lut = new PublicKey(poolCfg.depositLut);

  // New addresses to register. Static-only — per-user addresses (ATAs,
  // obligation, userMetadata) stay out of the LUT since they vary by caller.
  const newAddresses: PublicKey[] = [
    new PublicKey(wtDeploy.cssolWtReserve),
    new PublicKey(wtDeploy.cssolWtCollMint),
    new PublicKey(wtDeploy.cssolWtCollSupply),
    new PublicKey(wtDeploy.cssolWtLiqSupply),
    new PublicKey(wtCfg.mint),
    new PublicKey(wtCfg.dmMintConfig),
    new PublicKey(wtCfg.dmMintAuthority),
    new PublicKey(poolCfg.poolPendingWsolAccount),
  ];

  const lutAccount = await conn.getAddressLookupTable(lut, { commitment: "confirmed" });
  if (!lutAccount.value) throw new Error(`LUT not found: ${lut.toBase58()}`);

  const existing = new Set(lutAccount.value.state.addresses.map((a) => a.toBase58()));
  const toAdd = newAddresses.filter((a) => !existing.has(a.toBase58()));

  console.log("LUT:           ", lut.toBase58());
  console.log("existing size: ", lutAccount.value.state.addresses.length);
  console.log("to add:        ", toAdd.length, "/", newAddresses.length);
  for (const a of toAdd) console.log("  +", a.toBase58());

  if (toAdd.length === 0) {
    console.log("\nNothing to add — LUT already has all csSOL-WT entries.");
    return;
  }

  const ix = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lut,
    addresses: toAdd,
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  console.log("\ntx:", sig);

  const finishSlot = await conn.getSlot("confirmed");
  console.log(`extended at slot ${finishSlot}; resolvable from slot ${finishSlot + 1}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
