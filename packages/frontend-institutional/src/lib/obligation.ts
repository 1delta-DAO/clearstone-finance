import { PublicKey, Connection } from "@solana/web3.js";

const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const MARKET = new PublicKey("45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98");

// All known reserve addresses
const KNOWN_RESERVES = [
  new PublicKey("3FkBgVfnYBnUre6GMQZv8w4dDM1x7Fp5RiGk96kZ5mVs"), // ceUSX
  new PublicKey("AYhwFLgzxWwqznhxv6Bg1NVnNeoDNu9SBGLzM1W3hSfb"), // sUSDC
  new PublicKey("HhTUuM5XwpnQchiUiLVNxUjPkHtfbcX4aF4bWKCSSAuT"), // dtUSDY
];

export const OB_ID = 3;

export function getObligationPda(wallet: PublicKey): PublicKey {
  const [obPda] = PublicKey.findProgramAddressSync(
    [Buffer.from([0]), Buffer.from([OB_ID]), wallet.toBuffer(), MARKET.toBuffer(),
     PublicKey.default.toBuffer(), PublicKey.default.toBuffer()],
    KLEND
  );
  return obPda;
}

/**
 * Find all reserve addresses present in an obligation's data.
 * Returns them in order (deposits first, then borrows).
 * These must be passed as remaining accounts to RefreshObligation.
 */
export function findObligationReserves(data: Buffer): PublicKey[] {
  const found: { pubkey: PublicKey; offset: number }[] = [];

  for (const reserve of KNOWN_RESERVES) {
    const buf = reserve.toBuffer();
    for (let i = 64; i < data.length - 32; i++) {
      if (data.subarray(i, i + 32).equals(buf)) {
        found.push({ pubkey: reserve, offset: i });
      }
    }
  }

  // Sort by offset (deposits come first in the obligation, then borrows)
  found.sort((a, b) => a.offset - b.offset);
  return found.map(f => f.pubkey);
}
