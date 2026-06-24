/**
 * Budgent x OpenAI Agents SDK (TypeScript) — function tools that let an Agent pay
 * through Budgent. Non-custodial: the agent holds only a scoped API key; the
 * on-chain program enforces the budget.
 *
 *   npm i budgent-sdk @openai/agents zod
 */
import { tool } from '@openai/agents';
import { z } from 'zod';
import { BudgentClient, type BudgentConfig } from 'budgent-sdk';

/** Build the `budgent_pay` + `budgent_balance` function tools for an OpenAI Agent. */
export function budgentTools(cfg: BudgentConfig) {
  const client = new BudgentClient(cfg);

  const budgentPay = tool({
    name: 'budgent_pay',
    description:
      'Pay for a resource through Budgent (non-custodial, on-chain enforced). ' +
      'Provide an amount and either a domain or a recipient. Returns the on-chain verdict.',
    parameters: z.object({
      amount: z.number().positive().describe('Amount to pay (vault asset units, e.g. USDC).'),
      domain: z.string().nullable().describe('Resource domain resolved via the vault registry, or null.'),
      recipient: z.string().nullable().describe('Direct recipient pubkey, or null.'),
      resource: z.string().nullable().describe('What is being paid for, e.g. "gpt-4o tokens", or null.'),
      taskId: z.string().nullable().describe('Caller task id for attribution / idempotency, or null.'),
    }),
    async execute({ amount, domain, recipient, resource, taskId }) {
      try {
        const r = await client.pay({
          amount,
          domain: domain ?? undefined,
          recipient: recipient ?? undefined,
          resource: resource ?? undefined,
          taskId: taskId ?? undefined,
        });
        const parts = [`status=${r.status}`, `reason=${r.reason}`, `amount=${r.amount} ${r.asset}`];
        if (r.signature) parts.push(`signature=${r.signature}`);
        if (r.explorer) parts.push(`explorer=${r.explorer}`);
        return parts.join(' | ');
      } catch (e: any) {
        return `budgent_pay error: ${e?.message ?? String(e)}`;
      }
    },
  });

  const budgentBalance = tool({
    name: 'budgent_balance',
    description: 'Get the agent\'s Budgent budget snapshot (policy, balance, spend so far).',
    parameters: z.object({}),
    async execute() {
      try {
        return JSON.stringify(await client.me());
      } catch (e: any) {
        return `budgent_balance error: ${e?.message ?? String(e)}`;
      }
    },
  });

  return { budgentPay, budgentBalance };
}
