#!/usr/bin/env node
/**
 * Budgent MCP server — exposes the Budgent pay capability to any MCP host
 * (Claude Desktop, etc.) over stdio. Non-custodial: the agent holds only a
 * scoped API key; the on-chain program enforces the budget.
 *
 * Config via env:
 *   BUDGENT_BASE_URL     e.g. https://api.budgent.xyz
 *   BUDGENT_KEY_ID       the scoped API key id
 *   BUDGENT_HMAC_SECRET  the HMAC secret for that key
 */
import { createHmac } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE_URL = process.env.BUDGENT_BASE_URL;
const KEY_ID = process.env.BUDGENT_KEY_ID;
const HMAC_SECRET = process.env.BUDGENT_HMAC_SECRET;

if (!BASE_URL || !KEY_ID || !HMAC_SECRET) {
  console.error('Missing env: BUDGENT_BASE_URL, BUDGENT_KEY_ID, BUDGENT_HMAC_SECRET are required.');
  process.exit(1);
}

/** Sign + send a request, matching the Budgent HMAC scheme exactly. */
async function budgentRequest(method, path, payload) {
  const body = payload != null ? JSON.stringify(payload) : '';
  const ts = Math.floor(Date.now() / 1000).toString();
  const base = `${ts}.${method}.${path}.${body}`;
  const sig = createHmac('sha256', HMAC_SECRET).update(base).digest('hex');
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Budgent-Key': KEY_ID,
      'X-Budgent-Timestamp': ts,
      'X-Budgent-Signature': sig,
    },
    body: method === 'GET' ? undefined : body,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${res.status} ${json.message || text}`);
  return json;
}

function verdictText(r) {
  const parts = [`status=${r.status}`, `reason=${r.reason}`, `amount=${r.amount} ${r.asset}`];
  if (r.signature) parts.push(`signature=${r.signature}`);
  if (r.explorer) parts.push(`explorer=${r.explorer}`);
  return parts.join(' | ');
}

const TOOLS = [
  {
    name: 'budgent_pay',
    description:
      'Pay for a resource through Budgent (non-custodial, on-chain enforced). ' +
      'Provide an amount and either a domain or a recipient. Returns the on-chain verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount to pay (vault asset units, e.g. USDC).' },
        domain: { type: 'string', description: 'Resource domain resolved via the vault registry, e.g. "api.openai.com".' },
        recipient: { type: 'string', description: 'Direct recipient pubkey, if not using a domain.' },
        resource: { type: 'string', description: 'What is being paid for, e.g. "gpt-4o tokens".' },
        taskId: { type: 'string', description: 'Caller task id for attribution / idempotency.' },
      },
      required: ['amount'],
    },
  },
  {
    name: 'budgent_balance',
    description: "Get the agent's Budgent budget snapshot (policy, balance, spend so far).",
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server(
  { name: 'budgent-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === 'budgent_pay') {
      const { amount, domain, recipient, resource, taskId } = args;
      const payload = { amount };
      if (domain != null) payload.domain = domain;
      if (recipient != null) payload.recipient = recipient;
      if (resource != null) payload.resource = resource;
      if (taskId != null) payload.taskId = taskId;
      const r = await budgentRequest('POST', '/v1/payments', payload);
      return { content: [{ type: 'text', text: verdictText(r) }] };
    }
    if (name === 'budgent_balance') {
      const r = await budgentRequest('GET', '/v1/me');
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: `${name} error: ${e?.message ?? String(e)}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('budgent-mcp server running on stdio');
}

main().catch((e) => {
  console.error('budgent-mcp fatal:', e);
  process.exit(1);
});
