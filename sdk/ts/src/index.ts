import { createHmac } from 'crypto';

export interface BudgentConfig {
  baseUrl: string;
  keyId?: string;
  hmacSecret?: string;
  bearer?: string; // alternative simple auth
}

export interface PayInput {
  amount: number;
  domain?: string; // resolved via the vault's resource registry
  recipient?: string; // or a direct pubkey
  url?: string;
  resource?: string;
  taskId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, any>;
  model?: 'PUSH' | 'INVOICE';
}

export interface PaymentResult {
  id: string;
  status: 'SETTLED' | 'APPROVED' | 'REVERTED' | 'HELD' | 'DENIED' | 'FAILED' | 'CREATED';
  reason: string;
  amount: number;
  asset: string;
  recipient: string;
  context: { domain: string; url: string; resource: string; taskId: string };
  contextHash: string;
  signature: string | null;
  explorer: string | null;
  ruleResults?: { rule: string; status: string; detail: string }[];
}

/**
 * Budgent agent SDK. The agent pays through explicit REST calls — no x402, no transport
 * games — and the on-chain program enforces the budget. The agent never holds the wallet's
 * keys, only a scoped API key.
 */
export class BudgentClient {
  constructor(private cfg: BudgentConfig) {
    if (!cfg.baseUrl) throw new Error('baseUrl required');
  }

  private sign(method: string, path: string, body: string): Record<string, string> {
    if (this.cfg.keyId && this.cfg.hmacSecret) {
      const ts = Math.floor(Date.now() / 1000).toString();
      const base = `${ts}.${method}.${path}.${body}`;
      const sig = createHmac('sha256', this.cfg.hmacSecret).update(base).digest('hex');
      return {
        'X-Budgent-Key': this.cfg.keyId,
        'X-Budgent-Timestamp': ts,
        'X-Budgent-Signature': sig,
      };
    }
    if (this.cfg.bearer) return { Authorization: `Bearer ${this.cfg.bearer}` };
    throw new Error('provide keyId+hmacSecret or bearer');
  }

  private async req(method: string, path: string, payload?: any): Promise<any> {
    const body = payload != null ? JSON.stringify(payload) : '';
    const res = await fetch(this.cfg.baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...this.sign(method, path, body) },
      body: method === 'GET' ? undefined : body,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${res.status} ${json.message || text}`);
    return json;
  }

  /** Create + execute a payment (push model). Returns the on-chain verdict. */
  pay(input: PayInput): Promise<PaymentResult> {
    return this.req('POST', '/v1/payments', input);
  }

  getPayment(id: string): Promise<PaymentResult> {
    return this.req('GET', `/v1/payments/${id}`);
  }

  /** The agent's own budget snapshot (policy + balance + spend). */
  me(): Promise<any> {
    return this.req('GET', '/v1/me');
  }
}

export default BudgentClient;
