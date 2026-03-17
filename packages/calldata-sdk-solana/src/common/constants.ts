import { PublicKey } from "@solana/web3.js";

// Program IDs
export const DELTA_MINT_PROGRAM_ID = new PublicKey("3FLEACtqQ2G9h6sc7gLniVfK4maG59Eo4pt8H4A9QggY");
export const GOVERNOR_PROGRAM_ID = new PublicKey("2TaDoLXG6HzXpFJngMvNt9tY29Zovah77HvJZvqW96sr");
export const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

// Well-known mints
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const USDY_MINT = new PublicKey("A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6");

// Pyth oracle feeds
export const PYTH_USDY_PRICE = new PublicKey("BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb");
export const PYTH_USDC_PRICE = new PublicKey("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD");

// klend global config PDA
export const KLEND_GLOBAL_CONFIG = new PublicKey("BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W");

// Anchor discriminators (first 8 bytes of sha256("global:<ix_name>"))
export const DISC = {
  // delta-mint
  initializeMint: Buffer.from([0x5a, 0x5d, 0xaf, 0xf5, 0xf6, 0x61, 0x7c, 0x7b]),
  addToWhitelist: Buffer.from([0xba, 0x47, 0x06, 0xef, 0x78, 0xf6, 0x4c, 0x53]),
  mintTokens: Buffer.from([0x43, 0x18, 0x88, 0x5d, 0x2a, 0x5e, 0x32, 0x14]),
  // klend
  initLendingMarket: Buffer.from([0xaf, 0x08, 0x5f, 0x1f, 0x8d, 0x39, 0x53, 0xfe]),
  initReserve: Buffer.from([0x5a, 0xa0, 0xb0, 0x08, 0xf7, 0x14, 0xdb, 0xdb]),
  updateReserveConfig: Buffer.from([0x3d, 0x94, 0x64, 0x46, 0x8f, 0x6b, 0x11, 0x0d]),
  initObligation: Buffer.from([0xfc, 0xbb, 0x5b, 0xf1, 0xa1, 0xf8, 0x9c, 0x12]),
  initUserMetadata: Buffer.from([0xfb, 0xdd, 0x31, 0x1e, 0x37, 0x2b, 0x82, 0xb5]),
  refreshReserve: Buffer.from([0x02, 0xda, 0x8a, 0x96, 0xa3, 0x16, 0x8b, 0x23]),
  depositReserveLiquidity: Buffer.from([0x64, 0x9f, 0x61, 0x68, 0xfe, 0x02, 0xd2, 0x51]),
  borrowObligationLiquidity: Buffer.from([0xe9, 0x52, 0x34, 0xb3, 0x87, 0x2f, 0xc7, 0x2e]),
  repayObligationLiquidity: Buffer.from([0x05, 0x2c, 0xb0, 0x43, 0xde, 0x53, 0x7d, 0x69]),
  withdrawObligationCollateral: Buffer.from([0x12, 0x0a, 0xa3, 0x0e, 0xb4, 0x0a, 0x00, 0xd6]),
} as const;

// UpdateConfigMode variant discriminators (u32 LE Borsh enum)
export const CONFIG_MODE = {
  UpdateLoanToValuePct: 0,
  UpdateLiquidationThresholdPct: 2,
  UpdateDepositLimit: 8,
  UpdateBorrowLimit: 9,
  UpdatePythPrice: 20,
} as const;
