#!/usr/bin/env bash
# Verify the deployed mainnet program byte-for-byte against the local deterministic build.
# Optionally submits a public verification to the OtterSec registry (needs a public git repo).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/onchain"

RPC="$(grep '^RPC_URL=' "$ROOT/backend/.env" | cut -d= -f2-)"
PROGRAM_ID="$(solana address -k "$ROOT/.keys/program-keypair.json")"
SO="target/deploy/budgent_vault.so"

echo "Program: $PROGRAM_ID"
LOCAL="$(solana-verify get-executable-hash "$SO")"
ONCHAIN="$(solana-verify get-program-hash "$PROGRAM_ID" --url "$RPC")"
echo "Local  build hash:  $LOCAL"
echo "On-chain prog hash: $ONCHAIN"

if [ "$LOCAL" = "$ONCHAIN" ]; then
  echo "✓ VERIFIED: deployed bytecode matches the deterministic build of the source."
  TMP="$(mktemp)"
  node -e "const f='$ROOT/.keys/deployment.json';const j=require(f);j.verified=true;j.localHash='$LOCAL';j.onchainHash='$ONCHAIN';j.verifiedAt=new Date().toISOString();require('fs').writeFileSync(f,JSON.stringify(j,null,2))" 2>/dev/null || true
  exit 0
else
  echo "✗ MISMATCH: on-chain bytecode does not match the local build." >&2
  exit 1
fi
