/**
 * setup-cssol-wt-reserve.ts — Add csSOL-WT as a third reserve on the
 * existing csSOL/wSOL klend market and register it in elevation group 2.
 *
 * STATUS: stub. The implementation mirrors setup-cssol-market.ts's
 * reserve-init + update-config + register-in-elevation-group sequence
 * but runs against an *existing* market rather than creating a fresh
 * one. Splitting that script's body into reusable steps would let this
 * one be ~150 LOC. Skipped for the v1 push because klend reserve setup
 * historically needed several rounds of devnet iteration to chase
 * GLOBAL_ADMIN_ONLY_MODES guards (modes 3, 23, etc.) and elevation-group
 * registration ordering — best done with a live cluster + read access
 * to klend logs, not blind.
 *
 * To implement when picking this up:
 *
 *   1. Pre-mint a tiny seed of csSOL-WT to the deployer's ATA (needs
 *      delta_mint::add_to_whitelist + mint_to). Same pattern as the
 *      csSOL seed in deploy-cssol-governor-devnet.ts.
 *
 *   2. Call klend::init_reserve with:
 *        liquidityMint   = csSOL_WT mint
 *        seedDepositSrc  = deployer's csSOL-WT ATA
 *        market          = existing market from cssol-deployed.json
 *      (Same accounts struct as step 4 in setup-cssol-market.ts.)
 *
 *   3. Apply update_reserve_config × N in PHASE 1 (basic params from
 *      delta_csSOL_WT_reserve.json minus elevation_groups + minus
 *      borrowLimitAgainstThisCollateralInElevationGroup). Skip mode 3
 *      (UpdateProtocolLiquidationFee) — it's in GLOBAL_ADMIN_ONLY_MODES
 *      and rejects non-Kamino-admin signers.
 *
 *   4. Phase 1.5: elevation group 2 should already be registered on
 *      the market by setup-cssol-market.ts. If not, register it now
 *      with collateralReserve=csSOL, debtReserve=wSOL, max_reserves=3
 *      (was 2 before; bump to include csSOL-WT).
 *
 *   5. Phase 2: apply update_reserve_config for elevation_groups[0]=2
 *      (mode 24) and borrowLimitAgainstThisCollateralInElevationGroup
 *      (mode 25 maybe — verify by reading the SDK).
 *
 *   6. Persist to configs/devnet/cssol-wt-deployed.json:
 *        { market, cssolWtReserve, cssolWtCollMint, cssolWtCollSupply,
 *          cssolWtLiqSupply }
 *
 * Tip: re-run after each on-chain failure with logs surfaced via
 * `solana confirm <sig> --output json | jq .meta.logMessages` —
 * klend errors are usually clear about which mode tripped a guard.
 */

import { Connection } from "@solana/web3.js";

async function main() {
  console.error(
    "setup-cssol-wt-reserve.ts is a stub — see header for implementation steps. " +
    "This script intentionally exits without changes; write the body first against " +
    "a live devnet cluster following the setup-cssol-market.ts template.",
  );
  void new Connection;
  process.exit(2);
}

main();
