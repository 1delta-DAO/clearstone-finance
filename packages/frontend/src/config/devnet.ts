import { PublicKey } from "@solana/web3.js";

/**
 * Devnet deployment addresses.
 * Updated by the deployment pipeline (pnpm deploy:all:devnet).
 */
export const DEVNET_CONFIG = {
  cluster: "devnet" as const,
  rpc: "https://api.devnet.solana.com",

  // Programs
  programs: {
    deltaMint: new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn"),
    governor: new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh"),
    klend: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
  },

  // Governor pool
  pool: {
    poolConfig: new PublicKey("5dkknYzVfeVdwNSxR1gUXTz2mKoXEtFhZ8jnDCduFRpb"),
    wrappedMint: new PublicKey("ALqRkS5GdVYWUFLzsL3xbKCxkoMxe2p23UUP9Waddwfx"),
    underlyingMint: new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"),
    dmMintConfig: new PublicKey("C8XZRejf1vaLRpLWqCZSjegzyAFFdfpBZKXFhs7kSDLs"),
    dmMintAuthority: new PublicKey("DWat3MjbT3HmHjwutDKqN9ooSNtVyFVgfTm3gs7drYS2"),
  },

  // Oracles
  oracles: {
    usdyPythV2: new PublicKey("E4pitSrZV9MWSspahe2vr26Cwsn3podnvHvW3cuT74R4"),
  },
};

export type DeploymentConfig = typeof DEVNET_CONFIG;
