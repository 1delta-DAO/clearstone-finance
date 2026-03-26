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

  // Lending market
  market: {
    lendingMarket: new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98"),
    usdcReserve: new PublicKey("7fYbqqcWnUvz3ffH6knnRRoRhDYaK4MgHH8Cj1Uwii4j"),
    usdcOracle: new PublicKey("CRhtYFcS32PBbRBrP31JafW15DpPpydZPKMnbkyuiD7W"),
    dUsdyReserve: new PublicKey("HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw"),
    dUsdyOracle: new PublicKey("EZxvCYEjyogA2R1Eppz1AWyxhgjZWs4nXQRk3RC2yRLt"),
  },
};

export type DeploymentConfig = typeof DEVNET_CONFIG;
