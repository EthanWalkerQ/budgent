import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublicKey } from '@solana/web3.js';
import { PrismaService } from '../prisma/prisma.service';
import { SolanaService } from '../solana/solana.service';

/**
 * Indexer: listens to the program on Solana (Helius WS logs + signature polling), decodes
 * PaymentSettled events, and stitches each on-chain signature ↔ context-hash ↔ off-chain
 * context. It confirms ledger rows created via the API and backfills any direct on-chain
 * payment whose context-hash we have seen. No public webhook URL required.
 */
@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Indexer');
  private subId: number | null = null;
  private poll: NodeJS.Timeout | null = null;
  private enabled: boolean;

  constructor(private prisma: PrismaService, private solana: SolanaService, private cfg: ConfigService) {
    this.enabled = String(cfg.get('INDEXER_ENABLED') ?? 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) return;
    const pid = this.solana.programId;
    try {
      this.subId = this.solana.connection.onLogs(
        pid,
        (logs, ctx) => {
          if (logs.err) return; // failed (reverted) txs carry no settled event
          this.ingest(logs.signature, logs.logs, ctx.slot).catch((e) => this.log.warn(`ingest: ${e.message}`));
        },
        this.solana.commitment,
      );
      this.log.log(`subscribed to program logs (${pid.toBase58()})`);
    } catch (e: any) {
      this.log.warn(`WS subscribe failed, relying on poller: ${e.message}`);
    }
    // backfill poller every 20s
    this.poll = setInterval(() => this.pollSignatures().catch((e) => this.log.warn(`poll: ${e.message}`)), 20_000);
    this.pollSignatures().catch(() => {});
  }

  async onModuleDestroy() {
    if (this.subId != null) await this.solana.connection.removeOnLogsListener(this.subId).catch(() => {});
    if (this.poll) clearInterval(this.poll);
  }

  private async pollSignatures() {
    const pid = this.solana.programId;
    const cursor = await this.prisma.indexerCursor.findUnique({ where: { programId: pid.toBase58() } });
    const sigs = await this.solana.connection.getSignaturesForAddress(
      pid,
      { until: cursor?.lastSignature || undefined, limit: 100 },
      'confirmed',
    );
    if (!sigs.length) return;
    // process oldest → newest
    for (const s of sigs.reverse()) {
      if (s.err) continue;
      const tx = await this.solana.connection.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx?.meta?.logMessages) await this.ingest(s.signature, tx.meta.logMessages, tx.slot, tx.blockTime ?? null);
    }
    await this.prisma.indexerCursor.upsert({
      where: { programId: pid.toBase58() },
      create: { programId: pid.toBase58(), lastSignature: sigs[sigs.length - 1].signature },
      update: { lastSignature: sigs[sigs.length - 1].signature },
    });
  }

  private async ingest(signature: string, logs: string[], slot: number, blockTime?: number | null) {
    const events = this.solana.parseEvents(logs);
    for (const e of events) {
      if (e.name !== 'paymentSettled' && e.name !== 'PaymentSettled') continue;
      const hashHex = Buffer.from(e.data.contextHash as number[]).toString('hex');
      const match = await this.prisma.payment.findFirst({
        where: { contextHash: hashHex },
        orderBy: { createdAt: 'desc' },
      });
      if (match) {
        await this.prisma.payment.update({
          where: { id: match.id },
          data: {
            onchainConfirmed: true,
            signature: match.signature || signature,
            slot: BigInt(slot),
            blockTime: blockTime != null ? BigInt(blockTime) : match.blockTime || undefined,
          },
        });
      }
    }
  }
}
