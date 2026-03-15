# Delta — KYC-Gated Lending on Solana

Regulated lending pools built on permissionless infrastructure. Compliance at the token layer, lending via audited protocols.

## What This Is

A **KYC-wrapped USDY** token (dUSDY) that can be used as collateral in **Kamino Lend V2** permissionless markets — enabling institutional-grade, regulated lending without building custom lending infrastructure.

```
┌───────────────────────────────────────────────────────────────┐
│                                                               │
│   KYC Provider ──▶ delta-mint program ──▶ Kamino Lend V2     │
│   (off-chain)      (on-chain gate)        (audited infra)    │
│                                                               │
│   1. User passes KYC                                          │
│   2. Authority whitelists wallet on-chain                     │
│   3. User receives dUSDY (1:1 wrapped USDY)                  │
│   4. User deposits dUSDY as collateral into Kamino market     │
│   5. User borrows USDC against it                             │
│                                                               │
│   Only KYC'd users can hold the token = only they can lend   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

Same model as **Aave Horizon** — compliance at the asset layer, not the protocol layer.

## Architecture

| Layer | What | Who Builds It |
|-------|------|---------------|
| **Token** | Token-2022 mint with confidential transfer extension, PDA-controlled mint authority, KYC whitelist | Us (delta-mint program) |
| **Lending** | Permissionless market, reserves, liquidation engine, interest rate curves | Kamino Lend V2 (audited) |
| **Oracle** | USDY/USD price feed (Pyth) — we reuse the underlying asset's feed | Pyth Network |

## Project Structure

```
packages/
├── programs/                         # Solana programs (Anchor 0.30.1)
│   ├── programs/
│   │   ├── counter/                  # Example program
│   │   └── delta-mint/               # KYC-gated token program
│   │       ├── src/lib.rs            # Program source
│   │       ├── Cargo.toml
│   │       └── README.md             # Full program docs
│   ├── tests/
│   │   ├── delta-mint.ts             # Unit tests (local validator)
│   │   └── delta-mint.fork.ts        # Fork tests (mainnet state)
│   └── configs/
│       ├── delta_usdy_reserve.json   # Kamino reserve config for dUSDY (collateral)
│       └── usdc_borrow_reserve.json  # Kamino reserve config for USDC (borrow)
├── frontend/                         # React + Vite (Solana wallet adapter)
└── backend/                          # Fastify API server
```

## delta-mint Program

**Program ID:** `3FLEACtqQ2G9h6sc7gLniVfK4maG59Eo4pt8H4A9QggY`

### Instructions

| Instruction | Description |
|---|---|
| `initialize_mint(decimals)` | Creates a Token-2022 mint with confidential transfer extension. Mint authority = program PDA. |
| `add_to_whitelist()` | Authority approves a wallet for KYC. Creates a WhitelistEntry PDA. |
| `remove_from_whitelist()` | Revokes KYC. Closes PDA, returns rent. |
| `mint_to(amount)` | Mints tokens to a whitelisted recipient. Rejects if not whitelisted. |

### Privacy

The mint is created with the **ConfidentialTransferMint** extension (Token-2022). This enables:
- ElGamal-encrypted balances — on-chain observers can't see amounts
- Auto-approve enabled — token holders can configure confidential transfers immediately
- Auditor key slot available for compliance auditing

## Kamino Lend V2 Integration

### How to Deploy a KYC-Gated Lending Market

```bash
# 1. Install the SDK
npm install @kamino-finance/klend-sdk

# 2. Create a new market
yarn kamino-manager create-market --mode execute

# 3. Add dUSDY as collateral (Token-2022 program!)
yarn kamino-manager add-asset-to-market \
  --market <MARKET_ADDRESS> \
  --mint <DUSDY_MINT_ADDRESS> \
  --mint-program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --reserve-config ./configs/delta_usdy_reserve.json \
  --mode execute

# 4. Add USDC as borrow asset
yarn kamino-manager add-asset-to-market \
  --market <MARKET_ADDRESS> \
  --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --mint-program-id TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA \
  --reserve-config ./configs/usdc_borrow_reserve.json \
  --mode execute
```

### Reserve Configurations

**dUSDY Collateral** ([delta_usdy_reserve.json](packages/programs/configs/delta_usdy_reserve.json)):
| Parameter | Value | Rationale |
|---|---|---|
| LTV | 75% | Conservative for yield-bearing stablecoin |
| Liquidation Threshold | 82% | 7% buffer |
| Liquidation Bonus | 2–5% | Dynamic auction model |
| Oracle | Pyth USDY/USD | Reuse underlying feed |
| Borrow Limit | 0 | Collateral only — not borrowable |

**USDC Borrow** ([usdc_borrow_reserve.json](packages/programs/configs/usdc_borrow_reserve.json)):
| Parameter | Value | Rationale |
|---|---|---|
| LTV | 0% | Borrow-only — not usable as collateral in this market |
| Borrow Rate Curve | 0.01%→4%→80% | Kink at 70% utilization |
| Borrow Limit | 75B lamports | ~$75K initial cap |
| Oracle | Pyth USDC/USD | Standard stablecoin feed |

### Key Addresses

| Asset | Address |
|---|---|
| USDY (Ondo, Solana) | `A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6` |
| USDC (Solana) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Kamino Lend V2 (mainnet) | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` |
| Kamino Lend V2 (staging) | `SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh` |
| Pyth USDY/USD feed | `e393449f...10e7326` |
| Pyth USDC/USD feed | `eaa020c6...9e9c94a` |

## Open Items & Answers

### 1. Confidential Transfers + Kamino

Token-2022 is supported by the klend SDK via `--mint-program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. The confidential transfer extension lives on the token account, not the reserve — Kamino interacts with the standard (public) balance for deposits/borrows. Confidential transfers happen between users separately. **No blocker expected.**

### 2. Liquidation Flow

Kamino uses a **soft liquidation** model with dynamic penalties (2–10% depending on speed). Liquidation config is fully per-reserve via the JSON config:
- `minLiquidationBonusBps` / `maxLiquidationBonusBps` — we set 200–500 bps
- `protocolLiquidationFeePct` — protocol's cut (10%)
- `autodeleverageEnabled` — backstop if no liquidator acts
- `deleveragingMarginCallPeriodSecs` — 7 day grace period

**Liquidator KYC concern:** liquidators receive dUSDY collateral. Solutions:
- **(a)** Whitelist liquidator bots, OR
- **(b)** Add a transfer hook exempting liquidation flows, OR
- **(c)** Use Kamino's auto-deleverage (`autodeleverageEnabled: 1`) — no collateral transfer to third party

Option (c) is available out-of-box and enabled in our config.

### 3. Oracle

We use the **existing Pyth USDY/USD feed** (`e393449f6aff8a4b6d3e1165a7c9ebec103685f3b41e60db4277b5b6d10e7326`) since dUSDY is a 1:1 wrapped USDY. No custom oracle needed.

### 4. Staging Verification

Full E2E testing with a confidential-transfer-enabled mint as collateral should be verified on Kamino staging (`SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh`) before mainnet deployment.

## Test Coverage

```
  delta-mint (mainnet fork)
    ✔ creates a Token-2022 mint with confidential transfer extension
    ✔ whitelists a user (KYC approval)
    ✔ mints 10,000 KYC-wrapped USDY (dUSDY) to the whitelisted user
    ✔ confirms Kamino klend program is loaded on fork
    ✔ reads the Kamino main market account from fork
    ✔ verifies USDY and USDC mints are available on fork
    ✔ blocks minting to a non-whitelisted wallet
    ✔ removes a user from the whitelist

  delta-mint (unit)
    ✔ initializes the mint with confidential transfer extension
    ✔ adds a wallet to the KYC whitelist
    ✔ mints tokens to a whitelisted recipient
    ✔ rejects minting to a non-whitelisted wallet
    ✔ removes a wallet from the whitelist

  17 passing
```

## Prerequisites

### 1. Node.js & pnpm

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20 && nvm use 20
npm install -g pnpm
```

### 2. Rust + Solana + Anchor

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --force
```

## Running

```bash
pnpm install
cd packages/programs

# Build
anchor build

# Test (local)
anchor test

# Test (mainnet fork — clones Kamino + USDY + USDC state)
ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com anchor test
```

## Further Reading

- [Delta Mint Program README](packages/programs/programs/delta-mint/README.md) — full instruction/account/event/error reference
- [Kamino Integration Plan](KAMINO_INTEGRATION.md) — detailed step-by-step integration research
