/**
 * Unit tests for the hand-rolled account-offset decoders in
 * src/fixed-yield.ts.
 *
 * These are the mission-critical bits — if the offsets drift vs. the
 * clearstone_core state layout, the indexer will silently return garbage
 * maturity dates and PT prices and the retail UI will quote nonsense APYs.
 *
 * Run:  pnpm --filter backend-edge run test
 *
 * Test strategy: hand-build a byte buffer matching the documented
 * layout, write known sentinel values at the target offsets (and
 * adversarial patterns everywhere else so we catch off-by-one),
 * and assert the decoders return exactly the sentinels.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeVaultMaturity, decodeMarketPtPrice, VAULT_START_TS_OFFSET, VAULT_DURATION_OFFSET, MARKET_PT_BALANCE_OFFSET, MARKET_SY_BALANCE_OFFSET, } from "../src/fixed-yield.js";
// ---------------------------------------------------------------------------
// Helpers — build adversarially-patterned buffers so any off-by-one in
// the decoder reads obviously-wrong values instead of accidentally
// valid ones.
// ---------------------------------------------------------------------------
function patternedBuf(size) {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++)
        buf[i] = (i * 31 + 7) & 0xff;
    return buf;
}
function writeU32LE(buf, off, n) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    v.setUint32(off, n, true);
}
function writeU64LE(buf, off, n) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    v.setBigUint64(off, n, true);
}
// ---------------------------------------------------------------------------
// decodeVaultMaturity
// ---------------------------------------------------------------------------
test("decodeVaultMaturity: reads start_ts + duration from documented offsets", () => {
    // Vault layout prefix is 331 + 4 + 4 = 339 bytes up through duration.
    const buf = patternedBuf(512);
    const startTs = 1_700_000_000; // 2023-11-14
    const duration = 90 * 24 * 60 * 60; // 90 days
    writeU32LE(buf, VAULT_START_TS_OFFSET, startTs);
    writeU32LE(buf, VAULT_DURATION_OFFSET, duration);
    const maturity = decodeVaultMaturity(buf);
    assert.equal(maturity, startTs + duration);
});
test("decodeVaultMaturity: pattern bytes elsewhere don't bleed in", () => {
    // If VAULT_START_TS_OFFSET were off by one, we'd pick up the pattern
    // byte next door instead of our sentinel. This test catches that.
    const buf = patternedBuf(512);
    const startTs = 1_600_000_000;
    const duration = 365 * 24 * 60 * 60;
    writeU32LE(buf, VAULT_START_TS_OFFSET, startTs);
    writeU32LE(buf, VAULT_DURATION_OFFSET, duration);
    // Poison the bytes adjacent to the fields with a distinctive value.
    buf[VAULT_START_TS_OFFSET - 1] = 0xcc;
    buf[VAULT_DURATION_OFFSET + 4] = 0xdd;
    assert.equal(decodeVaultMaturity(buf), startTs + duration);
});
test("decodeVaultMaturity: zero fields yield zero maturity", () => {
    const buf = patternedBuf(512);
    writeU32LE(buf, VAULT_START_TS_OFFSET, 0);
    writeU32LE(buf, VAULT_DURATION_OFFSET, 0);
    assert.equal(decodeVaultMaturity(buf), 0);
});
test("decodeVaultMaturity: max u32 values don't overflow (number-safe range)", () => {
    const buf = patternedBuf(512);
    const startTs = 0xffff_ffff;
    const duration = 0xffff_ffff;
    writeU32LE(buf, VAULT_START_TS_OFFSET, startTs);
    writeU32LE(buf, VAULT_DURATION_OFFSET, duration);
    // JS numbers are safe up to 2^53 — two u32s summed is ~8.6e9, well under.
    assert.equal(decodeVaultMaturity(buf), startTs + duration);
});
test("decodeVaultMaturity: throws on undersized buffer", () => {
    const tooSmall = new Uint8Array(VAULT_DURATION_OFFSET + 3); // one byte short
    assert.throws(() => decodeVaultMaturity(tooSmall), /too small/);
});
test("decodeVaultMaturity: accepts buffer exactly large enough", () => {
    const minSize = VAULT_DURATION_OFFSET + 4;
    const buf = new Uint8Array(minSize);
    writeU32LE(buf, VAULT_START_TS_OFFSET, 42);
    writeU32LE(buf, VAULT_DURATION_OFFSET, 100);
    assert.equal(decodeVaultMaturity(buf), 142);
});
// ---------------------------------------------------------------------------
// decodeMarketPtPrice
// ---------------------------------------------------------------------------
test("decodeMarketPtPrice: reads pt_balance + sy_balance from documented offsets", () => {
    const buf = patternedBuf(600);
    const pt = 1000000000n; // 1000 PT at 6 decimals
    const sy = 976500000n; // 976.5 SY → PT discounted
    writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, pt);
    writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, sy);
    const price = decodeMarketPtPrice(buf);
    // SY / PT = 0.9765 within float precision.
    assert.ok(Math.abs(price - 0.9765) < 1e-9, `price=${price}`);
});
test("decodeMarketPtPrice: zero PT reserve → 0 (no divide-by-zero)", () => {
    const buf = patternedBuf(600);
    writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, 0n);
    writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, 1000000n);
    assert.equal(decodeMarketPtPrice(buf), 0);
});
test("decodeMarketPtPrice: adjacent bytes don't bleed", () => {
    const buf = patternedBuf(600);
    const pt = 500000000n;
    const sy = 487000000n;
    writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, pt);
    writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, sy);
    // Poison the bytes around the two fields.
    buf[MARKET_PT_BALANCE_OFFSET - 1] = 0xaa;
    buf[MARKET_PT_BALANCE_OFFSET + 8] = 0xbb; // between pt & sy is 0 bytes, so this is SY_BALANCE[0]
    buf[MARKET_SY_BALANCE_OFFSET + 8] = 0xcc;
    // The poison between pt & sy IS the first byte of sy_balance — the
    // fields are adjacent. So overwrite poison with the real SY after.
    writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, sy);
    assert.ok(Math.abs(decodeMarketPtPrice(buf) - 487 / 500) < 1e-9);
});
test("decodeMarketPtPrice: typical near-maturity price (close to 1.0)", () => {
    const buf = patternedBuf(600);
    const pt = 1000000000000n;
    const sy = 998200000000n; // 5d pre-maturity, ~0.9982
    writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, pt);
    writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, sy);
    const price = decodeMarketPtPrice(buf);
    assert.ok(price > 0.99 && price < 1.0, `expected ~0.998, got ${price}`);
});
test("decodeMarketPtPrice: throws on undersized buffer", () => {
    const tooSmall = new Uint8Array(MARKET_SY_BALANCE_OFFSET + 7);
    assert.throws(() => decodeMarketPtPrice(tooSmall), /too small/);
});
test("decodeMarketPtPrice: accepts buffer exactly large enough", () => {
    const minSize = MARKET_SY_BALANCE_OFFSET + 8;
    const buf = new Uint8Array(minSize);
    writeU64LE(buf, MARKET_PT_BALANCE_OFFSET, 100n);
    writeU64LE(buf, MARKET_SY_BALANCE_OFFSET, 97n);
    assert.equal(decodeMarketPtPrice(buf), 0.97);
});
// ---------------------------------------------------------------------------
// Offset-drift guard — if someone edits the layout and forgets to bump
// the offsets, this test gives a single spot to re-assert.
// ---------------------------------------------------------------------------
test("offset constants match source-documented layout", () => {
    // Vault: 8 + 32 + 2 + 1 + 32*8 + 32 = 331, then u32 u32.
    assert.equal(VAULT_START_TS_OFFSET, 331);
    assert.equal(VAULT_DURATION_OFFSET, 335);
    // MarketTwo: 8 + 32 + 2 + 1 + 32 + 32*7 + 2 + 32 + 1 + 1 + 32 = 365
    // financials.expiration_ts (u64) @ 365, pt_balance @ 373, sy_balance @ 381.
    assert.equal(MARKET_PT_BALANCE_OFFSET, 373);
    assert.equal(MARKET_SY_BALANCE_OFFSET, 381);
});
//# sourceMappingURL=fixed-yield-decoders.test.js.map