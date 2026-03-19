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
const GOVERNOR_PROGRAM_ID = new PublicKey("BrZYcbPBt9nW4b6xWSodwXRfAfRNZTCzthp1ywMG3KJh");
const DELTA_MINT_PROGRAM_ID = new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn");

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
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "configs", "devnet", "deployment.json"), "utf8"));
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
  const poolConfig = new PublicKey(deployment.pool.poolConfig);
  const dmMintConfig = new PublicKey(deployment.pool.dmMintConfig);

  const governorProgram = new Program(loadIdl("governor"), provider);

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
    const sig = await (governorProgram.methods as any)
      .addParticipant(roleArg)
      .accounts({
        authority: authority.publicKey,
        poolConfig,
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
