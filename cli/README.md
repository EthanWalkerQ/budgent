# Budgent CLI

Self-serve, **non-custodial** command-line wallet that drives the deployed Budgent
Solana program (`H9nJ3SKkXExHCqs56jaFsVvRajTFzTyNqjmZLWqeV7yM`) **directly with your
own keypair** — no backend, no custody. You create the vault, fund it, set the policy,
and hand a *delegate* (the agent) a budget — **not your keys**. Every payment is
enforced on-chain, and you can always withdraw the full balance.

## Install

```bash
cd cli
npm install
```

You bring your own Solana wallet — the standard `~/.config/solana/id.json` is used by
default (override with `--keypair <path>` or `BUDGENT_KEYPAIR`). Fund it with a little
mainnet SOL (vault rent + your deposit + fees).

```bash
export BUDGENT_RPC="https://your-rpc"   # optional; defaults to public mainnet-beta
```

## The flow

```bash
# 1) create YOUR vault (owner = your wallet). Sets policy + generates the agent delegate.
node budgent.mjs init --per-tx 0.05 --daily 0.12 --cosign 0.04

# 2) fund the vault
node budgent.mjs fund 0.2

# 3) decide who the agent may pay
node budgent.mjs allow <recipient_pubkey>
node budgent.mjs block <recipient_pubkey>

# 4) the agent pays — the PROGRAM decides (settle / revert / co-sign)
node budgent.mjs pay 0.01 <recipient_pubkey>

# 5) inspect anytime
node budgent.mjs status

# 6) you always control the funds
node budgent.mjs withdraw 0.05
node budgent.mjs close          # returns the entire balance to the owner
```

## What the program enforces (why a `pay` reverts)

The delegate signs payments; the program checks, in order, and reverts otherwise:

| guard | revert |
|---|---|
| delegate active & correct | `DelegateRevoked` / `BadDelegate` (6000/6001) |
| recipient not blocklisted | `RecipientBlocked` (6002) |
| recipient on allowlist (if any) | `NotOnAllowlist` (6003) |
| amount ≤ per-tx cap | `OverPerTx` (6004) |
| window spend + amount ≤ daily | `OverDaily` (6005) |
| vault holds the funds | `InsufficientFunds` (6006) |
| amount ≥ co-sign threshold ⇒ owner must sign | `CosignRequired` (6007) |

A payment at/above the co-sign threshold reverts unless the owner co-signs:

```bash
node budgent.mjs pay 0.045 <recipient> --cosign   # owner co-signs → settles
```

## Notes

- **Non-custodial:** the program only ever moves funds to the owner on `withdraw`/`close`,
  or to a recipient the policy permits. No path can strand your funds.
- The generated delegate keypair lives in `cli/.budgent/` (gitignored) and is funded a
  small fee reserve at `init` so the agent can pay its own transaction fees.
- SOL vaults only. Mainnet.
