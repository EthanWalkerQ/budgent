# budgent-mcp

A stdio [MCP](https://modelcontextprotocol.io) server that gives any MCP host (Claude Desktop, etc.)
the Budgent **pay** capability. Non-custodial: the agent holds only a scoped API key; the on-chain
program enforces the budget.

## Tools

- `budgent_pay` — params: `amount` (required), `domain?`, `recipient?`, `resource?`, `taskId?`. Returns the on-chain verdict (`status` SETTLED/REVERTED/HELD + reason + signature/explorer).
- `budgent_balance` — no params. Returns the agent's budget snapshot (`GET /v1/me`).

## Install & run

```bash
npm i
BUDGENT_BASE_URL=https://api.budgent.xyz \
BUDGENT_KEY_ID=your_key_id \
BUDGENT_HMAC_SECRET=your_hmac_secret \
npm start
```

## Claude Desktop config

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "budgent": {
      "command": "node",
      "args": ["/absolute/path/to/budgent/sdk/mcp/server.mjs"],
      "env": {
        "BUDGENT_BASE_URL": "https://api.budgent.xyz",
        "BUDGENT_KEY_ID": "your_key_id",
        "BUDGENT_HMAC_SECRET": "your_hmac_secret"
      }
    }
  }
}
```

Restart Claude Desktop; the `budgent_pay` and `budgent_balance` tools will be available to the agent.
