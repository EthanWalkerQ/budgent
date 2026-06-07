import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';

const MONEY_MOVED = ['SETTLED', 'APPROVED'];

@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService, private payments: PaymentsService) {}

  async list(vaultId: string, filters: { status?: string; taskId?: string; domain?: string } = {}) {
    const where: any = { vaultId };
    if (filters.status && filters.status !== 'all') where.status = filters.status;
    if (filters.taskId && filters.taskId !== 'all') where.taskId = filters.taskId;
    if (filters.domain) where.domain = filters.domain;
    const rows = await this.prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.payments.view(r));
  }

  async held(vaultId: string) {
    const rows = await this.prisma.payment.findMany({ where: { vaultId, status: 'HELD' }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.payments.view(r));
  }

  /** By-context cards: per-domain total (money moved), tx count, top resource. */
  async contexts(vaultId: string) {
    const rows = await this.prisma.payment.findMany({ where: { vaultId } });
    const groups: Record<string, { domain: string; total: number; count: number; resources: Record<string, number> }> = {};
    for (const r of rows) {
      const g = (groups[r.domain] ||= { domain: r.domain, total: 0, count: 0, resources: {} });
      g.count++;
      if (MONEY_MOVED.includes(r.status)) g.total = Math.round((g.total + r.amountUi) * 1e9) / 1e9;
      if (r.resource) g.resources[r.resource] = (g.resources[r.resource] || 0) + 1;
    }
    return Object.values(groups)
      .map((g) => ({
        domain: g.domain,
        total: g.total,
        count: g.count,
        topResource: Object.entries(g.resources).sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
      }))
      .sort((a, b) => b.total - a.total);
  }

  async export(vaultId: string, fmt: 'csv' | 'json') {
    const rows = await this.prisma.payment.findMany({ where: { vaultId }, orderBy: { createdAt: 'asc' } });
    const records = rows.map((r) => ({
      ts: r.createdAt.toISOString(),
      status: r.status,
      amount: r.amountUi,
      asset: r.asset,
      domain: r.domain,
      url: r.url,
      resource: r.resource,
      task_id: r.taskId,
      recipient: r.recipient,
      signature: r.signature || '',
      context_hash: r.contextHash,
      idempotency_key: r.idempotencyKey,
    }));
    if (fmt === 'json') return { contentType: 'application/json', filename: 'budgent-ledger.json', body: JSON.stringify(records, null, 2) };
    const cols = Object.keys(records[0] || { ts: '', status: '', amount: '', asset: '', domain: '', url: '', resource: '', task_id: '', recipient: '', signature: '', context_hash: '', idempotency_key: '' });
    const esc = (v: any) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const body = [cols.join(','), ...records.map((r) => cols.map((c) => esc((r as any)[c])).join(','))].join('\n');
    return { contentType: 'text/csv', filename: 'budgent-ledger.csv', body };
  }
}
