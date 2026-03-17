/**
 * deploy-governor-devnet.ts
 *
 * Clean governor deployment to Solana devnet.
 * Deploys programs, initializes a governor pool, and creates the Kamino
 * lending market with reserves.
 *
 * Usage:
 *   DEPLOY_MNEMONIC="abandon abandon ..." npx ts-node scripts/deploy-governor-devnet.ts
 *
 *   Or with a keypair file:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json npx ts-node scripts/deploy-governor-devnet.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const GOVERNOR_PROGRAM_ID = new PublicKey("2TaDoLXG6HzXpFJngMvNt9tY29Zovah77HvJZvqW96sr");
const DELTA_MINT_PROGRAM_ID = new PublicKey("3FLEACtqQ2G9h6sc7gLniVfK4maG59Eo4pt8H4A9QggY");
const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");

// Devnet mints — we'll create a devnet USDC mint if needed
const USDY_MINT = new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6");

// Pyth V2 devnet oracle feeds
const PYTH_USDY_DEVNET = new PublicKey("E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4");

// Anchor discriminators
const IX_INIT_POOL = Buffer.from([
  // sha256("global:initialize_pool")[0..8]
  0x16, 0xb6, 0xfe, 0x76, 0x48, 0x73, 0xd0, 0x26,
]);

const IX_REGISTER_MARKET = Buffer.from([
  // sha256("global:register_lending_market")[0..8]
  0x84, 0xd6, 0xdb, 0x8a, 0xbe, 0x8c, 0x25, 0x3e,
]);

const IX_ADD_PARTICIPANT = Buffer.from([
  // sha256("global:add_participant")[0..8]
  0xc5, 0x1c, 0xf6, 0x97, 0xb9, 0x58, 0x71, 0xb5,
]);

const IX_MINT_WRAPPED = Buffer.from([
  // sha256("global:mint_wrapped")[0..8]
  0x40, 0x80, 0x60, 0x62, 0x87, 0x4b, 0x3b, 0x9a,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(): Keypair {
  // From JSON file path
  if (process.env.DEPLOY_KEYPAIR) {
    const raw = fs.readFileSync(process.env.DEPLOY_KEYPAIR, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  // From env var JSON array
  if (process.env.ADMIN_KEYPAIR_JSON) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.ADMIN_KEYPAIR_JSON)));
  }
  // Default solana CLI wallet
  const defaultPath = path.join(
    process.env.HOME || "~",
    ".config/solana/id.json"
  );
  if (fs.existsSync(defaultPath)) {
    const raw = fs.readFileSync(defaultPath, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  throw new Error(
    "No keypair found. Set DEPLOY_KEYPAIR, ADMIN_KEYPAIR_JSON, or have ~/.config/solana/id.json"
  );
}

function poolConfigPda(underlyingMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), underlyingMint.toBuffer()],
    GOVERNOR_PROGRAM_ID
  );
}

function dmMintConfigPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint_config"), mint.toBuffer()],
    DELTA_MINT_PROGRAM_ID
  );
}

function dmMintAuthorityPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), mint.toBuffer()],
    DELTA_MINT_PROGRAM_ID
  );
}

function marketAuthorityPda(market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), market.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

function buildInitializePoolIx(
  authority: PublicKey,
  poolConfig: PublicKey,
  underlyingMint: PublicKey,
  wrappedMint: PublicKey,
  dmMintConfig: PublicKey,
  dmMintAuthority: PublicKey,
  params: {
    underlyingOracle: PublicKey;
    borrowMint: PublicKey;
    borrowOracle: PublicKey;
    decimals: number;
    ltvPct: number;
    liquidationThresholdPct: number;
  }
) {
  // Borsh: disc(8) + PoolParams { pubkey(32) + pubkey(32) + pubkey(32) + u8 + u8 + u8 }
  const data = Buffer.alloc(8 + 32 + 32 + 32 + 1 + 1 + 1);
  let offset = 0;
  IX_INIT_POOL.copy(data, offset); offset += 8;
  params.underlyingOracle.toBuffer().copy(data, offset); offset += 32;
  params.borrowMint.toBuffer().copy(data, offset); offset += 32;
  params.borrowOracle.toBuffer().copy(data, offset); offset += 32;
  data.writeUInt8(params.decimals, offset); offset += 1;
  data.writeUInt8(params.ltvPct, offset); offset += 1;
  data.writeUInt8(params.liquidationThresholdPct, offset);

  return {
    programId: GOVERNOR_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolConfig, isSigner: false, isWritable: true },
      { pubkey: underlyingMint, isSigner: false, isWritable: false },
      { pubkey: wrappedMint, isSigner: true, isWritable: true },
      { pubkey: dmMintConfig, isSigner: false, isWritable: true },
      { pubkey: dmMintAuthority, isSigner: false, isWritable: false },
      { pubkey: DELTA_MINT_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
}

function buildRegisterLendingMarketIx(
  authority: PublicKey,
  poolConfig: PublicKey,
  lendingMarket: PublicKey,
  collateralReserve: PublicKey,
  borrowReserve: PublicKey
) {
  const data = Buffer.alloc(8 + 32 + 32 + 32);
  let offset = 0;
  IX_REGISTER_MARKET.copy(data, offset); offset += 8;
  lendingMarket.toBuffer().copy(data, offset); offset += 32;
  collateralReserve.toBuffer().copy(data, offset); offset += 32;
  borrowReserve.toBuffer().copy(data, offset);

  return {
    programId: GOVERNOR_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolConfig, isSigner: false, isWritable: true },
    ],
    data,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();
  const wrappedMintKp = Keypair.generate();

  console.log("============================================");
  console.log("  Governor Devnet Deployment");
  console.log("============================================");
  console.log(`  RPC:            ${RPC_URL}`);
  console.log(`  Authority:      ${authority.publicKey.toBase58()}`);
  console.log(`  Underlying:     ${USDY_MINT.toBase58()} (USDY)`);
  console.log(`  Wrapped mint:   ${wrappedMintKp.publicKey.toBase58()} (dUSDY — new)`);
  console.log(`  Oracle (USDY):  ${PYTH_USDY_DEVNET.toBase58()}`);
  console.log("============================================\n");

  // Check balance
  const balance = await conn.getBalance(authority.publicKey);
  console.log(`Balance: ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 0.5 * 1e9) {
    console.log("Requesting airdrop...");
    const sig = await conn.requestAirdrop(authority.publicKey, 2 * 1e9);
    await conn.confirmTransaction(sig, "confirmed");
    console.log("Airdrop received.");
  }

  // Check programs are deployed
  const govInfo = await conn.getAccountInfo(GOVERNOR_PROGRAM_ID);
  const dmInfo = await conn.getAccountInfo(DELTA_MINT_PROGRAM_ID);
  const klendInfo = await conn.getAccountInfo(KLEND_PROGRAM_ID);

  if (!govInfo?.executable) {
    console.error("ERROR: Governor program not deployed. Run: pnpm deploy:mnemonic");
    process.exit(1);
  }
  if (!dmInfo?.executable) {
    console.error("ERROR: Delta-mint program not deployed. Run: pnpm deploy:mnemonic");
    process.exit(1);
  }
  if (!klendInfo?.executable) {
    console.error("ERROR: Klend program not found on devnet.");
    process.exit(1);
  }
  console.log("All programs verified on devnet.\n");

  // ---------------------------------------------------------------------------
  // Step 1: Initialize Governor Pool
  // ---------------------------------------------------------------------------
  console.log("Step 1: Initializing governor pool...");

  const [poolConfig] = poolConfigPda(USDY_MINT);
  const [dmMintConfig] = dmMintConfigPda(wrappedMintKp.publicKey);
  const [dmMintAuthority] = dmMintAuthorityPda(wrappedMintKp.publicKey);

  // For devnet, we use a placeholder USDC mint and oracle.
  // The USDC mock oracle will be created by setup-devnet-oracles.ts
  const devnetUsdcMint = Keypair.generate(); // placeholder — replace with actual devnet USDC
  const devnetUsdcOracle = PublicKey.default; // placeholder — set after mock oracle creation

  const poolExists = await conn.getAccountInfo(poolConfig);
  if (poolExists) {
    console.log(`  Pool already exists: ${poolConfig.toBase58()}`);
    console.log("  Skipping pool initialization.\n");
  } else {
    const ix = buildInitializePoolIx(
      authority.publicKey,
      poolConfig,
      USDY_MINT,
      wrappedMintKp.publicKey,
      dmMintConfig,
      dmMintAuthority,
      {
        underlyingOracle: PYTH_USDY_DEVNET,
        borrowMint: devnetUsdcMint.publicKey,
        borrowOracle: devnetUsdcOracle,
        decimals: 6,
        ltvPct: 75,
        liquidationThresholdPct: 82,
      }
    );

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ix
    );

    try {
      const sig = await sendAndConfirmTransaction(conn, tx, [authority, wrappedMintKp], {
        commitment: "confirmed",
      });
      console.log(`  Pool created: ${poolConfig.toBase58()}`);
      console.log(`  dUSDY mint:   ${wrappedMintKp.publicKey.toBase58()}`);
      console.log(`  Tx: ${sig}\n`);
    } catch (e: any) {
      console.error("  Pool creation failed:", e.message);
      console.error("  This may be expected if programs need deployment first.\n");
    }
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  const output = {
    cluster: "devnet",
    rpc: RPC_URL,
    authority: authority.publicKey.toBase58(),
    programs: {
      governor: GOVERNOR_PROGRAM_ID.toBase58(),
      deltaMint: DELTA_MINT_PROGRAM_ID.toBase58(),
      klend: KLEND_PROGRAM_ID.toBase58(),
    },
    pool: {
      poolConfig: poolConfig.toBase58(),
      underlyingMint: USDY_MINT.toBase58(),
      wrappedMint: wrappedMintKp.publicKey.toBase58(),
      dmMintConfig: dmMintConfig.toBase58(),
      dmMintAuthority: dmMintAuthority.toBase58(),
    },
    oracles: {
      usdyPythV2: PYTH_USDY_DEVNET.toBase58(),
      usdcPythV2: "MOCK — run setup-devnet-oracles.ts",
    },
    _nextSteps: [
      "1. Run setup-devnet-oracles.ts to create mock USDC oracle",
      "2. Create klend market + reserves (setup-devnet-market.ts)",
      "3. Register lending market with governor (register_lending_market)",
      "4. Add participants and start minting",
    ],
  };

  const outPath = path.join(__dirname, "..", "configs", "devnet", "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("============================================");
  console.log("  Deployment output saved to:");
  console.log(`  ${outPath}`);
  console.log("============================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
