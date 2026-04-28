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
export const SET_SECONDARY_ADMIN_DISCRIMINATOR = 22;
export const ROLE_MINT_BURN_ADMIN = 6; // VaultAdminRole::MintBurnAdmin

// The pubkey we restore mintBurnAdmin to after a privileged-rotation
// playground tx. Defaults to the governor pool PDA so production gating
// stays in place. Override via VITE_DEFAULT_MINT_BURN_ADMIN if testing
// against another deploy.
export const DEFAULT_MINT_BURN_ADMIN = new PublicKey(
  import.meta.env.VITE_DEFAULT_MINT_BURN_ADMIN ?? "QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e",
);
