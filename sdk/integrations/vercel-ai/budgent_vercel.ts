/**
 * Budgent tools for the Vercel AI SDK — on-chain budget for your agent.
 *
 * Exposes `budgent_pay` / `budgent_balance` as AI SDK tools. The model calls
 * them; the deployed program enforces the per-tx cap, daily limit, allow/block
 * lists and co-sign. Wraps `budgent-sdk` (npm); HMAC stays server-side.
 *
 *   npm i budgent-sdk ai zod
 */
import { tool } from "ai";
import { z } from "zod";
import { BudgentClient, type BudgentConfig } from "budgent-sdk";

export function budgentTools(cfg: BudgentConfig) {
  const budgent = new BudgentClient(cfg);
  return {
    budgent_pay: tool({
      description:
        "Pay a vendor within the on-chain budget. The program enforces the per-tx cap, daily limit, allow/block lists and co-sign. Returns the verdict (SETTLED / REVERTED / HELD).",
      parameters: z.object({
        amount: z.number().describe("amount to pay"),
        domain: z.string().optional().describe("vendor domain — resolves to a recipient"),
        recipient: z.string().optional().describe("or a direct recipient pubkey"),
        resource: z.string().optional(),
        taskId: z.string().optional(),
      }),
      execute: async (input) => budgent.pay(input),
    }),
    budgent_balance: tool({
      description: "Get the agent's current budget snapshot (balance + policy + spend).",
      parameters: z.object({}),
      execute: async () => budgent.me(),
    }),
  };
}
