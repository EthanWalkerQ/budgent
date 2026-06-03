import { createHash } from 'crypto';

/** Native-SOL sentinel mint (Pubkey::default, all zeroes). */
export const NATIVE_MINT_SENTINEL = '11111111111111111111111111111111';

/** Convert a human amount (e.g. 0.05 SOL, 5 USDC) to integer base units, decimal-safe. */
export function toBaseUnits(ui: number | string, decimals: number): bigint {
  const s = typeof ui === 'number' ? ui.toFixed(decimals + 2) : String(ui).trim();
  const neg = s.startsWith('-');
  const clean = s.replace('-', '');
  const [intPart = '0', fracRaw = ''] = clean.split('.');
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const combined = (intPart || '0') + frac;
  const v = BigInt(combined.replace(/^0+(?=\d)/, '') || '0');
  return neg ? -v : v;
}

/** Convert integer base units back to a human number (display only). */
export function toUi(base: bigint, decimals: number): number {
  const d = BigInt(10) ** BigInt(decimals);
  const whole = base / d;
  const frac = base < 0n ? -(base % d) : base % d;
  return Number(whole) + Number(frac) / Number(d);
}

/** Fixed-decimals string form for the ledger / receipts. */
export function formatUi(base: bigint, decimals: number): string {
  const d = BigInt(10) ** BigInt(decimals);
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const whole = abs / d;
  const frac = (abs % d).toString().padStart(decimals, '0');
  return (neg ? '-' : '') + whole.toString() + (decimals ? '.' + frac : '');
}

/** Deterministic, order-independent JSON for hashing context. */
export function canonicalize(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export interface PaymentContext {
  domain: string;
  url?: string;
  resource?: string;
  taskId?: string;
  [k: string]: any;
}

/**
 * The verifiable on-chain ↔ off-chain link. The 32-byte sha256 of the canonical context
 * is passed to the program (emitted in PaymentSettled) and written as a tx memo; the full
 * context lives off-chain. Anyone can re-hash the stored context and match the on-chain hash.
 */
export function contextHash(ctx: PaymentContext): { hex: string; bytes: number[]; canonical: string } {
  const canonical = canonicalize(ctx);
  const digest = createHash('sha256').update(canonical, 'utf8').digest();
  return { hex: digest.toString('hex'), bytes: Array.from(digest), canonical };
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
