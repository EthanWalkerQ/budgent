#!/usr/bin/env bash
# Deploy the verifiable Budgent program to Solana MAINNET via Helius, owner = upgrade authority.
# Spends REAL SOL. Run build-verifiable.sh first.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/onchain"

RPC="$(grep '^RPC_URL=' "$ROOT/backend/.env" | cut -d= -f2-)"
OWNER="$ROOT/.keys/owner.json"
PROGRAM_KP="$ROOT/.keys/program-keypair.json"
SO="target/deploy/budgent_vault.so"

[ -f "$SO" ] || { echo "ERROR: $SO not found — run scripts/build-verifiable.sh" >&2; exit 1; }
PROGRAM_ID="$(solana address -k "$PROGRAM_KP")"
SIZE="$(stat -f%z "$SO")"
BAL="$(solana balance -k "$OWNER" -u "$RPC" | awk '{print $1}')"

echo "Program:        $PROGRAM_ID"
echo "Artifact size:  $SIZE bytes"
echo "Owner balance:  $BAL SOL"
echo "RPC:            ${RPC%%\?*}?api-key=***"
echo
echo "==> Deploying to mainnet (this spends real SOL)…"

if ! solana program deploy "$SO" \
  --program-id "$PROGRAM_KP" \
  --keypair "$OWNER" \
  --upgrade-authority "$OWNER" \
  --url "$RPC" \
  --max-sign-attempts 200 \
  --use-rpc; then
  echo
  echo "!! Deploy did not complete. Recovering any orphaned buffer rent back to the owner…"
  solana program close --buffers --keypair "$OWNER" --authority "$OWNER" --url "$RPC" 2>/dev/null || true
  echo "Owner balance after recovery: $(solana balance -k "$OWNER" -u "$RPC")"
  echo "If this was an out-of-funds failure, top up the owner and re-run scripts/deploy.sh."
  exit 1
fi

EXEC_HASH="$(solana-verify get-executable-hash "$SO")"
cat > "$ROOT/.keys/deployment.json" <<EOF
{
  "programId": "$PROGRAM_ID",
  "cluster": "mainnet-beta",
  "artifactSize": $SIZE,
  "executableHash": "$EXEC_HASH",
  "upgradeAuthority": "$(solana address -k "$OWNER")",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "verified": false,
  "explorer": "https://solscan.io/account/$PROGRAM_ID"
}
EOF
echo
echo "==> Deployed. Wrote .keys/deployment.json. Next: scripts/verify-onchain.sh"
