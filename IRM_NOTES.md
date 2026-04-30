# Interest Rate Model (IRM) — Dev Notes

## Current State

The governor program has a `set_borrow_rate_curve` instruction that validates a
curve and CPIs into klend's `updateReserveConfig`. **However, the klend program
deployed on devnet (`KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`) rejects all
post-init config updates** — including borrow rate curves, deposit limits, and
even token names. The validation at `handler_update_reserve_config.rs:49` fires
`InvalidConfig (6004)` for every update attempt regardless of content, signer, or
skip_validation flag.

This means the borrow rate curve can **only** be set during the initial reserve
configuration sequence (right after `init_reserve`).

## How to Change the IRM

Since runtime updates are blocked, the only way to change a reserve's rate curve
is to create a new reserve with the desired curve baked in at setup time:

```bash
cd packages/programs

# Use a preset (stable, moderate, steep)
npx tsx scripts/replace-reserve-irm.ts --reserve sUSDC --curve stable

# Use a custom curve (auto-padded to 11 points with last value)
npx tsx scripts/replace-reserve-irm.ts --reserve sUSDC --curve '[[0,0],[8000,300],[10000,2000]]'
```

This creates a fresh reserve (~0.15 SOL, ~30s). The old reserve is stranded —
any existing deposits/borrows on it are orphaned. After running, update the
reserve addresses in `packages/frontend-*/src/config/devnet.ts`.

## Active Reserves (as of 2026-03-27)

| Reserve | Address | Curve | Role |
|---------|---------|-------|------|
| dtUSDY | `HhTUuM5XwpnQchiUiLVNxUjPkHtfbcX4aF4bWKCSSAuT` | 0→5%→50% (3-point) | Collateral (75% LTV) |
| sUSDC | `AYhwFLgzxWwqznhxv6Bg1NVnNeoDNu9SBGLzM1W3hSfb` | 0→0.5%→...→20% (stable) | Borrow |

Oracles:
- dtUSDY: `4Xv1RpZQHZNHatTba3xUW4foLYUM6x36NxehihVcUnPQ` ($1.08)
- sUSDC: `EN2FsFZFdpiFAWpKDZqeJ2PY8EyE7xzz9Ew8ZQVhtHCJ` ($1.00)

Market: `45FNL648aXgbMoMzLfYE2vCZAtWWDCky2tYLCEUztc98`

## Stranded Reserves (do not use)

These were created during earlier setup but klend locked their config:

- `HoEa26bHi96mwAu3joQZKcyxhG9jXyJvaxLNuvjcwZmw` — old cUSDY
- `7fYbqqcWnUvz3ffH6knnRRoRhDYaK4MgHH8Cj1Uwii4j` — old USDC
- `GwcTF1uxH7SCmRjo5dGb121daRaDXod3tJcY8CPofgtf` — old Solstice USDC
- `HCQrPVyfPxqzTLwmEBb1Fo91JcNeCb6gsCT5B9PRxBhV` — intermediate sUSDC (replaced)

## klend Curve Constraints

When setting a curve during reserve init, klend enforces:

1. **First point**: utilization = 0, rate = 0
2. **Strictly increasing** — no flat segments (both util and rate must increase at every point)
3. **11 points** — pad trailing points by repeating the last `(10000, max_rate)` value
4. **Max rate**: varies by deployment, ~5000 bps (50%) on this devnet instance

## Governor IRM Instruction

The `set_borrow_rate_curve` instruction exists in the governor program but is
effectively unusable until klend allows runtime config updates. The instruction:

- Validates curve monotonicity, bounds, and structure
- CPIs into klend `updateReserveConfig` with mode 23
- Supports authority + admin delegation
- Emits `BorrowRateCurveUpdated` event

The on-chain code is ready — it just needs a klend version that doesn't block
post-init updates. If you fork klend, remove the validation at
`handler_update_reserve_config.rs:49`.

## Console UI

The **Rate Curves** tab in the console (`pnpm dev:console`) is a read-only
display that shows the on-chain borrow rate curve for any reserve. It reads the
11-point curve from offset 4920 in the reserve account data.
