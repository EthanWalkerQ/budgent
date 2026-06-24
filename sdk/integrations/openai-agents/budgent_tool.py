"""Budgent x OpenAI Agents SDK (Python) — function tools that let an Agent pay
through Budgent. Non-custodial: the agent holds only a scoped API key; the on-chain
program enforces the budget.

    pip install openai-agents
    # plus budgent.py on the path (the Budgent Python SDK)
"""
from __future__ import annotations

from typing import Optional

from agents import function_tool

from budgent import Budgent


def make_budgent_tools(base_url: str, key_id: str, hmac_secret: str):
    """Build the `budgent_pay` + `budgent_balance` function tools bound to a config."""
    client = Budgent(base_url=base_url, key_id=key_id, hmac_secret=hmac_secret)

    def _verdict_str(r: dict) -> str:
        parts = [
            f"status={r.get('status')}",
            f"reason={r.get('reason')}",
            f"amount={r.get('amount')} {r.get('asset')}",
        ]
        if r.get("signature"):
            parts.append(f"signature={r['signature']}")
        if r.get("explorer"):
            parts.append(f"explorer={r['explorer']}")
        return " | ".join(parts)

    @function_tool
    def budgent_pay(amount: float, domain: Optional[str] = None, recipient: Optional[str] = None,
                    resource: Optional[str] = None, task_id: Optional[str] = None) -> str:
        """Pay for a resource through Budgent (non-custodial, on-chain enforced).

        Args:
            amount: Amount to pay (vault asset units, e.g. USDC).
            domain: Resource domain resolved via the vault registry, e.g. "api.openai.com".
            recipient: Direct recipient pubkey, if not using a domain.
            resource: What is being paid for, e.g. "gpt-4o tokens".
            task_id: Caller task id for attribution / idempotency.
        """
        try:
            r = client.pay(
                amount=amount,
                domain=domain,
                recipient=recipient,
                resource=resource or "",
                task_id=task_id or "",
            )
            return _verdict_str(r)
        except Exception as e:  # noqa: BLE001
            return f"budgent_pay error: {e}"

    @function_tool
    def budgent_balance() -> str:
        """Get the agent's Budgent budget snapshot (policy, balance, spend so far)."""
        try:
            return str(client.me())
        except Exception as e:  # noqa: BLE001
            return f"budgent_balance error: {e}"

    return [budgent_pay, budgent_balance]
