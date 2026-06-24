/**
 * Budgent x LangChain.js — a DynamicStructuredTool that lets a LangChain agent
 * pay through Budgent. Non-custodial: the agent only holds a scoped API key, the
 * on-chain program enforces the budget.
 *
 *   npm i budgent-sdk @langchain/core zod
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { BudgentClient, type BudgentConfig } from 'budgent-sdk';

const paySchema = z.object({
  amount: z.number().positive().describe('Amount to pay (in the vault asset units, e.g. USDC).'),
  domain: z.string().optional().describe('Resource domain resolved via the vault registry, e.g. "api.openai.com".'),
  recipient: z.string().optional().describe('Direct recipient pubkey, if not using a domain.'),
  resource: z.string().optional().describe('What is being paid for, e.g. "gpt-4o tokens".'),
  taskId: z.string().optional().describe('Caller task id for attribution / idempotency.'),
});

/**
 * Build the `budgent_pay` tool. The handler returns a concise human/LLM-readable
 * string (status + reason + signature) so the agent can reason about the verdict.
 */
export function budgentPayTool(cfg: BudgentConfig) {
  const client = new BudgentClient(cfg);
  return new DynamicStructuredTool({
    name: 'budgent_pay',
    description:
      'Pay for a resource through Budgent (non-custodial, on-chain enforced). ' +
      'Provide an amount and either a domain or a recipient. Returns the on-chain verdict.',
    schema: paySchema,
    func: async ({ amount, domain, recipient, resource, taskId }) => {
      try {
        const r = await client.pay({ amount, domain, recipient, resource, taskId });
        const parts = [`status=${r.status}`, `reason=${r.reason}`, `amount=${r.amount} ${r.asset}`];
        if (r.signature) parts.push(`signature=${r.signature}`);
        if (r.explorer) parts.push(`explorer=${r.explorer}`);
        return parts.join(' | ');
      } catch (e: any) {
        return `budgent_pay error: ${e?.message ?? String(e)}`;
      }
    },
  });
}

/** Read the agent's own budget snapshot (policy + balance + spend). */
export function budgentBalanceTool(cfg: BudgentConfig) {
  const client = new BudgentClient(cfg);
  return new DynamicStructuredTool({
    name: 'budgent_balance',
    description: 'Get the agent\'s Budgent budget snapshot (policy, balance, spend so far).',
    schema: z.object({}),
    func: async () => {
      try {
        return JSON.stringify(await client.me());
      } catch (e: any) {
        return `budgent_balance error: ${e?.message ?? String(e)}`;
      }
    },
  });
}
