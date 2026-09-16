#!/usr/bin/env bash
# Runs the on-chain settlement tests against a local Hardhat EVM.
# Isolated in hh/ (no "type: module") to avoid the app's ESM setting.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/contracts"
cp -f "$here/../contracts/CryptoFighterArena.sol" "$here/contracts/CryptoFighterArena.sol"
# Keep downloaded solc-js outside the root ESM package. If it lives beneath the
# app's package.json ("type": "module"), Hardhat 2 loads soljson as ESM and its
# CommonJS __dirname references fail before the tests start.
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-${TMPDIR:-/tmp}/crypto-fighter-hardhat-cache}"
mkdir -p "$XDG_CACHE_HOME"
export NODE_ENV=development
cd "$here"
exec ../node_modules/.bin/hardhat test "$@"
