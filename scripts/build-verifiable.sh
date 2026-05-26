#!/usr/bin/env bash
# Deterministic, verifiable build of the Budgent Policy Vault program (in Docker).
# The resulting .so is what we deploy AND what anyone can reproduce + verify against chain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/onchain"

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker is not running. solana-verify needs Docker for a deterministic build." >&2
  exit 1
fi

# The auto-selected image for solana-program 2.3.0 ships platform-tools Rust 1.84, which
# can't compile transitive deps that now require edition2024. Use a newer verifiable-build
# image (Rust >= 1.85). The build stays deterministic + reproducible against this exact image.
SVB_IMAGE="${SVB_IMAGE:-solanafoundation/solana-verifiable-build:3.1.14}"
echo "==> Building verifiable artifact (solana-verify build, image $SVB_IMAGE)…"
solana-verify build --library-name budgent_vault --base-image "$SVB_IMAGE"

SO="target/deploy/budgent_vault.so"
echo "==> Built: $SO ($(stat -f%z "$SO") bytes)"
echo -n "==> Executable hash: "
solana-verify get-executable-hash "$SO"
