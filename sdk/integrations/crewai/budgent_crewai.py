"""
Budgent tools for CrewAI — give a crew member a BUDGET, not your keys.

The agent calls `budgent_pay`; the on-chain program enforces the per-tx cap,
daily limit, allow/block lists and co-sign. Wraps the stdlib-only Python SDK
(sdk/python/budgent.py). HMAC auth over `${ts}.${method}.${path}.${body}`.

    pip install crewai      # plus budgent.py on the path
"""
from __future__ import annotations
from crewai.tools import tool
from budgent import Budgent


def budgent_tools(base_url: str, key_id: str, hmac_secret: str):
    client = Budgent(base_url=base_url, key_id=key_id, hmac_secret=hmac_secret)

    @tool("budgent_pay")
    def budgent_pay(amount: float, domain: str = "", recipient: str = "",
                    resource: str = "", task_id: str = "") -> str:
        """Pay a vendor within the on-chain budget. `domain` resolves to a recipient
        (or pass `recipient` directly). Returns the on-chain verdict — SETTLED /
        REVERTED / HELD — plus the transaction signature when it settles."""
        r = client.pay(amount=amount, domain=domain, recipient=recipient or "",
                       resource=resource, task_id=task_id)
        sig = r.get("signature") or ""
        reason = r.get("reason") or ""
        return f"{r['status']}" + (f" {sig}" if sig else "") + (f" — {reason}" if reason else "")

    @tool("budgent_balance")
    def budgent_balance() -> str:
        """The agent's current budget snapshot: balance, policy and spend so far."""
        return str(client.me())

    return [budgent_pay, budgent_balance]
