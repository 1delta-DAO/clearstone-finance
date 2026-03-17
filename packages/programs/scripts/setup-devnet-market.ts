/**
 * setup-devnet-market.ts
 *
 * Creates a Kamino lending market with dUSDY collateral and USDC borrow
 * reserves on Solana devnet. Then registers the market with the governor.
 *
 * Prerequisites:
 *   1. Programs deployed: delta-mint, governor (pnpm deploy:mnemonic)
 *   2. Governor pool initialized (deploy-governor-devnet.ts)
 *   3. Oracle accounts ready (setup-devnet-oracles.ts)
 *
 * Usage:
 *   DEPLOY_KEYPAIR=~/.config/solana/id.json npx ts-node scripts/setup-devnet-market.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");
const GOVERNOR_PROGRAM_ID = new PublicKey("2TaDoLXG6HzXpFJngMvNt9tY29Zovah77HvJZvqW96sr");

// Pyth V2 devnet USDY oracle
const PYTH_USDY_DEVNET = new PublicKey("E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4");

// klend account sizes (from mainnet)
const LENDING_MARKET_SIZE = 4656;
const RESERVE_SIZE = 8616;

// Discriminators
const DISC = {
  initLendingMarket: Buffer.from([0xaf, 0x08, 0x5f, 0x1f, 0x8d, 0x39, 0x53, 0xfe]),
  initReserve: Buffer.from([0x5a, 0xa0, 0xb0, 0x08, 0xf7, 0x14, 0xdb, 0xdb]),
  updateReserveConfig: Buffer.from([0x3d, 0x94, 0x64, 0x46, 0x8f, 0x6b, 0x11, 0x0d]),
  refreshReserve: Buffer.from([0x02, 0xda, 0x8a, 0x96, 0xa3, 0x16, 0x8b, 0x23]),
};

const CONFIG_MODE = {
  UpdateLoanToValuePct: 0,
  UpdateLiquidationThresholdPct: 2,
  UpdateDepositLimit: 8,
  UpdateBorrowLimit: 9,
  UpdatePythPrice: 20,
  UpdateBorrowRateCurve: 23,
  UpdateReserveStatus: 34,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(): Keypair {
  if (process.env.DEPLOY_KEYPAIR) {
    const raw = fs.readFileSync(process.env.DEPLOY_KEYPAIR, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const defaultPath = path.join(process.env.HOME || "~", ".config/solana/id.json");
  const raw = fs.readFileSync(defaultPath, "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function marketAuthorityPda(market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), market.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

function reserveLiquiditySupplyPda(reserve: PublicKey, market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_liq_supply"), market.toBuffer(), reserve.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

function reserveFeeVaultPda(reserve: PublicKey, market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_receiver"), market.toBuffer(), reserve.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

function reserveCollateralMintPda(reserve: PublicKey, market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_coll_mint"), market.toBuffer(), reserve.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

function reserveCollateralSupplyPda(reserve: PublicKey, market: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reserve_coll_supply"), market.toBuffer(), reserve.toBuffer()],
    KLEND_PROGRAM_ID
  );
  return pda;
}

function poolConfigPda(underlyingMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), underlyingMint.toBuffer()],
    GOVERNOR_PROGRAM_ID
  );
  return pda;
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

function buildInitLendingMarket(owner: PublicKey, marketKp: PublicKey): TransactionInstruction {
  const quoteCurrency = Buffer.alloc(32); // "USD" — left as zeros for simplicity
  const data = Buffer.alloc(8 + 32);
  DISC.initLendingMarket.copy(data, 0);
  quoteCurrency.copy(data, 8);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: marketKp, isSigner: true, isWritable: true },
      { pubkey: marketAuthorityPda(marketKp), isSigner: false, isWritable: false },
      { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildInitReserve(
  owner: PublicKey,
  market: PublicKey,
  reserve: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey
): TransactionInstruction {
  const mAuth = marketAuthorityPda(market);
  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: mAuth, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: reserveLiquiditySupplyPda(reserve, market), isSigner: false, isWritable: true },
      { pubkey: reserveFeeVaultPda(reserve, market), isSigner: false, isWritable: true },
      { pubkey: reserveCollateralMintPda(reserve, market), isSigner: false, isWritable: true },
      { pubkey: reserveCollateralSupplyPda(reserve, market), isSigner: false, isWritable: true },
      { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: DISC.initReserve,
  });
}

function buildUpdateReserveConfig(
  owner: PublicKey,
  market: PublicKey,
  reserve: PublicKey,
  mode: number,
  value: Buffer,
  skipValidation = true
): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + 4 + value.length + 1);
  let offset = 0;
  DISC.updateReserveConfig.copy(data, offset); offset += 8;
  data.writeUInt32LE(mode, offset); offset += 4;
  data.writeUInt32LE(value.length, offset); offset += 4;
  value.copy(data, offset); offset += value.length;
  data.writeUInt8(skipValidation ? 1 : 0, offset);

  return new TransactionInstruction({
    programId: KLEND_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: KLEND_GLOBAL_CONFIG, isSigner: false, isWritable: false },
      { pubkey: market, isSigner: false, isWritable: false },
      { pubkey: reserve, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function u64Buf(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return buf;
}

function u8Buf(n: number): Buffer {
  return Buffer.from([n]);
}

function pubkeyBuf(pk: PublicKey): Buffer {
  return pk.toBuffer();
}

function buildRegisterLendingMarketIx(
  authority: PublicKey,
  poolConfig: PublicKey,
  lendingMarket: PublicKey,
  collateralReserve: PublicKey,
  borrowReserve: PublicKey
): TransactionInstruction {
  const disc = Buffer.from([0x84, 0xd6, 0xdb, 0x8a, 0xbe, 0x8c, 0x25, 0x3e]);
  const data = Buffer.alloc(8 + 32 + 32 + 32);
  let offset = 0;
  disc.copy(data, offset); offset += 8;
  lendingMarket.toBuffer().copy(data, offset); offset += 32;
  collateralReserve.toBuffer().copy(data, offset); offset += 32;
  borrowReserve.toBuffer().copy(data, offset);

  return new TransactionInstruction({
    programId: GOVERNOR_PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolConfig, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const conn = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair();

  console.log("============================================");
  console.log("  Devnet Kamino Market Setup");
  console.log("============================================");
  console.log(`  Authority: ${authority.publicKey.toBase58()}`);
  console.log("============================================\n");

  // Load oracle config
  const oracleConfigPath = path.join(__dirname, "..", "configs", "devnet", "oracles-deployed.json");
  let usdcOracleAddr: PublicKey;
  if (fs.existsSync(oracleConfigPath)) {
    const oracleConfig = JSON.parse(fs.readFileSync(oracleConfigPath, "utf8"));
    usdcOracleAddr = new PublicKey(oracleConfig.devnetOracles["USDC/USD"].address);
    console.log(`  USDC oracle (from config): ${usdcOracleAddr.toBase58()}`);
  } else {
    console.log("  WARNING: No oracle config found. Run setup-devnet-oracles.ts first.");
    console.log("  Using USDY oracle as placeholder for both reserves.\n");
    usdcOracleAddr = PYTH_USDY_DEVNET;
  }

  // Load deployment config if available
  const deployConfigPath = path.join(__dirname, "..", "configs", "devnet", "deployment.json");
  let wrappedMint: PublicKey;
  let underlyingMint = new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6");
  if (fs.existsSync(deployConfigPath)) {
    const deployConfig = JSON.parse(fs.readFileSync(deployConfigPath, "utf8"));
    wrappedMint = new PublicKey(deployConfig.pool.wrappedMint);
    console.log(`  Wrapped mint (from config): ${wrappedMint.toBase58()}`);
  } else {
    console.log("  WARNING: No deployment config. Using dummy wrapped mint.");
    wrappedMint = Keypair.generate().publicKey;
  }

  // Generate new keypairs for market and reserves
  const marketKp = Keypair.generate();
  const dUsdyReserveKp = Keypair.generate();
  const usdcReserveKp = Keypair.generate();

  // We need a devnet USDC mint. On devnet there's no canonical USDC.
  // For testing, we create a regular SPL token mint.
  const devnetUsdcMintKp = Keypair.generate();

  console.log(`\n  Market:         ${marketKp.publicKey.toBase58()}`);
  console.log(`  dUSDY reserve:  ${dUsdyReserveKp.publicKey.toBase58()}`);
  console.log(`  USDC reserve:   ${usdcReserveKp.publicKey.toBase58()}`);
  console.log(`  USDC mint:      ${devnetUsdcMintKp.publicKey.toBase58()} (devnet test mint)`);

  // ---------------------------------------------------------------------------
  // Step 1: Create lending market
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 1: Create lending market ---");

  const marketRent = await conn.getMinimumBalanceForRentExemption(LENDING_MARKET_SIZE);
  const tx1 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: marketKp.publicKey,
      lamports: marketRent,
      space: LENDING_MARKET_SIZE,
      programId: KLEND_PROGRAM_ID,
    }),
    buildInitLendingMarket(authority.publicKey, marketKp.publicKey)
  );

  try {
    const sig = await sendAndConfirmTransaction(conn, tx1, [authority, marketKp]);
    console.log(`  Market created: ${sig}`);
  } catch (e: any) {
    console.error(`  Failed: ${e.message}`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Initialize reserves
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 2: Initialize reserves ---");

  const reserveRent = await conn.getMinimumBalanceForRentExemption(RESERVE_SIZE);

  // dUSDY reserve (Token-2022)
  const tx2a = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: dUsdyReserveKp.publicKey,
      lamports: reserveRent,
      space: RESERVE_SIZE,
      programId: KLEND_PROGRAM_ID,
    }),
    buildInitReserve(
      authority.publicKey,
      marketKp.publicKey,
      dUsdyReserveKp.publicKey,
      wrappedMint,
      TOKEN_2022_PROGRAM_ID
    )
  );

  try {
    const sig = await sendAndConfirmTransaction(conn, tx2a, [authority, dUsdyReserveKp]);
    console.log(`  dUSDY reserve created: ${sig}`);
  } catch (e: any) {
    console.error(`  dUSDY reserve failed: ${e.message}`);
  }

  // USDC reserve (Token Program)
  // First create a devnet USDC mint
  // (skipped for brevity — in practice use spl-token create-token on devnet)
  const tx2b = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: usdcReserveKp.publicKey,
      lamports: reserveRent,
      space: RESERVE_SIZE,
      programId: KLEND_PROGRAM_ID,
    }),
    buildInitReserve(
      authority.publicKey,
      marketKp.publicKey,
      usdcReserveKp.publicKey,
      devnetUsdcMintKp.publicKey,
      TOKEN_PROGRAM_ID
    )
  );

  try {
    const sig = await sendAndConfirmTransaction(conn, tx2b, [authority, usdcReserveKp]);
    console.log(`  USDC reserve created: ${sig}`);
  } catch (e: any) {
    console.error(`  USDC reserve failed: ${e.message}`);
  }

  // ---------------------------------------------------------------------------
  // Step 3: Configure reserves
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 3: Configure reserves ---");

  const market = marketKp.publicKey;

  // dUSDY config batch
  const dUsdyConfigs = [
    { mode: CONFIG_MODE.UpdatePythPrice, value: pubkeyBuf(PYTH_USDY_DEVNET) },
    { mode: CONFIG_MODE.UpdateLoanToValuePct, value: u8Buf(75) },
    { mode: CONFIG_MODE.UpdateLiquidationThresholdPct, value: u8Buf(82) },
    { mode: CONFIG_MODE.UpdateDepositLimit, value: u64Buf(100_000_000_000n) },
    { mode: CONFIG_MODE.UpdateBorrowLimit, value: u64Buf(0n) },
  ];

  for (const { mode, value } of dUsdyConfigs) {
    const tx = new Transaction().add(
      buildUpdateReserveConfig(authority.publicKey, market, dUsdyReserveKp.publicKey, mode, value)
    );
    try {
      await sendAndConfirmTransaction(conn, tx, [authority]);
      console.log(`  dUSDY config mode ${mode}: OK`);
    } catch (e: any) {
      console.error(`  dUSDY config mode ${mode}: ${e.message}`);
    }
  }

  // USDC config batch
  const usdcConfigs = [
    { mode: CONFIG_MODE.UpdatePythPrice, value: pubkeyBuf(usdcOracleAddr) },
    { mode: CONFIG_MODE.UpdateLoanToValuePct, value: u8Buf(0) },
    { mode: CONFIG_MODE.UpdateLiquidationThresholdPct, value: u8Buf(0) },
    { mode: CONFIG_MODE.UpdateDepositLimit, value: u64Buf(100_000_000_000n) },
    { mode: CONFIG_MODE.UpdateBorrowLimit, value: u64Buf(75_000_000_000n) },
  ];

  for (const { mode, value } of usdcConfigs) {
    const tx = new Transaction().add(
      buildUpdateReserveConfig(authority.publicKey, market, usdcReserveKp.publicKey, mode, value)
    );
    try {
      await sendAndConfirmTransaction(conn, tx, [authority]);
      console.log(`  USDC config mode ${mode}: OK`);
    } catch (e: any) {
      console.error(`  USDC config mode ${mode}: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: Register with governor
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 4: Register lending market with governor ---");

  const poolConfig = poolConfigPda(underlyingMint);

  const poolInfo = await conn.getAccountInfo(poolConfig);
  if (poolInfo) {
    const tx4 = new Transaction().add(
      buildRegisterLendingMarketIx(
        authority.publicKey,
        poolConfig,
        market,
        dUsdyReserveKp.publicKey,
        usdcReserveKp.publicKey
      )
    );
    try {
      const sig = await sendAndConfirmTransaction(conn, tx4, [authority]);
      console.log(`  Registered: ${sig}`);
    } catch (e: any) {
      console.error(`  Registration failed: ${e.message}`);
    }
  } else {
    console.log("  Governor pool not found. Run deploy-governor-devnet.ts first.");
    console.log("  Skipping registration.\n");
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const output = {
    cluster: "devnet",
    market: marketKp.publicKey.toBase58(),
    reserves: {
      dUSDY: {
        address: dUsdyReserveKp.publicKey.toBase58(),
        mint: wrappedMint.toBase58(),
        oracle: PYTH_USDY_DEVNET.toBase58(),
        tokenProgram: "Token-2022",
        role: "collateral",
        ltv: "75%",
      },
      USDC: {
        address: usdcReserveKp.publicKey.toBase58(),
        mint: devnetUsdcMintKp.publicKey.toBase58(),
        oracle: usdcOracleAddr.toBase58(),
        tokenProgram: "Token Program",
        role: "borrow",
        borrowLimit: "75,000 USDC",
      },
    },
    governor: {
      poolConfig: poolConfig.toBase58(),
    },
    _keypairBackups: {
      _warning: "Store these securely — needed for market administration",
      market: Array.from(marketKp.secretKey),
      dUsdyReserve: Array.from(dUsdyReserveKp.secretKey),
      usdcReserve: Array.from(usdcReserveKp.secretKey),
    },
  };

  const outPath = path.join(__dirname, "..", "configs", "devnet", "market-deployed.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("\n============================================");
  console.log("  Market config saved to:");
  console.log(`  ${outPath}`);
  console.log("============================================");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
