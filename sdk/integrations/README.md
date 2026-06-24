# Budgent agent-framework integrations

Drop-in tools that let any agent pay through [Budgent](../../) — a non-custodial Solana
budget for AI agents. The agent calls a single `budgent_pay` capability; an on-chain program
enforces the budget. Auth is HMAC-SHA256 over `` `${ts}.${method}.${path}.${body}` `` with the
scoped key (`X-Budgent-Key` / `X-Budgent-Timestamp` / `X-Budgent-Signature` headers).

Config everywhere: `{ baseUrl, keyId, hmacSecret }`.

Each integration exposes:
- `budgent_pay({ amount, domain?, recipient?, resource?, taskId? })` → on-chain verdict (status SETTLED/REVERTED/HELD + reason + signature/explorer).
- `budgent_balance()` → the agent's budget snapshot (`GET /v1/me`).

---

## LangChain (TypeScript)

`npm i budgent-sdk @langchain/core zod`

```ts
import { budgentPayTool, budgentBalanceTool } from './langchain/budgent_langchain';

const cfg = { baseUrl: 'https://api.budgent.xyz', keyId: 'KEY', hmacSecret: 'SECRET' };
const tools = [budgentPayTool(cfg), budgentBalanceTool(cfg)];
// pass `tools` to your LangChain agent / model.bindTools(tools)
```

## LangChain (Python)

`pip install langchain-core pydantic` (plus `budgent.py` on the path)

```python
from langchain.budgent_langchain import budgent_pay_tool, budgent_balance_tool

cfg = dict(base_url="https://api.budgent.xyz", key_id="KEY", hmac_secret="SECRET")
tools = [budgent_pay_tool(**cfg), budgent_balance_tool(**cfg)]
# pass `tools` to your LangChain agent
```

## OpenAI Agents SDK (TypeScript)

`npm i @openai/agents budgent-sdk zod`

```ts
import { Agent } from '@openai/agents';
import { budgentTools } from './openai-agents/budgent_tool';

const { budgentPay, budgentBalance } = budgentTools({
  baseUrl: 'https://api.budgent.xyz', keyId: 'KEY', hmacSecret: 'SECRET',
});
const agent = new Agent({ name: 'spender', tools: [budgentPay, budgentBalance] });
```

## OpenAI Agents SDK (Python)

`pip install openai-agents` (plus `budgent.py` on the path)

```python
from agents import Agent
from openai_agents.budgent_tool import make_budgent_tools

tools = make_budgent_tools(base_url="https://api.budgent.xyz", key_id="KEY", hmac_secret="SECRET")
agent = Agent(name="spender", tools=tools)
```

## MCP server (Claude Desktop & any MCP host)

See [`../mcp/README.md`](../mcp/README.md).

```bash
cd ../mcp && npm i
BUDGENT_BASE_URL=https://api.budgent.xyz BUDGENT_KEY_ID=KEY BUDGENT_HMAC_SECRET=SECRET npm start
```

Exposes `budgent_pay` and `budgent_balance` over stdio; config via env vars.
