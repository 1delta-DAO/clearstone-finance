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
export const KLEND_MARKET = new PublicKey(
  import.meta.env.VITE_KLEND_MARKET ?? "2gRy7fYaPe8ooB1HqTfa2sJeJZ8KdVebhj88tgShyejW",
);
export const CSSOL_RESERVE = new PublicKey(
  import.meta.env.VITE_CSSOL_RESERVE ?? "Ez1axBhD6M6t1Zmzfz8MQ95Kmuc48BuoYhQEEHEhT4U1",
);
export const WSOL_RESERVE = new PublicKey(
  import.meta.env.VITE_WSOL_RESERVE ?? "4RvKrQVTdgvGEf75yvZE9JwzG4rZJrbstNcvVoXrkZ8o",
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
