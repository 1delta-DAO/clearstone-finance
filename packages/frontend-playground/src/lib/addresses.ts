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

// Governor + delta-mint program IDs and pool-state addresses, used by the
// new wrap_with_jito_vault flow.
export const GOVERNOR_PROGRAM = new PublicKey(
  import.meta.env.VITE_GOVERNOR_PROGRAM ?? "6xqW3D1ebp5WjbYh4vwar7ponxrpEaQiVG6uhBYVZtJi",
);
export const DELTA_MINT_PROGRAM = new PublicKey(
  import.meta.env.VITE_DELTA_MINT_PROGRAM ?? "BKprvLqNUDCGrpxddppHHQ3UBhof8J5axyexDyctX1xy",
);
export const POOL_PDA = new PublicKey(
  import.meta.env.VITE_POOL_PDA ?? "QoR6KXoiyTfd3TRk9gds4pLWbaueFmTgagec9fAWD9e",
);
export const CSSOL_MINT = new PublicKey(
  import.meta.env.VITE_CSSOL_MINT ?? "6qpu7yCkdKF2D8vnySUNQEQczo5tYGRxbVFfdd8S5Nxt",
);
export const DM_MINT_CONFIG = new PublicKey(
  import.meta.env.VITE_DM_MINT_CONFIG ?? "FaBWmajcbEEnmep9wxx3jKcbjtWKkPbKHgusPxVZwDc2",
);
export const DM_MINT_AUTHORITY = new PublicKey(
  import.meta.env.VITE_DM_MINT_AUTHORITY ?? "Gyv1o28H98zZYnREBmaKq1pJJ5eHqd1wouJ6Km5fCTsT",
);
export const POOL_VRT_ATA = new PublicKey(
  import.meta.env.VITE_POOL_VRT_ATA ?? "BvBy8orQZPXFwR6fgyCkLoyZfK1TBRteG5g4ipuqrEZp",
);

// Klend market + reserves for csSOL elevation group 2.
export const KLEND_PROGRAM = new PublicKey(
  import.meta.env.VITE_KLEND_PROGRAM ?? "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
);
// v2 unified market — bootstrapped via scripts/bootstrap-cssol-market-v2.ts
// (the v1 market `2gRy7f…heyejW` is locked due to klend's reserve_config
// validation lockout once group 1 was registered; v2 has all 5 reserves
// (csSOL, wSOL, csSOL-WT, deUSX, sUSDC) plus both elevation groups
// (1 = stables, 2 = LST/SOL) configured cleanly).
export const KLEND_MARKET = new PublicKey(
  import.meta.env.VITE_KLEND_MARKET ?? "En6zW3ne2rf7jWZt7tCs98ixUvEqLM4siAuuigtTiDSi",
);
export const CSSOL_RESERVE = new PublicKey(
  import.meta.env.VITE_CSSOL_RESERVE ?? "ARL4xwastet7NPaedBJRsPnHtHmQDzuqXa6FjD2Uny8s",
);
export const WSOL_RESERVE = new PublicKey(
  import.meta.env.VITE_WSOL_RESERVE ?? "F1HhwbkAihXwVx8KNLz6WhNdcGAPbr7NKKsdHqQGXdk4",
);
// Oracle accounts read by klend's RefreshReserve. The csSOL oracle is the
// accrual-oracle output account (pythConfiguration.price), which itself is
// driven by the keeper-cloud worker that reads the Pyth SOL/USD pull oracle
// and the Jito Vault's tokensDeposited / vrtSupply ratio. The wSOL oracle
// is a real Pyth Receiver SOL/USD push account.
export const CSSOL_RESERVE_ORACLE = new PublicKey(
  import.meta.env.VITE_CSSOL_RESERVE_ORACLE ?? "3Sx8WJC7y1kokmsu7SoxfJW8nQJktkuQ5fKK8icxPw3P",
);
export const WSOL_RESERVE_ORACLE = new PublicKey(
  import.meta.env.VITE_WSOL_RESERVE_ORACLE ?? "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
);
export const ELEVATION_GROUP_LST_SOL = 2;

// Address Lookup Table that compresses the static account set used by the
// merged 1-signature deposit flow (init+ATAs+wrap+klend+elevation). Created
// once via packages/programs/scripts/init-deposit-lut.ts. Allow `null` so
// the playground gracefully falls back to the multi-tx flow if the env var
// isn't set yet.
const _depositLut = import.meta.env.VITE_DEPOSIT_LUT;
export const DEPOSIT_LUT: PublicKey | null = _depositLut ? new PublicKey(_depositLut) : null;

// csSOL-WT (withdraw ticket) addresses — populated by
// scripts/setup-cssol-wt-mint.ts and scripts/init-pool-pending-wsol.ts.
// Optional: the unwind tab disables itself if either is missing.
const _cssolWtMint = import.meta.env.VITE_CSSOL_WT_MINT;
export const CSSOL_WT_MINT: PublicKey | null = _cssolWtMint ? new PublicKey(_cssolWtMint) : null;

const _poolPendingWsol = import.meta.env.VITE_POOL_PENDING_WSOL_ACCOUNT;
export const POOL_PENDING_WSOL_ACCOUNT: PublicKey | null = _poolPendingWsol ? new PublicKey(_poolPendingWsol) : null;

// csSOL-WT klend reserve — set after running scripts/setup-cssol-wt-reserve.ts.
// Required by the leveraged-unwind flash-loan path; the v0 unwind tab still
// works without it.
const _cssolWtReserve = import.meta.env.VITE_CSSOL_WT_RESERVE ?? "FHDGQyNFHurXKPHPBBC1b3orGSuJqkdpgz9vwr9pHfQU";
export const CSSOL_WT_RESERVE: PublicKey | null = _cssolWtReserve ? new PublicKey(_cssolWtReserve) : null;
