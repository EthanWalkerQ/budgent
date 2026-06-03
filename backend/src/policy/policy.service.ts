import { Injectable } from '@nestjs/common';
import { formatUi } from '../common/units';
import { VaultState } from '../solana/solana.service';

export type Verdict = 'ALLOW' | 'REVERT' | 'HELD';
export type RuleStatus = 'pass' | 'fail' | 'hold' | 'skip';

export interface RuleResult {
  rule: string;
  status: RuleStatus;
  detail: string;
}

export interface PolicyResult {
  verdict: Verdict;
  reason: string;
  ruleResults: RuleResult[];
}

const RULE_ORDER = [
  'delegate_active',
  'recipient_check',
  'per_tx_limit',
  'daily_window',
  'balance',
  'cosign_threshold',
];

const WINDOW_SECONDS = 86_400n;

/**
 * Off-chain mirror of the on-chain `authorize_and_commit`. Same rule order, same outcomes.
 *
 * This is defence-in-depth and the source of the rule-by-rule breakdown the console shows —
 * but it is NOT the enforcer. The chain is. ALLOW intents are submitted; REVERT intents are
 * (optionally) submitted anyway so the network records the real revert; HELD intents wait
 * for the owner's co-signature.
 */
@Injectable()
export class PolicyService {
  evaluate(
    vault: VaultState,
    available: bigint,
    recipient: string,
    amountBase: bigint,
    nowSec: number,
    fmt: { decimals: number; asset: string },
  ): PolicyResult {
    const rr: RuleResult[] = [];
    const a = (rule: string, status: RuleStatus, detail = '') => rr.push({ rule, status, detail });
    const skipFrom = (rule: string) => {
      const i = RULE_ORDER.indexOf(rule);
      for (let k = i; k < RULE_ORDER.length; k++) a(RULE_ORDER[k], 'skip', '');
    };
    const f = (v: bigint) => formatUi(v, fmt.decimals);
    const U = fmt.asset;

    // 1 — delegate
    if (!vault.delegateActive || vault.delegate.toBase58() === '11111111111111111111111111111111') {
      a('delegate_active', 'fail', 'revoked');
      skipFrom('recipient_check');
      return { verdict: 'REVERT', reason: 'delegate revoked — all transfers blocked', ruleResults: rr };
    }
    a('delegate_active', 'pass', 'active');

    // 2 — recipient
    if (vault.blocklist.includes(recipient)) {
      a('recipient_check', 'fail', 'blocklisted');
      skipFrom('per_tx_limit');
      return { verdict: 'REVERT', reason: `recipient ${recipient} is blocklisted`, ruleResults: rr };
    }
    if (vault.allowlist.length > 0 && !vault.allowlist.includes(recipient)) {
      a('recipient_check', 'fail', 'not on allowlist');
      skipFrom('per_tx_limit');
      return { verdict: 'REVERT', reason: `recipient ${recipient} not on allowlist`, ruleResults: rr };
    }
    a('recipient_check', 'pass', vault.allowlist.length ? 'on allowlist' : 'not blocklisted');

    // 3 — per-tx
    if (amountBase <= 0n) {
      a('per_tx_limit', 'fail', 'zero amount');
      skipFrom('daily_window');
      return { verdict: 'REVERT', reason: 'amount must be greater than zero', ruleResults: rr };
    }
    if (amountBase > vault.perTxLimit) {
      a('per_tx_limit', 'fail', 'over');
      skipFrom('daily_window');
      return {
        verdict: 'REVERT',
        reason: `exceeds per-tx limit (${f(amountBase)} > ${f(vault.perTxLimit)} ${U})`,
        ruleResults: rr,
      };
    }
    a('per_tx_limit', 'pass', `<= ${f(vault.perTxLimit)}`);

    // 4 — daily window (roll the fixed window)
    let spent = vault.spentInWindow;
    if (BigInt(nowSec) - vault.windowStart >= WINDOW_SECONDS) spent = 0n;
    const projected = spent + amountBase;
    if (projected > vault.dailyLimit) {
      a('daily_window', 'fail', 'over');
      skipFrom('balance');
      return {
        verdict: 'REVERT',
        reason: `daily limit exhausted (${f(spent)}+${f(amountBase)} > ${f(vault.dailyLimit)} ${U})`,
        ruleResults: rr,
      };
    }
    a('daily_window', 'pass', `${f(projected)}/${f(vault.dailyLimit)}`);

    // 5 — balance
    if (amountBase > available) {
      a('balance', 'fail', 'insufficient');
      skipFrom('cosign_threshold');
      return {
        verdict: 'REVERT',
        reason: `insufficient vault balance (${f(amountBase)} > ${f(available)} ${U})`,
        ruleResults: rr,
      };
    }
    a('balance', 'pass', `${f(available)} avail`);

    // 6 — co-sign threshold (per-payment magnitude gate)
    if (amountBase >= vault.cosignThreshold) {
      a('cosign_threshold', 'hold', `>= ${f(vault.cosignThreshold)}`);
      return {
        verdict: 'HELD',
        reason: `amount ${f(amountBase)} ≥ co-sign threshold ${f(vault.cosignThreshold)} ${U} — queued for owner`,
        ruleResults: rr,
      };
    }
    a('cosign_threshold', 'pass', 'below threshold');

    return { verdict: 'ALLOW', reason: '', ruleResults: rr };
  }
}
