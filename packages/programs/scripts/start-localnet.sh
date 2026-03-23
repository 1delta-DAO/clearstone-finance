#!/bin/bash
# Start a local validator with cloned mainnet Pyth oracle + klend program
# This gives us real oracle data that actually works.
#
# Usage: bash scripts/start-localnet.sh

set -e

SOLANA=~/.local/share/solana/install/active_release/bin/solana-test-validator

# Pyth USDC/USD mainnet oracle
PYTH_USDC="Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD"
# Pyth SOL/USD mainnet oracle (backup)
PYTH_SOL="H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"
# Pyth v2 program
PYTH_V2="FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH"

echo "Starting local validator with cloned mainnet oracles..."
echo "  Pyth USDC/USD: $PYTH_USDC"
echo "  Pyth program:  $PYTH_V2"

$SOLANA \
  --url mainnet-beta \
  --clone "$PYTH_USDC" \
  --clone "$PYTH_SOL" \
  --clone "$PYTH_V2" \
  --reset \
  "$@"
