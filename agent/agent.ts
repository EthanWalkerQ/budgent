/**
 * Budgent autonomous agent.
 *
 * A real AI agent that is handed a BUDGET, not keys. It reads its on-chain budget, asks an
 * LLM (via OpenRouter) to plan purchases for a task from a resource catalog, then pays for
 * each through the Budgent REST API. The on-chain program enforces every rule — some
 * payments settle, some are reverted by the network, some are held for the owner's co-sign.
 *
 * Run:  OPENROUTER_API_KEY=... node --experimental-strip-types agent.ts [./agent.config.json]
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

interface Catalog { domain: string; resource: string; url?: string; price: number; note?: string }
interface Cfg {
  baseUrl: string;
  keyId: string;
  hmacSecret: string;
  openrouterApiKey?: string;
  model?: string;
  task: string;
  catalog: Catalog[];
}

const cfgPath = process.argv[2] || new URL('./agent.config.json', import.meta.url).pathname;
const cfg: Cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const OR_KEY = process.env.OPENROUTER_API_KEY || cfg.openrouterApiKey;
const MODEL = process.env.OPENROUTER_MODEL || cfg.model || 'anthropic/claude-sonnet-4.5';

// --- minimal Budgent REST client with HMAC ---
function headers(method: string, path: string, body: string) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', cfg.hmacSecret).update(`${ts}.${method}.${path}.${body}`).digest('hex');
  return { 'Content-Type': 'application/json', 'X-Budgent-Key': cfg.keyId, 'X-Budgent-Timestamp': ts, 'X-Budgent-Signature': sig };
}
async function api(method: string, path: string, payload?: any) {
  const body = payload != null ? JSON.stringify(payload) : '';
  const res = await fetch(cfg.baseUrl + path, { method, headers: headers(method, path, body), body: method === 'GET' ? undefined : body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${(json as any).message || ''}`);
  return json as any;
}

// --- LLM planning via OpenRouter ---
async function planWithLLM(budget: any): Promise<{ domain: string; amount: number; reason: string }[]> {
  const sys =
    'You are an autonomous AI agent that pays for resources from a budget enforced on-chain. ' +
    'You CANNOT exceed the budget — the chain reverts anything that breaks a rule, so be deliberate. ' +
    'Return ONLY compact JSON: {"purchases":[{"domain":string,"amount":number,"reason":string}]}.';
  const user = JSON.stringify({
    task: cfg.task,
    asset: budget.asset,
    budget: budget.policy,
    balance: budget.state?.balance,
    catalog: cfg.catalog,
    guidance:
      'Plan the purchases needed for the task. Prefer settling within per-tx and daily limits. ' +
      'You may legitimately need a large item that lands at/above the co-sign threshold (it will be HELD for the owner). ' +
      'Do not invent domains outside the catalog.',
  });
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OR_KEY}`, 'X-Title': 'Budgent Agent' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, ''));
  return parsed.purchases || [];
}

function fallbackPlan(): { domain: string; amount: number; reason: string }[] {
  return cfg.catalog.map((c) => ({ domain: c.domain, amount: c.price, reason: `task: ${c.resource}` }));
}

const ICON: Record<string, string> = { SETTLED: '✓', APPROVED: '✓', REVERTED: '✗', HELD: '⏸', DENIED: '✗', FAILED: '!' };

async function main() {
  console.log(`\n🤖 Budgent agent — task: "${cfg.task}"`);
  const budget = await api('GET', '/v1/me');
  console.log(`   budget: per-tx ${budget.policy.perTx} · daily ${budget.policy.daily} · co-sign ≥${budget.policy.cosign} ${budget.asset} · balance ${budget.state.balance}`);

  let plan: { domain: string; amount: number; reason: string }[];
  if (OR_KEY) {
    try {
      console.log(`   planning with ${MODEL}…`);
      plan = await planWithLLM(budget);
      console.log(`   LLM proposed ${plan.length} purchase(s).`);
    } catch (e: any) {
      console.log(`   ⚠ LLM planning failed (${e.message}); using catalog fallback.`);
      plan = fallbackPlan();
    }
  } else {
    console.log('   no OPENROUTER_API_KEY; using catalog fallback.');
    plan = fallbackPlan();
  }

  const taskId = 'agent-' + Date.now().toString(36);
  let settled = 0, reverted = 0, held = 0;
  for (const p of plan) {
    const cat = cfg.catalog.find((c) => c.domain === p.domain);
    try {
      const r = await api('POST', '/v1/payments', {
        amount: p.amount,
        domain: p.domain,
        url: cat?.url,
        resource: cat?.resource || p.reason,
        taskId,
        idempotencyKey: `${taskId}-${p.domain}-${p.amount}`,
      });
      const mark = ICON[r.status] || '?';
      console.log(`   ${mark} ${r.status.padEnd(9)} ${String(p.amount).padStart(7)} ${budget.asset}  ${p.domain}  ${r.reason || ''}`);
      if (r.signature) console.log(`        ↳ ${r.explorer}`);
      if (r.status === 'SETTLED' || r.status === 'APPROVED') settled++;
      else if (r.status === 'HELD') held++;
      else reverted++;
    } catch (e: any) {
      console.log(`   ! ERROR    ${p.domain}: ${e.message}`);
    }
  }
  console.log(`\n   done — ${settled} settled · ${reverted} reverted · ${held} held for co-sign\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
