import { PublicKey } from "@solana/web3.js";

// Centralized addresses. Override any via Vite env vars (VITE_*).
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";

export const JITO_VAULT_PROGRAM = new PublicKey(
  import.meta.env.VITE_JITO_VAULT_PROGRAM ?? "Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8",
);

// csSOL deploy state on devnet (output of init-cssol-jito-vault.ts).
export const CSSOL_VAULT = new PublicKey(
  import.meta.env.VITE_CSSOL_VAULT ?? "EVHeVZZmRyF47VKmZVeJkCZtB6ZhKZZqczcW1n35XJ7W",
);
export const CSSOL_VRT_MINT = new PublicKey(
  import.meta.env.VITE_CSSOL_VRT_MINT ?? "6W1ba4xs6rdQF7j9nRr3uP5faFscQ4HwKXwYu9VEVvB8",
);
export const CSSOL_VAULT_ST_TOKEN_ACCOUNT = new PublicKey(
  import.meta.env.VITE_CSSOL_VAULT_ST_TOKEN_ACCOUNT ?? "25YAVwucokaFEPRNGapx3iBybQpkTN31cDfc9aU3RF3Z",
);

// Jito Vault SDK constants (verified at runtime against the program).
export const MINT_TO_DISCRIMINATOR = 11;
