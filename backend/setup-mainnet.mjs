// Provision a real mainnet vault through the Budgent admin API:
//   - creates a SOL vault (delegate generated + funded for fees)
//   - generates recipient "vendor" wallets (secrets saved so funds are recoverable)
//   - registers the domain→recipient resources
//   - sets the on-chain allowlist / blocklist
//   - deposits SOL into the vault
//   - issues an agent API key
//   - writes mainnet.json (vault id, api key, demo tasks) for run-e2e.mjs
//
// Amounts are scaled to ~1/1000 of typical values so a full real run risks only ~0.2 SOL,
// all of which is recoverable (vault is withdrawable; vendor keypairs are saved).
import { Keypair } from '@solana/web3.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(resolve(__dir, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
  }),
);
const BASE = process.env.BASE_URL || 'http://localhost:8787';
const ADMIN = env.ADMIN_TOKEN;
const KEYS = env.KEYSTORE_DIR || resolve(__dir, '.keys');
if (!existsSync(KEYS)) mkdirSync(KEYS, { recursive: true });

async function admin(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const S = 0.001; // scale
const VENDORS = [
  { domain: 'api.weather.ai', label: 'forecast pull · 30d', url: 'https://api.weather.ai/v3/forecast', list: 'allow' },
  { domain: 'gpu.inference.io', label: 'GPU inference', url: 'https://gpu.inference.io/v2', list: 'allow' },
  { domain: 'agent-market.sol', label: 'agent marketplace', url: 'https://agent-market.sol', list: 'allow' },
  { domain: 'scraper.unknown-domain.xyz', label: 'raw scrape · 5k pages', url: 'https://scraper.unknown-domain.xyz/scrape', list: 'block' },
  { domain: 'newvendor.ai', label: 'tool call · unverified', url: 'https://newvendor.ai/tool', list: 'none' },
];

const TASKS = {
  'idx-7F3': { label: 'Buy a dataset', intents: [
    { domain: 'api.weather.ai', resource: 'forecast pull · 30d', url: 'https://api.weather.ai/v3/forecast', amount: 8 * S },
    { domain: 'gpu.inference.io', resource: 'batch embedding · 1M tokens', url: 'https://gpu.inference.io/v2/embed', amount: 18 * S },
    { domain: 'agent-market.sol', resource: 'labeled dataset · tier 2', url: 'https://agent-market.sol/dataset/77', amount: 22 * S },
    { domain: 'scraper.unknown-domain.xyz', resource: 'raw scrape · 5k pages', url: 'https://scraper.unknown-domain.xyz/scrape', amount: 12 * S },
    { domain: 'agent-market.sol', resource: 'premium dataset · tier 4', url: 'https://agent-market.sol/premium', amount: 45 * S },
  ] },
  'idx-A12': { label: 'Rent GPU inference', intents: [
    { domain: 'gpu.inference.io', resource: 'spot GPU · 1h', url: 'https://gpu.inference.io/spot', amount: 30 * S },
    { domain: 'gpu.inference.io', resource: 'A100 reserved · 1h', url: 'https://gpu.inference.io/a100', amount: 60 * S },
    { domain: 'gpu.inference.io', resource: 'spot GPU · 1h', url: 'https://gpu.inference.io/spot', amount: 35 * S },
    { domain: 'gpu.inference.io', resource: 'burst cluster · 30m', url: 'https://gpu.inference.io/burst', amount: 38 * S },
    { domain: 'gpu.inference.io', resource: 'burst cluster · 1h', url: 'https://gpu.inference.io/burst', amount: 40 * S },
  ] },
  'idx-C90': { label: 'Pay sub-agents', intents: [
    { domain: 'agent-market.sol', resource: 'sub-agent fee · researcher', url: 'https://agent-market.sol/agent/14/fee', amount: 9 * S },
    { domain: 'agent-market.sol', resource: 'sub-agent fee · writer', url: 'https://agent-market.sol/agent/22/fee', amount: 9 * S },
    { domain: 'newvendor.ai', resource: 'tool call · unverified', url: 'https://newvendor.ai/tool', amount: 15 * S },
    { domain: 'agent-market.sol', resource: 'bounty payout · task', url: 'https://agent-market.sol/bounty/3', amount: 45 * S },
  ] },
};

async function main() {
  console.log('==> Creating SOL vault on mainnet…');
  const vault = await admin('POST', '/v1/admin/vaults', {
    label: 'demo-agent', asset: 'SOL', perTx: 50 * S, daily: 120 * S, cosign: 40 * S, fundDelegateSol: 0.03,
  });
  console.log(`    vault ${vault.id}  PDA ${vault.vaultPda}  delegate ${vault.delegate}`);

  const recipients = {};
  for (const v of VENDORS) {
    const kp = Keypair.generate();
    recipients[v.domain] = { pubkey: kp.publicKey.toBase58(), secret: Array.from(kp.secretKey) };
    v.recipient = kp.publicKey.toBase58();
  }
  writeFileSync(resolve(KEYS, 'recipients.json'), JSON.stringify(recipients, null, 2), { mode: 0o600 });
  console.log('    saved vendor keypairs → .keys/recipients.json');

  console.log('==> Registering resources (domain → recipient)…');
  for (const v of VENDORS) await admin('POST', `/v1/admin/vaults/${vault.id}/resources`, { domain: v.domain, recipient: v.recipient, label: v.label, url: v.url });

  console.log('==> Setting on-chain allowlist / blocklist…');
  for (const v of VENDORS.filter((x) => x.list === 'allow')) await admin('POST', `/v1/admin/vaults/${vault.id}/allow`, { address: v.recipient });
  for (const v of VENDORS.filter((x) => x.list === 'block')) await admin('POST', `/v1/admin/vaults/${vault.id}/block`, { address: v.recipient });

  console.log('==> Depositing 0.2 SOL into the vault…');
  const funded = await admin('POST', `/v1/admin/vaults/${vault.id}/deposit`, { amount: 0.2 });
  console.log(`    vault balance: ${funded.state.balance} SOL`);

  console.log('==> Issuing agent API key…');
  const key = await admin('POST', `/v1/admin/vaults/${vault.id}/apikeys`, { label: 'demo-agent' });

  writeFileSync(resolve(__dir, 'mainnet.json'), JSON.stringify({
    baseUrl: BASE, vaultId: vault.id, vaultPda: vault.vaultPda, asset: 'SOL',
    apiKey: { keyId: key.keyId, hmacSecret: key.hmacSecret }, tasks: TASKS,
  }, null, 2), { mode: 0o600 });
  console.log('    wrote mainnet.json');

  console.log(`\n✓ Mainnet setup complete.\n  Vault:  ${vault.vaultPda}\n  Agent:  ${key.keyId}`);
}
main().catch((e) => { console.error('SETUP FAILED:', e.message); process.exit(1); });
