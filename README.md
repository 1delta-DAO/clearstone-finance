# Delta — KYC-Gated Lending on Solana

Regulated lending pools built on permissionless infrastructure. Compliance at the token layer, lending via audited protocols.

## What This Is

A **KYC-wrapped USDY** token (dUSDY) that can be used as collateral in **Kamino Lend V2** permissionless markets — enabling institutional-grade, regulated lending without building custom lending infrastructure.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│   KYC Provider ──▶ Governor ──▶ delta-mint ──▶ Kamino V2     │
│   (off-chain)      (orchestrator) (on-chain)   (audited)     │
│                                                               │
│   1. Operator creates pool via governor (one tx)              │
│   2. User passes KYC → authority whitelists wallet            │
│   3. User receives dUSDY (1:1 wrapped USDY, Token-2022)      │
│   4. User deposits dUSDY as collateral into Kamino market     │
│   5. User borrows USDC against it (95% LTV)                  │
│                                                               │
│   Only KYC'd wallets can hold the token = only they can lend │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

Same model as **Aave Horizon** — compliance at the asset layer, not the protocol layer.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Governor Program                                                     │
│ (orchestrator — single entry point)                                  │
│                                                                      │
│  initialize_pool(params) ──CPI──▶ delta-mint.initialize_mint()      │
│  add_participant(role)   ──CPI──▶ delta-mint.add_to_whitelist()     │
│  mint_wrapped(amount)    ──CPI──▶ delta-mint.mint_to()              │
│  register_lending_market()       (stores klend addresses)            │
│  set_pool_status()               (freeze / unfreeze)                 │
├─────────────────────────────────────────────────────────────────────┤
│ Delta-Mint Program                                                   │
│ (KYC whitelist + Token-2022 mint with confidential transfers)        │
│                                                                      │
│  Roles: Holder (KYC'd, can mint+hold) | Liquidator (receive-only)   │
├─────────────────────────────────────────────────────────────────────┤
│ Kamino Lend V2 (external, audited)                                   │
│ (permissionless markets, reserves, liquidation, interest rates)      │
├─────────────────────────────────────────────────────────────────────┤
│ Pyth Oracle (external)                                               │
│ USDY/USD: BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb            │
│ USDC/USD: Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD            │
└─────────────────────────────────────────────────────────────────────┘
```

| Layer | What | Who Builds It |
|-------|------|---------------|
| **Orchestration** | Pool lifecycle, whitelist management, status control | Us (governor program) |
| **Token** | Token-2022 mint with confidential transfer ext, PDA mint authority, KYC whitelist with roles | Us (delta-mint program) |
| **Lending** | Permissionless market, reserves, liquidation engine, interest rate curves | Kamino Lend V2 (audited) |
| **Oracle** | USDY/USD + USDC/USD price feeds — reuse underlying asset feeds | Pyth Network |

## Project Structure

```
packages/
├── programs/                         # Solana programs (Anchor 0.30.1)
│   ├── programs/
│   │   ├── delta-mint/               # KYC-gated token program
│   │   └── governor/                 # Pool orchestration program
│   ├── tests/
│   │   ├── delta-mint.ts             # Unit tests (local validator)
│   │   ├── delta-mint.fork.ts        # Fork tests (mainnet state)
│   │   ├── kamino-market.fork.ts     # Market creation + PDA verification
│   │   ├── governor.fork.ts          # Governor-orchestrated flow
│   │   └── kamino-full-flow.fork.ts  # E2E: mint → deposit → borrow
│   └── configs/
│       ├── delta_usdy_reserve.json   # Kamino reserve config (dUSDY collateral)
│       └── usdc_borrow_reserve.json  # Kamino reserve config (USDC borrow)
├── frontend/                         # React + Vite (Solana wallet adapter)
└── backend/                          # Fastify API server
```

## Programs

### delta-mint

**Program ID:** `3FLEACtqQ2G9h6sc7gLniVfK4maG59Eo4pt8H4A9QggY`

| Instruction | Description |
|---|---|
| `initialize_mint(decimals)` | Creates Token-2022 mint with confidential transfer extension. Mint authority = program PDA. |
| `add_to_whitelist()` | Authority approves a wallet (Holder role). Creates WhitelistEntry PDA. |
| `add_liquidator()` | Authority approves a liquidator bot (Liquidator role — receive-only, cannot mint). |
| `remove_from_whitelist()` | Revokes approval. Closes PDA, returns rent. |
| `mint_to(amount)` | Mints tokens to a whitelisted Holder. Rejects Liquidators and non-whitelisted wallets. |

### governor

**Program ID:** `2TaDoLXG6HzXpFJngMvNt9tY29Zovah77HvJZvqW96sr`

| Instruction | Description |
|---|---|
| `initialize_pool(params)` | Creates PoolConfig + wrapped Token-2022 mint via CPI to delta-mint. Minimal params: oracles, LTV, decimals. |
| `register_lending_market(market, col, borrow)` | Stores klend addresses after off-chain creation. Activates the pool. |
| `add_participant(role)` | Unified whitelist — CPI to delta-mint (Holder or Liquidator). |
| `mint_wrapped(amount)` | Mint to whitelisted Holder via CPI. Only works when pool is Active. |
| `set_pool_status(status)` | Freeze/unfreeze (Initializing → Active → Frozen). |

## Full Lending Flow (Proven in Fork Tests)

```
Step 1: Create KYC-gated token
  governor.initializePool({
    underlying: USDY, oracle: Pyth_USDY,
    borrow: USDC,     borrowOracle: Pyth_USDC,
    decimals: 6, ltv: 95, liquidation: 97
  })
  → Creates dUSDY Token-2022 mint + PoolConfig PDA

Step 2: Configure Kamino market (off-chain SDK)
  → initLendingMarket (quoteCurrency: USD)
  → initReserve (dUSDY collateral, Token-2022)
  → initReserve (USDC borrow, SPL Token)
  → updateReserveConfig × N (LTV=95%, oracle, limits)

Step 3: governor.registerLendingMarket(market, reserves)
  → Pool transitions to Active

Step 4: KYC + Deposit
  governor.addParticipant({ holder: {} })  → whitelist user
  governor.mintWrapped(1000_000_000)       → 1000 dUSDY
  klend.depositAndCollateral(500_000_000)  → 500 dUSDY collateral

Step 5: Borrow
  klend.refreshReserve (dUSDY + USDC oracles)
  klend.refreshObligation
  klend.borrowObligationLiquidity(400_000_000)  → 400 USDC borrowed

Result: 500 dUSDY collateral → 400 USDC borrowed (80% of 95% LTV)
```

## Reserve Configurations

**dUSDY Collateral** ([delta_usdy_reserve.json](packages/programs/configs/delta_usdy_reserve.json)):
| Parameter | Value | Rationale |
|---|---|---|
| LTV | 95% (configurable) | High LTV for stablecoin-backed collateral |
| Liquidation Threshold | 97% | Tight buffer — stablecoin peg assumption |
| Liquidation Bonus | 2–5% | Dynamic auction model |
| Oracle | Pyth USDY/USD (`BkN8...`) | Reuse underlying feed |
| Borrow Limit | 0 | Collateral only — not borrowable |

**USDC Borrow** ([usdc_borrow_reserve.json](packages/programs/configs/usdc_borrow_reserve.json)):
| Parameter | Value | Rationale |
|---|---|---|
| LTV | 0% | Borrow-only |
| Borrow Rate Curve | 0.01%→4%→80% | Kink at 70% utilization |
| Borrow Limit | 75K USDC | Initial cap |
| Oracle | Pyth USDC/USD (`Gnt27...`) | Standard stablecoin feed |

## Key Addresses

| Asset | Address |
|---|---|
| USDY (Ondo, Solana) | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` |
| USDC (Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Kamino Lend V2 | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` |
| Pyth USDY/USD feed | `BkN8hYgRjhyH18aBsuzvMSyMTBRkDrGs1PTgMbBFpnLb` |
| Pyth USDC/USD feed | `Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD` |

## Privacy

The dUSDY mint uses **Token-2022 ConfidentialTransferMint** extension:
- ElGamal-encrypted balances — on-chain observers can't see amounts
- Auto-approve enabled — holders configure confidential transfers immediately
- Auditor key slot available for compliance
- Kamino uses standard (public) balances for deposits/borrows — no conflict

## Liquidation (Whitelisted Approach)

| Path | Mechanism |
|---|---|
| **Primary** | Pre-approved liquidator bots (`add_liquidator`) — vetted operators that can receive dUSDY collateral |
| **Backstop** | Kamino auto-deleverage (`autodeleverageEnabled: 1`) — 7-day margin call, no third-party collateral transfer |
| **Future** | Token-2022 transfer hook for permissionless KYC-gated liquidation |

Liquidator role: can receive dUSDY during liquidations, **cannot mint** new tokens.

## Test Coverage

```
  kamino-full-flow (mainnet fork)          ← E2E proof of concept
    ✔ creates dUSDY mint, whitelists operator, mints 1000 dUSDY
    ✔ creates klend market with dUSDY + USDC reserves
    ✔ configures dUSDY reserve: 95% LTV, Pyth oracle, deposit limit
    ✔ configures USDC reserve: oracle, borrow limit
    ✔ creates user obligation and deposits 500 dUSDY collateral
    ✔ borrows 400 USDC against dUSDY collateral
    ✔ verifies the complete KYC-gated lending position

  governor-pool-creation (mainnet fork)    ← Governor orchestration
    ✔ initializes a KYC-gated lending pool via governor
    ✔ whitelists the operator as a Holder via governor
    ✔ mints 100 dUSDY to operator via governor
    ✔ whitelists a liquidator bot via governor
    ✔ rejects minting to a liquidator via governor

  kamino-market-creation (mainnet fork)    ← Market + reserve setup
    ✔ creates dUSDY Token-2022 mint with confidential transfer extension
    ✔ whitelists the market operator
    ✔ mints 100 dUSDY to the operator for reserve seeding
    ✔ whitelists a liquidator bot via add_liquidator
    ✔ rejects minting to a liquidator-role wallet
    ✔ creates a new Kamino Lend V2 lending market
    ✔ initializes dUSDY collateral reserve
    ✔ initializes USDC borrow reserve
    ✔ verifies klend PDA derivations and instruction layout
    ✔ validates dUSDY collateral config from JSON
    ✔ validates USDC borrow config from JSON

  delta-mint (unit)
    ✔ initializes the mint with confidential transfer extension
    ✔ adds a wallet to the KYC whitelist
    ✔ mints tokens to a whitelisted recipient
    ✔ rejects minting to a non-whitelisted wallet
    ✔ removes a wallet from the whitelist
```

## Running

```bash
pnpm install

# Build all programs
pnpm -r build

# Unit tests (local validator)
cd packages/programs && pnpm test

# Fork tests (mainnet state — Kamino + oracles + USDY/USDC)
cd packages/programs && pnpm test:fork

# Run specific fork test
ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
  npx ts-mocha -p ./tsconfig.json -t 1000000 tests/kamino-full-flow.fork.ts
```

## Prerequisites

```bash
# Node.js + pnpm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20 && nvm use 20
npm install -g pnpm

# Rust + Solana + Anchor
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --force
```

## Further Reading

- [Kamino Integration Plan](KAMINO_INTEGRATION.md) — detailed research on market creation, reserve config, liquidation
