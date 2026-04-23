/**
 * Wrapper instruction discriminators for clearstone_router.
 *
 * Each is the first 8 bytes of `sha256("global:<snake_case_name>")`, the
 * Anchor convention. Duplicated here (rather than read from IDL at
 * runtime) so the SDK has no runtime IDL dependency.
 */

export const ROUTER_DISC = {
  wrapperStrip: Buffer.from([0x3b, 0x57, 0x57, 0xa0, 0x8d, 0x70, 0xc6, 0x84]),
  wrapperMerge: Buffer.from([0xb1, 0x24, 0xab, 0x7d, 0x59, 0xc6, 0x90, 0xdb]),
  wrapperBuyPt: Buffer.from([0x06, 0x7f, 0x06, 0x88, 0xe2, 0xc2, 0xfa, 0xa8]),
  wrapperSellPt: Buffer.from([0x7f, 0x41, 0x6c, 0x0c, 0x48, 0x15, 0x32, 0xc8]),
  wrapperBuyYt: Buffer.from([0x5e, 0x44, 0x10, 0x5b, 0x15, 0xa8, 0xde, 0x69]),
  wrapperSellYt: Buffer.from([0x92, 0xfd, 0x65, 0x71, 0x62, 0x5e, 0xc1, 0x95]),
  wrapperCollectInterest: Buffer.from([
    0x31, 0xe1, 0xae, 0x59, 0xb9, 0x75, 0x21, 0x44,
  ]),
  wrapperProvideLiquidity: Buffer.from([
    0x8f, 0x8d, 0x25, 0x87, 0xda, 0x88, 0x52, 0x8f,
  ]),
  wrapperProvideLiquidityClassic: Buffer.from([
    0x28, 0x5f, 0x7f, 0x03, 0xee, 0xa6, 0x0c, 0xa0,
  ]),
  wrapperProvideLiquidityBase: Buffer.from([
    0x1b, 0xe2, 0x2b, 0x5c, 0xfd, 0x0a, 0x9a, 0xa0,
  ]),
  wrapperWithdrawLiquidity: Buffer.from([
    0xef, 0xcb, 0x34, 0x4b, 0x27, 0x16, 0x46, 0xd1,
  ]),
  wrapperWithdrawLiquidityClassic: Buffer.from([
    0x06, 0x8b, 0xb6, 0xc8, 0x60, 0xc8, 0x6a, 0x02,
  ]),
} as const;

/**
 * NOTE: these bytes are computed on first generation and may drift if
 * instruction names change in the router. Regenerate with:
 *
 *   node -e 'const c=require("crypto"); for (const n of
 *     ["wrapper_strip","wrapper_merge","wrapper_buy_pt","wrapper_sell_pt",
 *      "wrapper_buy_yt","wrapper_sell_yt","wrapper_collect_interest",
 *      "wrapper_provide_liquidity","wrapper_provide_liquidity_classic",
 *      "wrapper_provide_liquidity_base","wrapper_withdraw_liquidity",
 *      "wrapper_withdraw_liquidity_classic"])
 *     console.log(n, [...c.createHash("sha256")
 *       .update("global:"+n).digest().subarray(0,8)]
 *       .map(b=>"0x"+b.toString(16).padStart(2,"0")).join(","));'
 */
