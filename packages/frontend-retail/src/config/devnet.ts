import { PublicKey } from "@solana/web3.js";

export const DEVNET_CONFIG = {
  cluster: "devnet" as const,
  rpc: "https://api.devnet.solana.com",

  programs: {
    deltaMint: new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn"),
    governor: new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh"),
    klend: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
    mockOracle: new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm"),
  },

  pool: {
    poolConfig: new PublicKey("5dkknYzVfeVdwNSxR1gUXTz2mKoXEtFhZ8jnDCduFRpb"),
    wrappedMint: new PublicKey("ALqRkS5GdVYWUFLzsL3xbKCxkoMxe2p23UUP9Waddwfx"),
    underlyingMint: new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"),
    dmMintConfig: new PublicKey("C8XZRejf1vaLRpLWqCZSjegzyAFFdfpBZKXFhs7kSDLs"),
    dmMintAuthority: new PublicKey("DWat3MjbT3HmHjwutDKqN9ooSNtVyFVgfTm3gs7drYS2"),
  },

  // Solstice devnet tokens (use these for USDC/USDT — NOT Circle mints)
  solstice: {
    usdt: new PublicKey("5dXXpWyZCCPhBHxmp79Du81t7t9oh7HacUW864ARFyft"),
    usdc: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
    usx: new PublicKey("7QC4zjrKA6XygpXPQCKSS9BmAsEFDJR6awiHSdgLcDvS"),
    eusx: new PublicKey("Gkt9h4QWpPBDtbaF5HvYKCc87H5WCRTUtMf77HdTGHBt"),
    api: "https://instructions.solstice.finance/v1/instructions",
    apiKey: "SET_VIA_ENV_VAR",
  },

  // USDC on devnet — use Solstice USDC for the lending market
  usdc: {
    mint: new PublicKey("8iBux2LRja1PhVZph8Rw4Hi45pgkaufNEiaZma5nTD5g"),
    decimals: 6,
  },

  // Civic gatekeeper network
  civic: {
    gatekeeperNetwork: new PublicKey("ignREusXmGrscGNUesoU9mxfds9AiYTezUKex2PsZV6"),
  },

  // Lending market (updated per IRM_NOTES.md)
  market: {
    lendingMarket: new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98"),
    usdcReserve: new PublicKey("AYhwFLgzxWwqznhxv6Bg1NVnNeoDNu9SBGLzM1W3hSfb"),    // sUSDC (stable curve)
    usdcOracle: new PublicKey("EN2FsFZFdpiFAWpKDZqeJ2PY8EyE7xzz9Ew8ZQVhtHCJ"),
    dUsdyReserve: new PublicKey("HhTUuM5XwpnQchiUiLVNxUjPkHtfbcX4aF4bWKCSSAuT"), // dtUSDY
    dUsdyOracle: new PublicKey("4Xv1RpZQHZNHatTba3xUW4foLYUM6x36NxehihVcUnPQ"),
    deusxReserve: new PublicKey("3FkBgVfnYBnUre6GMQZv8w4dDM1x7Fp5RiGk96kZ5mVs"), // ceUSX
    deusxOracle: new PublicKey("6dbNQrjLVQxk1bJhbB6AiMFWzaf8G2d3LPjH69Je498A"),
  },
};

export type DeploymentConfig = typeof DEVNET_CONFIG;
