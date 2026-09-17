#!/usr/bin/env bash
# Runs the on-chain settlement tests against a local Hardhat EVM.
# Isolated in hh/ (no "type: module") to avoid the app's ESM setting.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/contracts"
cp -f "$here/../contracts/CryptoFighterArena.sol" "$here/contracts/CryptoFighterArena.sol"
# Keep all harness-owned configuration and cache inside the repository.
export XDG_CACHE_HOME="$here/../.cache/hardhat/cache"
export XDG_CONFIG_HOME="$here/../.cache/hardhat/config"
export XDG_DATA_HOME="$here/../.cache/hardhat/data"
mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
export NODE_ENV=development
cd "$here"
exec ../node_modules/.bin/hardhat test "$@"
