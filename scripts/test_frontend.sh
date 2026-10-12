#!/usr/bin/env bash
# Requires current forge artifacts and npm ci in frontend and in server (the chat client is
# tested against the server's own verifier). No wallet/network writes.
set -euo pipefail
cd "$(dirname "$0")/../frontend"
[ -d ../server/node_modules ] || { echo "run npm ci in server/ first" >&2; exit 1; }
node scripts/export-abi.mjs --check
npm run format:check
npm run build
# The built page must carry the Content-Security-Policy of these settings, first in its head.
node --experimental-strip-types scripts/check-policy.mjs
npm test
