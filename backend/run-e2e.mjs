// End-to-end REAL mainnet exercise of a configured vault.
//   node run-e2e.mjs [taskKey]            run one task (default idx-7F3), approve a held payment
//   node run-e2e.mjs all                  run every configured task
//   node run-e2e.mjs <taskKey> --drain    then withdraw 100% + close the vault (proves invariant #1)
//
// Every "pay" hits the real admin API → the on-chain program. SETTLED/REVERTED rows carry
// real mainnet signatures; reverts are genuine failed transactions enforced by the network.
// Reads mainnet.json written by setup-mainnet.mjs.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(resolve(__dir, '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const cfg = JSON.parse(readFileSync(resolve(__dir, 'mainnet.json'), 'utf8'));
const BASE = process.env.BASE_URL || cfg.baseUrl || 'http://localhost:8787';
const ADMIN = env.ADMIN_TOKEN;
const VAULT = cfg.vaultId;

const args = process.argv.slice(2);
const drain = args.includes('--drain');
const taskArg = args.find((a) => !a.startsWith('--')) || 'idx-7F3';

async function admin(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const ICON = { SETTLED: '✓', APPROVED: '✓', REVERTED: '✗', HELD: '⏸', DENIED: '✗', FAILED: '!' };
const f = (n) => `${n} ${cfg.asset}`;

async function runTask(key) {
  const task = cfg.tasks[key];
  if (!task) throw new Error(`unknown task ${key}`);
  console.log(`\n=== Task ${key} — ${task.label} ===`);
  console.log('   resetting daily window…');
  await admin('POST', `/v1/admin/vaults/${VAULT}/reset-window`);
  let i = 0;
  for (const intent of task.intents) {
    const r = await admin('POST', `/v1/admin/vaults/${VAULT}/pay`, {
      amount: intent.amount, domain: intent.domain, url: intent.url, resource: intent.resource,
      taskId: key, idempotencyKey: `${key}-${i}-${Date.now()}`,
    });
    console.log(`   ${ICON[r.status] || '?'} ${r.status.padEnd(9)} ${String(intent.amount).padStart(8)} ${cfg.asset}  ${intent.domain.padEnd(28)} ${r.reason || ''}`);
    if (r.signature) console.log(`        sig ${r.signature}`);
    i++;
  }
}

async function main() {
  const v0 = await admin('GET', `/v1/admin/vaults/${VAULT}`);
  console.log(`Vault ${v0.vaultPda}  balance ${f(v0.state.balance)}  policy: per-tx ${v0.policy.perTx} · daily ${v0.policy.daily} · co-sign ≥${v0.policy.cosign}`);

  if (taskArg === 'all') for (const k of Object.keys(cfg.tasks)) await runTask(k);
  else await runTask(taskArg);

  const held = await admin('GET', `/v1/admin/vaults/${VAULT}/held`);
  if (held.length) {
    console.log(`\n=== Co-sign: approving held payment ${held[0].id} (${f(held[0].amount)} ${held[0].context.domain}) ===`);
    const a = await admin('POST', `/v1/admin/payments/${held[0].id}/approve`);
    console.log(`   ${ICON[a.status] || '?'} ${a.status}  ${a.reason}`);
    if (a.signature) console.log(`        sig ${a.signature}`);
  }

  console.log('\n=== Ledger by context ===');
  for (const c of await admin('GET', `/v1/admin/vaults/${VAULT}/contexts`)) {
    console.log(`   ${String(c.total).padStart(8)} ${cfg.asset}  ${c.domain.padEnd(28)} ${c.count} tx · top: ${c.topResource}`);
  }

  const v1 = await admin('GET', `/v1/admin/vaults/${VAULT}`);
  console.log(`\nVault balance now: ${f(v1.state.balance)}  · total paid ${f(v1.state.totalPaid)} · ${v1.state.paymentCount} payments`);

  if (drain) {
    console.log('\n=== Proving invariant #1: full withdrawal + close ===');
    const w = await admin('POST', `/v1/admin/vaults/${VAULT}/withdraw`, { amount: 'all' });
    console.log(`   withdrew all spendable → balance ${f(w.state.balance)}`);
    const c = await admin('POST', `/v1/admin/vaults/${VAULT}/close`);
    console.log(`   vault closed (rent + remainder returned to owner). sig ${c.signature}`);
  }
}
main().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
