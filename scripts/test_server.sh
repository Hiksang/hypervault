#!/usr/bin/env bash
# Requires npm ci in server. Stub chain, fake nodes on loopback and in-memory SQLite only:
# no real RPC, wallet or funds.
set -euo pipefail
cd "$(dirname "$0")/../server"
npm run format:check
npm run typecheck
npm test
