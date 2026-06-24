# Budgent Desktop

A non-custodial **agent wallet as a desktop app** (Electron). Same engine as the CLI —
live on-chain vault state + **real payments** through the published
[`budgent-sdk`](https://www.npmjs.com/package/budgent-sdk), enforced by the deployed
program (`H9nJ…eV7yM`). No mocks. The HMAC secret stays in the main process; the UI
never touches it.

## Run

```bash
cd desktop
npm install
npm start
```

It opens read-only against the demo vault (live balance, policy, ledger). To **send**,
click ⚙ Settings and paste your `keyId` + `hmacSecret` (mint a scoped key as in the
[CLI README](../cli/README.md)), or drop a `desktop/.env`:

```
BUDGENT_BASE_URL=https://budgent.money
BUDGENT_VAULT_ID=<your vault>
BUDGENT_KEY_ID=bk_live_…
BUDGENT_HMAC_SECRET=<64-hex>
```

## What you can do

- See balance, policy (per-tx / daily / co-sign / allow-block), delegate status
- Send a payment by domain or recipient pubkey → watch the on-chain verdict
  (SETTLED / REVERTED / HELD) with a Solscan link
- Browse the real on-chain ledger

The owner can always withdraw; nothing here can strand funds.
