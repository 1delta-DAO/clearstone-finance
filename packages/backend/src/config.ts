import "dotenv/config";
import { Keypair } from "@solana/web3.js";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function loadAdminKeypair(): Keypair {
  const raw = requireEnv("ADMIN_KEYPAIR_JSON");
  const bytes = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export const config = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  host: process.env.HOST ?? "0.0.0.0",

  // Solana
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  deltaMintProgramId:
    process.env.DELTA_MINT_PROGRAM_ID ??
    "3FLEACtqQ2G9h6sc7gLniVfK4maG59Eo4pt8H4A9QggY",
    
  // Comma-separated list of wrapped mint addresses, one per pool.
  // e.g. WRAPPED_MINT_ADDRESSES=dUSDY_pubkey,dUSDC_pubkey
  wrappedMintAddresses: requireEnv("WRAPPED_MINT_ADDRESSES")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Rate limiting
  rateLimit: {
    max: parseInt(process.env.RATE_LIMIT_MAX ?? "30", 10),
    timeWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
  },

  // Risk controls
  ofacMockList: (process.env.OFAC_MOCK_LIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  depositCapUsd: parseInt(process.env.DEPOSIT_CAP_USD ?? "1000000", 10),
  poolCapUsd: parseInt(process.env.POOL_CAP_USD ?? "50000000", 10),

  // Microsoft Entra B2C
  entra: {
    // The tenant subdomain: <tenantName>.onmicrosoft.com / <tenantName>.b2clogin.com
    tenantName: process.env.ENTRA_TENANT_NAME ?? "",
    // The Azure AD tenant GUID (found in Azure portal → Overview)
    tenantId: process.env.ENTRA_TENANT_ID ?? "",
    // App registration Client ID (the audience your tokens are issued for)
    clientId: process.env.ENTRA_CLIENT_ID ?? "",
    // B2C user flow / custom policy name, e.g. "B2C_1_signupsignin"
    // Only used when flavor=b2c
    policy: process.env.ENTRA_POLICY ?? "B2C_1_signupsignin",
    // "b2c" (classic, default) or "external" (new Entra External ID tenants created after May 2025)
    flavor: (process.env.ENTRA_FLAVOR ?? "b2c") as "b2c" | "external",
  },

  // Fireblocks (optional — leave blank to use local keypair)
  fireblocksApiKey: process.env.FIREBLOCKS_API_KEY ?? "",
  fireblocksVaultAccountId: process.env.FIREBLOCKS_VAULT_ACCOUNT_ID ?? "0",
  fireblocksSignerPublicKey: process.env.FIREBLOCKS_SIGNER_PUBLIC_KEY ?? "",

  // Lazy-loaded to avoid crashing on import during tests
  get adminKeypair(): Keypair {
    return loadAdminKeypair();
  },
};
