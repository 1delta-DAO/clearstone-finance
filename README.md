# Delta StableHacks

Solana monorepo using pnpm workspaces.

## Packages

| Package | Description |
|---------|-------------|
| `packages/frontend` | React + Vite app with Solana wallet adapter |
| `packages/backend` | Fastify API server with Anchor client |
| `packages/programs` | Anchor workspace — Solana programs + tests |

## Prerequisites

### 1. Node.js & pnpm

```bash
# Install Node.js 18+ (via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20
nvm use 20

# Install pnpm
npm install -g pnpm
```

### 2. Rust toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

### 3. Solana CLI

```bash
# Install solana-install
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Add to PATH (add this to your .bashrc / .zshrc)
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Verify
solana --version

# Generate a keypair (if you don't have one)
solana-keygen new
```

### 4. Anchor CLI

```bash
# Install Anchor CLI from source
cargo install --git https://github.com/coral-xyz/anchor --tag v0.30.1 anchor-cli --force

# Verify
anchor --version
```

## Getting started

```bash
# Install JS dependencies
pnpm install

# Build Solana programs
cd packages/programs
anchor build

# Run program tests (local validator)
anchor test

# Run program tests (mainnet fork via bankrun)
pnpm test:fork
```

## Testing with mainnet fork

The `packages/programs/tests/counter.fork.ts` file demonstrates how to run integration tests against a mainnet fork using `solana-bankrun`. This lets you:

- Clone real mainnet accounts (token mints, liquidity pools, etc.) into your test environment
- Run deployment sequences and full integration tests against real state
- Execute in-process with no network overhead — much faster than `solana-test-validator --clone`

To clone mainnet accounts into your fork, use the `startAnchor()` third argument or the snapshot utility pattern in the test file.

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev:frontend` | Start frontend dev server |
| `pnpm dev:backend` | Start backend dev server |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all tests |
| `pnpm test:programs` | Run program tests |
| `pnpm build:programs` | Build Solana programs |
