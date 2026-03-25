import { PublicKey } from "@solana/web3.js";

/**
 * Devnet deployment addresses.
 * Updated by the deployment pipeline (pnpm deploy:all:devnet).
 */
export interface WrappedToken {
  name: string;
  symbol: string;
  decimals: number;
  price: number;
  underlyingMint: PublicKey;
  wrappedMint: PublicKey;
  pool: PublicKey;
  dmMintConfig: PublicKey;
  oracle: PublicKey;
}

export const DEVNET_CONFIG = {
  cluster: "devnet" as const,
  rpc: "https://api.devnet.solana.com",

  // Programs
  programs: {
    deltaMint: new PublicKey("13Su8nR5NBzQ7UwFFUiNAH1zH5DQtLyjezhbwRREQkEn"),
    governor: new PublicKey("BrZYcbPBt9nW4b6xUSodwXRfAfRNZTCzthp1ywMG3KJh"),
    klend: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
    mockOracle: new PublicKey("7qABPpPwvS7u7Y5vgDKZdSqLnc6N9FasVnG2iv7qe4vm"),
  },

  // Original governor pool (legacy — uses real USDY which we can't mint)
  pool: {
    poolConfig: new PublicKey("5dkknYzVfeVdwNSxR1gUXTz2mKoXEtFhZ8jnDCduFRpb"),
    wrappedMint: new PublicKey("ALqRkS5GdVYWUFLzsL3xbKCxkoMxe2p23UUP9Waddwfx"),
    underlyingMint: new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"),
    dmMintConfig: new PublicKey("C8XZRejf1vaLRpLWqCZSjegzyAFFdfpBZKXFhs7kSDLs"),
    dmMintAuthority: new PublicKey("DWat3MjbT3HmHjwutDKqN9ooSNtVyFVgfTm3gs7drYS2"),
  },

  // Wrapped tokens (KYC-gated d-tokens with controllable underlying mints)
  tokens: [
    {
      name: "USDY Token",
      symbol: "tUSDY",
      decimals: 6,
      price: 1.08,
      underlyingMint: new PublicKey("F1SbMAUJUTsKwr7gp6tEuwGvxtqsBpoCcnk819vpsqia"),
      wrappedMint: new PublicKey("6SV8ecHhfgWYHTiec2uDMPXHUXqqT2puNjR73gj6AvYu"),
      pool: new PublicKey("7LyKDm9fq49ExBVWYEnjpxh13Z7jD8MJZXztY8uCrFY2"),
      dmMintConfig: new PublicKey("9mFCzbnAUSM5fUgCbkvbSoKiXizpRePhWcCQr7RpyQMo"),
      oracle: new PublicKey("F8o4m2VCo1JoVTjgADNs1Shuhx5SvVT8Mrb5w5WSTykt"),
    },
    {
      name: "EUR Token",
      symbol: "tEUR",
      decimals: 6,
      price: 1.12,
      underlyingMint: new PublicKey("33ryBf82bn78vTxDBNkGrmCyABWL12CUMYrfSZ6yGq7Y"),
      wrappedMint: new PublicKey("9cub1oL1w7985h3L9rd2FKGVeUeawvjVRtrHwcHhw5YC"),
      pool: new PublicKey("21jHsskrLrEdqey9Q5KoB2cNSc6ygdmi9dFcyXX3UfkR"),
      dmMintConfig: new PublicKey("FkAhz5EQsQGe5XWu2ys9kXx48ZADgNf53B33tkXV5uRa"),
      oracle: new PublicKey("GTnFY3z4Mpa3yKm9t7uRv873Z9Goa4FvK8Fq3fWywotS"),
    },
    {
      name: "Gold Token",
      symbol: "tGOLD",
      decimals: 8,
      price: 2400,
      underlyingMint: new PublicKey("HfjzJvuu9jiGYnjtjVEMQ6hbbepp1LW6Rfi5HTnCxrW1"),
      wrappedMint: new PublicKey("5H4beLqk7axM73SCzXAfWjeTGTPmHUnfLhVMC4ZQUQhG"),
      pool: new PublicKey("64fC8ZTjrEuLimkgzQsgtF7ZwDPkDZAZXNjzkhzDNHdU"),
      dmMintConfig: new PublicKey("93Ep7aetCtCBtSnBBtSudSPMJU4w9FjsdRG3xN9xYpcy"),
      oracle: new PublicKey("5MPet5McLhp5UspmGDnrYtkjuP4QjysWVDyrsFXHStYy"),
    },
  ] as WrappedToken[],

  // Oracles (PriceUpdateV2 format — accepted by klend via discriminator check)
  oracles: {
    dUsdyOracle: new PublicKey("EZxvCYEjyogA2R1Eppz1AWyxhgjZWs4nXQRk3RC2yRLt"),
    usdcOracle: new PublicKey("CRhtYFcS32PBbRBrP31JafW15DpPpydZPKMnbkyuiD7W"),
  },

  // Lending market (klend)
  market: {
    lendingMarket: new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98"),
    klendGlobalConfig: new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W"),
    dUsdyReserve: new PublicKey("HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw"),
    usdcReserve: new PublicKey("7fYbqqcWnUvz3ffH6knnRRoRhDYaK4MgHH8Cj1Uwii4j"),
    usdcMint: new PublicKey("6qcmJLYuJbBQscq1aB5XW9md6oUkkaoKx8XsEW5TaAgp"),
  },
};

export type DeploymentConfig = typeof DEVNET_CONFIG;
