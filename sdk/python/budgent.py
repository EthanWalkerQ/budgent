"""Budgent agent SDK (Python). Pay autonomously through a REST API, bounded on-chain."""
from __future__ import annotations
import hashlib
import hmac
import json
import time
import urllib.request
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class Budgent:
    base_url: str
    key_id: Optional[str] = None
    hmac_secret: Optional[str] = None
    bearer: Optional[str] = None

    def _headers(self, method: str, path: str, body: str) -> dict:
        if self.key_id and self.hmac_secret:
            ts = str(int(time.time()))
            base = f"{ts}.{method}.{path}.{body}"
            sig = hmac.new(self.hmac_secret.encode(), base.encode(), hashlib.sha256).hexdigest()
            return {
                "Content-Type": "application/json",
                "X-Budgent-Key": self.key_id,
                "X-Budgent-Timestamp": ts,
                "X-Budgent-Signature": sig,
            }
        if self.bearer:
            return {"Content-Type": "application/json", "Authorization": f"Bearer {self.bearer}"}
        raise ValueError("provide key_id+hmac_secret or bearer")

    def _req(self, method: str, path: str, payload: Optional[dict] = None) -> Any:
        body = json.dumps(payload) if payload is not None else ""
        req = urllib.request.Request(
            self.base_url + path,
            data=None if method == "GET" else body.encode(),
            headers=self._headers(method, path, body),
            method=method,
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode() or "{}")

    def pay(self, amount: float, domain: str = None, recipient: str = None, url: str = "",
            resource: str = "", task_id: str = "", idempotency_key: str = None,
            metadata: dict = None) -> dict:
        payload = {
            "amount": amount, "domain": domain, "recipient": recipient, "url": url,
            "resource": resource, "taskId": task_id, "idempotencyKey": idempotency_key,
            "metadata": metadata,
        }
        return self._req("POST", "/v1/payments", {k: v for k, v in payload.items() if v is not None})

    def get_payment(self, payment_id: str) -> dict:
        return self._req("GET", f"/v1/payments/{payment_id}")

    def me(self) -> dict:
        return self._req("GET", "/v1/me")
