# Budgent

**Budget for your agent, not keys to your wallet.**

Budgent is a non-custodial budget primitive for autonomous AI agents on Solana. Instead of
handing an agent a private key — all-or-nothing access to your funds — you hand it a **budget
enforced on-chain**: a per-transaction cap, a daily limit, a recipient allow/block list, an
instant delegate kill-switch, and an owner co-sign threshold. The agent pays autonomously
through a plain **REST API** (no x402), and every payment is tagged with the context it
happened in, so spend is grouped by where it went.

This repository is the **core**: the on-chain Anchor program and the REST + policy backend.

---

## Running on Solana mainnet — for real

This is not a devnet demo. The program is **deployed and verified on Solana mainnet-beta** and
the full payment lifecycle has been exercised end-to-end with real funds.

```
Program:        H9nJ3SKkXExHCqs56jaFsVvRajTFzTyNqjmZLWqeV7yM   (mainnet-beta)
Build:          deterministic / verifiable (solana-verify)
Verified:       on-chain bytecode hash == reproducible build of this source
                9fcf73ac592ca3aba27c4577e4465d0e8cf6a8a13059ab5babea7e0bd6181f16
Base asset:     native SOL and any SPL mint (e.g. USDC) — asset-agnostic
```

Exercised on mainnet: vault creation and funding, a delegate-signed payment that **SETTLED**,
a policy-violating payment that the **network REVERTED** (real failed transaction), a
large payment **HELD** for the owner and then **APPROVED** by co-signature, and a full
**withdrawal + close** that returned 100% of funds (balance + rent) to the owner.

---

## Two hard invariants

1. **Funds are always fully withdrawable by the owner.** `withdraw_sol` / `withdraw_spl`
   carry no policy limits; `close_vault_sol` / `close_vault_spl` drain everything (tokens +
   lamports + rent) back to the owner; `sweep_token` recovers any token held under the vault
   authority, including a foreign-mint asset mis-routed to the vault. No code path can strand
   funds.
2. **The program is verified.** It is built deterministically and the deployed bytecode hash
   is checked against the reproducible build of the source in this repository.

---

## Architecture

```
            ┌──────────────────────────────────────────────┐
  agent ───▶│  REST + Policy backend (NestJS)               │
            │   intent → policy check → execute → receipt   │
  owner ───▶│   HMAC auth · idempotency · co-sign queue     │
            │   encrypted delegate keystore · indexer       │
            └───────────────────┬──────────────────────────┘
                                │ signs delegate / owner tx
                                ▼
            ┌──────────────────────────────────────────────┐
            │  On-chain Policy Vault (Anchor, Rust)         │
            │   funds in a PDA · every rule checked in      │
            │   consensus on each transfer · emits events   │
            └──────────────────────────────────────────────┘
```

- **On-chain (Anchor):** the `budgent_vault` program holds funds in a program-derived account
  with no private key and enforces the budget on every transfer. A transfer that breaks a rule
  fails — the network reverts it. The backend cannot spend more than the program permits.
- **Backend (REST + Policy):** a single entry point for the agent and the owner. It mirrors the
  on-chain rules off-chain (for an instant rule-by-rule verdict and to decide settle / hold /
  revert), stores off-chain context, signs with the delegate or owner key, and runs the indexer
  that stitches each on-chain signature to its off-chain context via a context-hash memo + event.

### Key & fund model
- **Master authority (owner):** signs vault creation, policy changes, delegate grant/revoke,
  withdrawals, and co-sign approvals.
- **Delegate authority (agent):** a per-vault key, sealed at rest with AES-256-GCM, that may
  only move funds inside the budget. The agent never holds it — it authenticates to the REST
  API with a scoped API key; the backend signs.
- **Vault PDA:** holds funds, derived from `["vault", owner, vault_id]`.

### On-chain enforcement (every payment, in this order)
`delegate_active → recipient_check (blocklist wins, then allowlist) → per_tx_limit →
daily_window (fixed 24h) → balance → cosign_threshold`. Co-sign is a per-payment magnitude
gate; the daily limit bounds aggregate spend.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| On-chain program | Rust + Anchor 0.31 |
| Backend | NestJS (TypeScript) |
| Solana client | @solana/web3.js, @solana/spl-token, @coral-xyz/anchor |
| Database | PostgreSQL + Prisma |
| Cache / idempotency / rate limit | Redis (ioredis) |
| Indexing | Solana WebSocket logs + signature polling (Helius RPC) |
| Auth | HMAC (timestamped, replay-protected) + bearer |
| Verifiable build | solana-verify (deterministic, Docker) |

---

## API

**Agent API** — HMAC headers `X-Budgent-Key` / `X-Budgent-Timestamp` / `X-Budgent-Signature`
(or `Authorization: Bearer <secret>`):

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/payments` | create + execute a payment (push); returns the verdict + on-chain result |
| POST | `/v1/intents` | alias of the above |
| GET | `/v1/payments/:id` | fetch a payment |
| GET | `/v1/me` | the agent's budget snapshot |

**Owner / admin API** — `Authorization: Bearer <ADMIN_TOKEN>`:

```
POST/GET  /v1/admin/vaults            create / list vaults
GET       /v1/admin/vaults/:id        vault + on-chain policy/state
POST      /v1/admin/vaults/:id/policy             set per-tx / daily / co-sign
POST      /v1/admin/vaults/:id/delegate/active    delegate kill-switch
POST      /v1/admin/vaults/:id/reset-window       re-arm the daily window
POST      /v1/admin/vaults/:id/allow | /block     manage recipient lists
POST      /v1/admin/vaults/:id/deposit | /withdraw | /close
POST      /v1/admin/vaults/:id/pay                execute a payment as the vault delegate
GET       /v1/admin/vaults/:id/ledger | /contexts | /held | /export
POST      /v1/admin/payments/:id/approve | /deny  co-sign queue
POST/GET  /v1/admin/vaults/:id/resources          domain → recipient registry
POST/GET  /v1/admin/vaults/:id/apikeys            agent API keys
```

Public: `GET /health`, `GET /v1/program` (program id, instructions, verification status).

---

## Layout

```
onchain/programs/budgent_vault/src/lib.rs   the Policy Vault program
backend/src/                                NestJS app
  solana/      Anchor client + encrypted keystore
  policy/      off-chain mirror of the on-chain rules
  payments/    intent → policy → execute → receipt lifecycle
  vaults/      vault lifecycle (admin)
  resources/   domain → recipient registry
  ledger/      flat / by-context / export
  indexer/     WS logs + signature polling → context stitching
  api/         agent, admin, public controllers
backend/prisma/schema.prisma                data model
scripts/                                    build-verifiable / deploy / verify-onchain
```

---

## Run

Prerequisites: Node 20+, Rust + Anchor 0.31, Solana CLI, Docker (for the verifiable build),
PostgreSQL + Redis, a funded owner keypair at `.keys/owner.json`, and `backend/.env` (copy
`backend/.env.example`).

```bash
# database
cd backend && npm install
npx prisma generate --schema=prisma/schema.prisma
npx prisma db push --schema=prisma/schema.prisma

# build the program deterministically, deploy to mainnet, verify the on-chain hash
bash scripts/build-verifiable.sh
bash scripts/deploy.sh
bash scripts/verify-onchain.sh

# run the backend (REST + policy + indexer)
cd backend && npm run build && npm start          # :8787

# provision a vault + resources + allow/block + api key, then exercise it on mainnet
node setup-mainnet.mjs
node run-e2e.mjs idx-7F3            # settle / network-revert / held → co-sign approve
node run-e2e.mjs idx-A12 --drain   # then prove full withdrawal + close
```

---

## Security

The on-chain program is the guarantee — it does not depend on the backend's honesty.
Owner keys live only in an encrypted keystore (KMS/HSM/TEE in production); delegate keys are
sealed with AES-256-GCM; the delegate kill-switch revokes instantly; HMAC requests are
timestamped against replay; idempotency keys prevent double-submit; and every owner/agent
action is written to an immutable audit log.

## License

MIT — see [LICENSE](LICENSE).
