# Budgent Wallet (terminal)

A real, non-custodial **agent wallet in your terminal**. It reads live vault state
straight from the chain and sends **real on-chain payments** through the published
[`budgent-sdk`](https://www.npmjs.com/package/budgent-sdk) — the deployed Solana
program (`H9nJ…eV7yM`) enforces the budget on every payment. No mocks, no simulation.

```
┌─ BUDGENT WALLET  non-custodial · mainnet ───────────────┐
│ vault    46R5…FkFo   owner 5saG…YvbH   [SOL]            │
│ balance  0.257 SOL   spent today 0/0.12                 │
│ delegate EABo…GFZx ●  program H9nJ…eV7yM                │
├─ POLICY ────────────────────────────────────────────────┤
│ per-tx cap  0.05 SOL   co-sign over 0.04 SOL            │
│ daily limit 0.12 SOL   allow 3  block 1                 │
├─ LEDGER · real on-chain ────────────────────────────────┤
│ ✓ SETTLED  0.045 agent-market.sol   ↗ 5xKf…9aQ2        │
│ ✗ REVERTED 0.060 gpu.inference.io   per-tx cap         │
│ ⏸ HELD     0.045 agent-market.sol   co-sign            │
└──── pay <amt> <domain> · r refresh · q quit ────────────┘
```

## Run (read-only)

```bash
cd wallet-tui
npm install
cp .env.example .env       # vault id is prefilled
npm start
```

Read-only mode shows live balance, policy and the real on-chain ledger. To **send**,
arm it with a scoped key.

## Arming (to send real payments)

Payments are authenticated with a scoped API key (HMAC). Mint one with your **admin
token** (owner-only), then drop it into `.env`:

```bash
curl -s -X POST https://budgent.money/v1/admin/vaults/<VAULT_ID>/apikeys \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"label":"wallet-tui","scopes":["payments:create"]}'
```

It returns `{ "keyId": "bk_live_…", "hmacSecret": "…" }` **once**. Put them in `.env`:

```
BUDGENT_KEY_ID=bk_live_…
BUDGENT_HMAC_SECRET=…
```

Restart `npm start` — the footer flips to `● armed`. Revoke anytime:
`POST /v1/admin/vaults/<VAULT_ID>/apikeys/<keyId>/revoke`.

## Commands

| command | does |
|---|---|
| `pay <amount> <domain>` | send a real payment (domain resolves to a recipient) |
| `pay <amount> <pubkey>` | send to a raw recipient address |
| `r` / `refresh` | re-read chain state |
| `q` / `quit` | exit |

The owner can always withdraw the full balance — no command here can strand funds.
