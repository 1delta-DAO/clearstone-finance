/**
 * whitelist-wallet.ts
 *
 * Whitelists a wallet address as a Holder or Liquidator on the governor pool.
 *
 * Usage:
 *   npx tsx scripts/whitelist-wallet.ts <WALLET_ADDRESS> [holder|liquidator]
 *
 * Examples:
 *   npx tsx scripts/whitelist-wallet.ts 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
 *   npx tsx scripts/whitelist-wallet.ts 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU liquidator
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
// The csSOL governor was redeployed at this address — `6xqW…` is what
// the on-chain pool_config (`5dkkn…FRpb`) is owned by, and what the
// playground (frontend addresses.ts) talks to. The old `BrZYcb…`
// program still exists on devnet but isn't bound to the csSOL pool.
const GOVERNOR_PROGRAM_ID = new PublicKey(
  process.env.GOVERNOR_PROGRAM_ID ?? "6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi",
);
// csSOL deployment uses a redeployed delta-mint at this address (the
// `13Su…` original is the legacy build, not bound to csSOL).
const DELTA_MINT_PROGRAM_ID = new PublicKey(
  process.env.DELTA_MINT_PROGRAM_ID ?? "BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy",
);

function loadKeypair(): Keypair {
  if (process.env.DEPLOY_KEYPAIR) {
    const raw = fs.readFileSync(process.env.DEPLOY_KEYPAIR, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const defaultPath = path.join(process.env.HOME || "~", ".config/solana/id.json");
  const raw = fs.readFileSync(defaultPath, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function loadIdl(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", `${name}.json`), "utf8"));
}

function loadDeployment() {
  // Prefer the csSOL pool config — `deployment.json` is the legacy
  // eUSX pool's manifest (`5dkkn…FRpb`, owned by the old governor at
  // `BrZYcb…`), which doesn't match the csSOL governor at `6xqW…`.
  // Override with POOL_CONFIG_JSON env if needed.
  const file = process.env.POOL_CONFIG_JSON ?? path.join(__dirname, "..", "configs", "devnet", "cssol-pool.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const walletAddr = process.argv[2];
  const role = (process.argv[3] || "holder").toLowerCase();

  if (!walletAddr) {
    console.error("Usage: npx tsx scripts/whitelist-wallet.ts <WALLET_ADDRESS> [holder|liquidator]");
    process.exit(1);
  }
  if (role !== "holder" && role !== "liquidator") {
    console.error("Role must be 'holder' or 'liquidator'");
    process.exit(1);
  }

  const targetWallet = new PublicKey(walletAddr);
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const provider = new AnchorProvider(conn, new Wallet(authority), { commitment: "confirmed" });

  const deployment = loadDeployment();
  // cssol-pool.json shape: { pool: { poolConfig, ... }, dmMintConfig, ... }
  const poolConfig = new PublicKey(deployment.pool?.poolConfig ?? deployment.poolConfig);
  const dmMintConfig = new PublicKey(deployment.dmMintConfig ?? deployment.pool?.dmMintConfig);

  // Override the IDL's embedded program address so Anchor talks to the
  // actually-deployed csSOL governor (the IDL was generated against a
  // different declare_id and has stale metadata).
  const idl = loadIdl("governor");
  idl.address = GOVERNOR_PROGRAM_ID.toBase58();
  if (idl.metadata) idl.metadata.address = GOVERNOR_PROGRAM_ID.toBase58();
  const governorProgram = new Program(idl, provider);

  // Derive whitelist PDA
  const [whitelistEntry] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist"), dmMintConfig.toBuffer(), targetWallet.toBuffer()],
    DELTA_MINT_PROGRAM_ID
  );

  // Check if already whitelisted
  const existing = await conn.getAccountInfo(whitelistEntry);
  if (existing) {
    console.log(`Already whitelisted: ${targetWallet.toBase58()}`);
    console.log(`  PDA: ${whitelistEntry.toBase58()}`);
    return;
  }

  console.log(`Whitelisting ${targetWallet.toBase58()} as ${role}...`);
  console.log(`  Authority: ${authority.publicKey.toBase58()}`);
  console.log(`  Pool:      ${poolConfig.toBase58()}`);

  const roleArg = role === "holder" ? { holder: {} } : { liquidator: {} };

  try {
    // Pools with `activate_wrapping` already called transferred the
    // delta-mint authority to the pool PDA; the pool now has to sign
    // via its `co_authority` seat. `add_participant_via_pool` does
    // exactly that — `add_participant` would only work pre-activation.
    // `adminEntry` is an Option; pass null to skip (requires the
    // signer to be the pool's root authority).
    const sig = await (governorProgram.methods as any)
      .addParticipantViaPool(roleArg)
      .accounts({
        authority: authority.publicKey,
        poolConfig,
        adminEntry: null,
        dmMintConfig,
        wallet: targetWallet,
        whitelistEntry,
        deltaMintProgram: DELTA_MINT_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`\nWhitelisted! Role: ${role}`);
    console.log(`  Tx: ${sig}`);
    console.log(`  PDA: ${whitelistEntry.toBase58()}`);
  } catch (e: any) {
    console.error(`Failed: ${e.message}`);
    if (e.logs) console.error("Logs:", e.logs.slice(-3).join("\n  "));
  }
}

main().catch(console.error);
