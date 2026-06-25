# Security

Budgent is a **non-custodial** budget primitive: an on-chain Anchor program holds the
funds in a PDA and enforces the policy. This document states the guarantees, the
invariants, what is **not** yet done, and how to report an issue.

## Two rules that never bend

1. **Funds are always fully withdrawable by the owner.** No code path can strand them.
2. **The program stays verifiable** — a deterministic build whose on-chain bytecode hash
   matches the published source.

## Status

| Property | Status |
|---|---|
| Non-custodial — owner withdraw / close always available | ✅ live |
| Verified program (deterministic build, on-chain hash match) | ✅ live |
| On-chain enforcement (per-tx, daily, allow/block, co-sign, delegate kill-switch) | ✅ live |
| Scoped, revocable HMAC keys; agent never holds the wallet | ✅ live |
| **Independent external audit** | ⏳ **planned — not yet done** |

> Until an external audit is complete, treat the amounts flowing through a vault
> conservatively. The "live" rows above are properties of the deployed program and the
> non-custodial design — not a substitute for a third-party audit.

## Invariants (owner safety)

- `withdraw_sol` / `withdraw_spl` and `close_vault_*` are `has_one = owner` and (for close)
  `close = owner` — only the owner moves funds out, and close returns the rent + balance to
  the owner.
- `pay_*` moves funds **only** to a recipient the policy permits (blocklist always wins,
  non-empty allowlist must contain the recipient), bounded by per-tx, daily window, and
  available balance, with co-sign required at/above the threshold.
- The delegate is a kill-switch: `set_delegate_active(false)` (or rotating the delegate)
  halts all agent transfers immediately; the owner key is never required to be online for
  the agent to be stopped.

## Re-verify the program

The program source is in [`onchain/`](onchain/). Rebuild deterministically and compare the
hash against the on-chain program id `H9nJ3SKkXExHCqs56jaFsVvRajTFzTyNqjmZLWqeV7yM`
(deterministic build via `solanafoundation/solana-verifiable-build`). If the hash differs
from the deployed bytecode, do not trust it.

## Reporting a vulnerability

Please disclose responsibly — do not open a public issue for an exploit. Email the owner
(see the repo profile) with steps to reproduce. We will acknowledge and work a fix before
any public disclosure.
