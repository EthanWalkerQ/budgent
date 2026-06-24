"""Budgent x LangChain (Python) — StructuredTools that let a LangChain agent pay
through Budgent. Non-custodial: the agent holds only a scoped API key; the on-chain
program enforces the budget.

    pip install langchain-core pydantic
    # plus budgent.py on the path (the Budgent Python SDK)
"""
from __future__ import annotations

from typing import Optional

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from budgent import Budgent


class _PayArgs(BaseModel):
    amount: float = Field(..., description="Amount to pay (vault asset units, e.g. USDC).")
    domain: Optional[str] = Field(None, description='Resource domain resolved via the vault registry, e.g. "api.openai.com".')
    recipient: Optional[str] = Field(None, description="Direct recipient pubkey, if not using a domain.")
    resource: Optional[str] = Field(None, description='What is being paid for, e.g. "gpt-4o tokens".')
    task_id: Optional[str] = Field(None, description="Caller task id for attribution / idempotency.")


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


def budgent_pay_tool(base_url: str, key_id: str, hmac_secret: str) -> StructuredTool:
    """Build the `budgent_pay` StructuredTool. Returns a concise verdict string."""
    client = Budgent(base_url=base_url, key_id=key_id, hmac_secret=hmac_secret)

    def _pay(amount: float, domain: Optional[str] = None, recipient: Optional[str] = None,
             resource: Optional[str] = None, task_id: Optional[str] = None) -> str:
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

    return StructuredTool.from_function(
        func=_pay,
        name="budgent_pay",
        description=(
            "Pay for a resource through Budgent (non-custodial, on-chain enforced). "
            "Provide an amount and either a domain or a recipient. Returns the on-chain verdict."
        ),
        args_schema=_PayArgs,
    )


def budgent_balance_tool(base_url: str, key_id: str, hmac_secret: str) -> StructuredTool:
    """Build the `budgent_balance` StructuredTool (GET /v1/me)."""
    client = Budgent(base_url=base_url, key_id=key_id, hmac_secret=hmac_secret)

    def _balance() -> str:
        try:
            return str(client.me())
        except Exception as e:  # noqa: BLE001
            return f"budgent_balance error: {e}"

    return StructuredTool.from_function(
        func=_balance,
        name="budgent_balance",
        description="Get the agent's Budgent budget snapshot (policy, balance, spend so far).",
    )
