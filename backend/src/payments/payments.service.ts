import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublicKey } from '@solana/web3.js';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SolanaService } from '../solana/solana.service';
import { PolicyService } from '../policy/policy.service';
import { VaultsService } from '../vaults/vaults.service';
import { contextHash, NATIVE_MINT_SENTINEL, toBaseUnits, toUi } from '../common/units';

export interface CreatePaymentDto {
  idempotencyKey?: string;
  amount: number;
  recipient?: string; // direct pubkey
  domain?: string; // resolved via the resource registry if recipient omitted
  url?: string;
  resource?: string;
  taskId?: string;
  model?: 'PUSH' | 'INVOICE';
  metadata?: Record<string, any>;
}

@Injectable()
export class PaymentsService {
  private readonly log = new Logger('Payments');

  constructor(
    private prisma: PrismaService,
    private solana: SolanaService,
    private policy: PolicyService,
    private vaults: VaultsService,
    private cfg: ConfigService,
  ) {}

  private enforceOnchainReverts(): boolean {
    return String(this.cfg.get('ENFORCE_ONCHAIN_REVERTS')) !== 'false';
  }

  async createAndExecute(vaultId: string, dto: CreatePaymentDto) {
    const vault = await this.vaults.getOrThrow(vaultId);
    const idem = dto.idempotencyKey || randomUUID();

    // resolve recipient (direct or via domain registry)
    let recipient = dto.recipient;
    let domain = dto.domain || '';
    if (!recipient) {
      if (!domain) throw new BadRequestException('recipient or domain is required');
      const res = await this.prisma.resource.findUnique({ where: { vaultId_domain: { vaultId, domain } } });
      if (!res) throw new UnprocessableEntityException(`unknown domain "${domain}" — register it as a resource first`);
      recipient = res.recipient;
      if (!dto.url && res.url) dto.url = res.url;
      if (!dto.resource && res.label) dto.resource = res.label;
    }
    try {
      new PublicKey(recipient);
    } catch {
      throw new BadRequestException('invalid recipient address');
    }
    if (!domain) domain = recipient;

    const ctx = {
      domain,
      url: dto.url || '',
      resource: dto.resource || '',
      taskId: dto.taskId || '',
      ...(dto.metadata || {}),
    };
    const ch = contextHash(ctx);
    const amountBase = toBaseUnits(dto.amount, vault.decimals);

    // create the ledger row first — DB uniqueness is the idempotency lock + double-submit guard
    let payment;
    try {
      payment = await this.prisma.payment.create({
        data: {
          vaultId,
          idempotencyKey: idem,
          model: (dto.model as any) || 'PUSH',
          status: 'CREATED',
          amountBase,
          amountUi: toUi(amountBase, vault.decimals),
          asset: vault.asset,
          decimals: vault.decimals,
          recipient,
          domain,
          url: dto.url || '',
          resource: dto.resource || '',
          taskId: dto.taskId || '',
          contextHash: ch.hex,
          contextJson: ctx as Prisma.InputJsonValue,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const existing = await this.prisma.payment.findUnique({
          where: { vaultId_idempotencyKey: { vaultId, idempotencyKey: idem } },
        });
        if (existing) return this.view(existing);
        throw new ConflictException('duplicate idempotency key in flight');
      }
      throw e;
    }

    // evaluate against fresh chain state
    const pda = new PublicKey(vault.vaultPda);
    const state = await this.solana.fetchVault(pda);
    if (!state) {
      await this.fail(payment.id, 'vault not found on-chain');
      return this.view(await this.get(payment.id));
    }
    const available = await this.solana.vaultBalance(pda, new PublicKey(vault.mint));
    const nowSec = Math.floor(Date.now() / 1000);
    const verdict = this.policy.evaluate(state, available, recipient, amountBase, nowSec, {
      decimals: vault.decimals,
      asset: vault.asset,
    });

    const memo = `budgent:${ch.hex}`;
    const delegate = this.vaults.delegateFor(vault.delegateKeyRef!);
    const ownerPk = new PublicKey(vault.owner);
    const isNative = vault.mint === NATIVE_MINT_SENTINEL;

    if (verdict.verdict === 'HELD') {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'HELD', reason: verdict.reason } });
      await this.vaults.audit(vaultId, 'payment.held', delegate.publicKey.toBase58(), { id: payment.id, amount: dto.amount, domain });
      return { ...(await this.view(await this.get(payment.id))), ruleResults: verdict.ruleResults };
    }

    if (verdict.verdict === 'REVERT') {
      if (!this.enforceOnchainReverts()) {
        await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'REVERTED', reason: verdict.reason } });
        return { ...(await this.view(await this.get(payment.id))), ruleResults: verdict.ruleResults };
      }
      // submit anyway (skipPreflight) so the NETWORK records the real revert
      const res = isNative
        ? await this.solana.paySol({ vault: pda, delegate, recipient: new PublicKey(recipient), owner: ownerPk, amount: amountBase, contextHashBytes: ch.bytes, memo, forceRevert: true })
        : await this.solana.paySpl({ vault: pda, mint: new PublicKey(vault.mint), delegate, recipient: new PublicKey(recipient), owner: ownerPk, amount: amountBase, contextHashBytes: ch.bytes, memo, forceRevert: true });
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'REVERTED', reason: verdict.reason, signature: res.signature, slot: res.slot ?? undefined, blockTime: res.blockTime ?? undefined, feeLamports: res.feeLamports ?? undefined },
      });
      await this.vaults.audit(vaultId, 'payment.reverted', delegate.publicKey.toBase58(), { id: payment.id, reason: verdict.reason }, res.signature);
      return { ...(await this.view(await this.get(payment.id))), ruleResults: verdict.ruleResults };
    }

    // ALLOW → submit normally
    const res = isNative
      ? await this.solana.paySol({ vault: pda, delegate, recipient: new PublicKey(recipient), owner: ownerPk, amount: amountBase, contextHashBytes: ch.bytes, memo })
      : await this.solana.paySpl({ vault: pda, mint: new PublicKey(vault.mint), delegate, recipient: new PublicKey(recipient), owner: ownerPk, amount: amountBase, contextHashBytes: ch.bytes, memo });

    if (res.err || !res.signature) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'REVERTED', reason: this.reasonFromError(res.err) || verdict.reason || 'reverted by network', signature: res.signature, slot: res.slot ?? undefined, blockTime: res.blockTime ?? undefined, feeLamports: res.feeLamports ?? undefined },
      });
      await this.vaults.audit(vaultId, 'payment.reverted', delegate.publicKey.toBase58(), { id: payment.id, err: res.err }, res.signature);
    } else {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'SETTLED', reason: '', signature: res.signature, slot: res.slot ?? undefined, blockTime: res.blockTime ?? undefined, feeLamports: res.feeLamports ?? undefined },
      });
      await this.vaults.audit(vaultId, 'payment.settled', delegate.publicKey.toBase58(), { id: payment.id, amount: dto.amount, domain, recipient }, res.signature);
    }
    // refresh cached balance/spend
    this.vaults.syncFromChain(vaultId).catch(() => {});
    return { ...(await this.view(await this.get(payment.id))), ruleResults: verdict.ruleResults };
  }

  async approveHeld(paymentId: string) {
    const payment = await this.get(paymentId);
    if (payment.status !== 'HELD') throw new BadRequestException('payment is not held');
    const vault = await this.vaults.getOrThrow(payment.vaultId);
    const pda = new PublicKey(vault.vaultPda);
    const state = await this.solana.fetchVault(pda);
    if (!state) { await this.fail(paymentId, 'vault not found on-chain'); return this.view(await this.get(paymentId)); }
    const available = await this.solana.vaultBalance(pda, new PublicKey(vault.mint));
    const nowSec = Math.floor(Date.now() / 1000);
    const verdict = this.policy.evaluate(state, available, payment.recipient, BigInt(payment.amountBase.toString()), nowSec, {
      decimals: vault.decimals,
      asset: vault.asset,
    });

    const delegate = this.vaults.delegateFor(vault.delegateKeyRef!);
    const owner = this.vaults.owner();
    const memo = `budgent:${payment.contextHash}`;
    const isNative = vault.mint === NATIVE_MINT_SENTINEL;
    const amountBase = BigInt(payment.amountBase.toString());
    const ch = payment.contextHash;
    const bytes = Array.from(Buffer.from(ch, 'hex'));

    // a held payment can still revert if state changed (balance dropped, delegate revoked, etc.)
    if (verdict.verdict === 'REVERT') {
      const res = isNative
        ? await this.solana.paySol({ vault: pda, delegate, recipient: new PublicKey(payment.recipient), owner: owner.publicKey, amount: amountBase, contextHashBytes: bytes, memo, forceRevert: this.enforceOnchainReverts() })
        : await this.solana.paySpl({ vault: pda, mint: new PublicKey(vault.mint), delegate, recipient: new PublicKey(payment.recipient), owner: owner.publicKey, amount: amountBase, contextHashBytes: bytes, memo, forceRevert: this.enforceOnchainReverts() });
      await this.prisma.payment.update({ where: { id: paymentId }, data: { status: 'REVERTED', reason: `${verdict.reason} (at co-sign)`, signature: res.signature, slot: res.slot ?? undefined, blockTime: res.blockTime ?? undefined, feeLamports: res.feeLamports ?? undefined } });
      await this.vaults.audit(payment.vaultId, 'payment.cosign.reverted', owner.publicKey.toBase58(), { id: paymentId, reason: verdict.reason }, res.signature);
      return this.view(await this.get(paymentId));
    }

    // owner co-signs the transfer
    const res = isNative
      ? await this.solana.paySol({ vault: pda, delegate, recipient: new PublicKey(payment.recipient), owner: owner.publicKey, ownerSigner: owner, amount: amountBase, contextHashBytes: bytes, memo })
      : await this.solana.paySpl({ vault: pda, mint: new PublicKey(vault.mint), delegate, recipient: new PublicKey(payment.recipient), owner: owner.publicKey, ownerSigner: owner, amount: amountBase, contextHashBytes: bytes, memo });

    if (res.err || !res.signature) {
      await this.prisma.payment.update({ where: { id: paymentId }, data: { status: 'REVERTED', reason: this.reasonFromError(res.err) || 'reverted by network (at co-sign)', signature: res.signature, slot: res.slot ?? undefined, blockTime: res.blockTime ?? undefined } });
    } else {
      await this.prisma.payment.update({ where: { id: paymentId }, data: { status: 'APPROVED', reason: 'approved by owner', signature: res.signature, slot: res.slot ?? undefined, blockTime: res.blockTime ?? undefined, feeLamports: res.feeLamports ?? undefined } });
      await this.vaults.audit(payment.vaultId, 'payment.approved', owner.publicKey.toBase58(), { id: paymentId }, res.signature);
    }
    this.vaults.syncFromChain(payment.vaultId).catch(() => {});
    return this.view(await this.get(paymentId));
  }

  async denyHeld(paymentId: string) {
    const payment = await this.get(paymentId);
    if (payment.status !== 'HELD') throw new BadRequestException('payment is not held');
    await this.prisma.payment.update({ where: { id: paymentId }, data: { status: 'DENIED', reason: 'denied by owner' } });
    await this.vaults.audit(payment.vaultId, 'payment.denied', this.vaults.owner().publicKey.toBase58(), { id: paymentId });
    return this.view(await this.get(paymentId));
  }

  async get(id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('payment not found');
    return p;
  }

  private async fail(id: string, reason: string) {
    await this.prisma.payment.update({ where: { id }, data: { status: 'FAILED', reason } });
  }

  private reasonFromError(err: any): string | null {
    if (!err) return null;
    const s = typeof err === 'string' ? err : JSON.stringify(err);
    const m = s.match(/Error Message: ([^"]+)/) || s.match(/"([^"]*?(revoked|blocklist|allowlist|limit|insufficient|co-sign)[^"]*?)"/i);
    return m ? m[1] : null;
  }

  view(p: any) {
    return {
      id: p.id,
      idempotencyKey: p.idempotencyKey,
      status: p.status,
      reason: p.reason,
      amount: p.amountUi,
      asset: p.asset,
      recipient: p.recipient,
      context: { domain: p.domain, url: p.url, resource: p.resource, taskId: p.taskId },
      contextHash: p.contextHash,
      signature: p.signature,
      slot: p.slot ? Number(p.slot) : null,
      blockTime: p.blockTime ? Number(p.blockTime) : null,
      feeLamports: p.feeLamports ? Number(p.feeLamports) : null,
      onchainConfirmed: p.onchainConfirmed,
      explorer: p.signature ? `https://solscan.io/tx/${p.signature}` : null,
      createdAt: p.createdAt,
    };
  }
}
