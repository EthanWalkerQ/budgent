import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, PublicKey } from '@solana/web3.js';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SolanaService, VaultState } from '../solana/solana.service';
import { KeystoreService } from '../solana/keystore.service';
import { resolveAsset } from '../common/assets';
import { NATIVE_MINT_SENTINEL, toBaseUnits, toUi } from '../common/units';

const DELEGATE_FUND_LAMPORTS = 30_000_000n; // ~0.03 SOL for the agent's tx fees + ATA rents

@Injectable()
export class VaultsService {
  private readonly log = new Logger('Vaults');

  constructor(
    private prisma: PrismaService,
    private solana: SolanaService,
    private keystore: KeystoreService,
    private cfg: ConfigService,
  ) {}

  owner(): Keypair {
    return this.keystore.loadOwner();
  }

  delegateFor(ref: string): Keypair {
    return this.keystore.loadDelegate(ref);
  }

  private ensure(res: { err: any; signature: string | null }, what: string) {
    if (res.err) {
      throw new BadRequestException(`${what} failed on-chain: ${JSON.stringify(res.err)}${res.signature ? ` (sig ${res.signature})` : ''}`);
    }
  }

  async create(dto: {
    label?: string;
    asset?: string;
    mint?: string;
    decimals?: number;
    perTx: number;
    daily: number;
    cosign: number;
    fundDelegateSol?: number;
  }) {
    const owner = this.owner();
    const spec = resolveAsset(dto);
    const seedId = BigInt('0x' + randomBytes(7).toString('hex')); // < 2^56, fits u64
    const mint = new PublicKey(spec.mint);

    const { ref, keypair: delegate } = this.keystore.generateDelegate(dto.label || 'agent');

    const initRes = await this.solana.initializeVault({
      owner,
      vaultId: seedId,
      mint,
      perTx: toBaseUnits(dto.perTx, spec.decimals),
      daily: toBaseUnits(dto.daily, spec.decimals),
      cosign: toBaseUnits(dto.cosign, spec.decimals),
      delegate: delegate.publicKey,
    });
    this.ensure(initRes, 'initialize_vault');

    // fund the delegate with a little SOL so the agent can pay its own tx fees + ATA rents
    const fundLamports = dto.fundDelegateSol != null ? toBaseUnits(dto.fundDelegateSol, 9) : DELEGATE_FUND_LAMPORTS;
    if (fundLamports > 0n) {
      const f = await this.solana.fundLamports(owner, delegate.publicKey, fundLamports);
      if (f.err) this.log.warn(`delegate funding failed: ${JSON.stringify(f.err)}`);
    }

    const row = await this.prisma.vault.create({
      data: {
        vaultPda: initRes.vaultPda,
        owner: owner.publicKey.toBase58(),
        seedId,
        mint: spec.mint,
        asset: spec.asset,
        decimals: spec.decimals,
        delegatePubkey: delegate.publicKey.toBase58(),
        delegateKeyRef: ref,
        label: dto.label,
      },
    });
    await this.audit(row.id, 'vault.create', owner.publicKey.toBase58(), { vaultPda: initRes.vaultPda, asset: spec.asset }, initRes.signature);
    return this.syncFromChain(row.id);
  }

  async list() {
    const rows = await this.prisma.vault.findMany({ orderBy: { createdAt: 'desc' } });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async getOrThrow(id: string) {
    const row = await this.prisma.vault.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('vault not found');
    return row;
  }

  /** Read chain state and update cached fields. Chain is authoritative. */
  async syncFromChain(id: string) {
    const row = await this.getOrThrow(id);
    const pda = new PublicKey(row.vaultPda);
    const state = await this.solana.fetchVault(pda);
    if (!state) {
      // vault closed on-chain
      return this.view(row);
    }
    const balance = await this.solana.vaultBalance(pda, new PublicKey(row.mint));
    const updated = await this.prisma.vault.update({
      where: { id },
      data: {
        perTxBase: state.perTxLimit,
        dailyBase: state.dailyLimit,
        cosignBase: state.cosignThreshold,
        delegateActive: state.delegateActive,
        delegatePubkey: state.delegate.toBase58(),
        allowlist: state.allowlist,
        blocklist: state.blocklist,
        windowStart: state.windowStart,
        spentInWindow: state.spentInWindow,
        balanceBase: balance,
        totalPaidBase: state.totalPaid,
        paymentCount: state.paymentCount,
        policySyncedAt: new Date(),
      },
    });
    return this.view(updated);
  }

  async setPolicy(id: string, dto: { perTx: number; daily: number; cosign: number }) {
    const row = await this.getOrThrow(id);
    const res = await this.solana.setPolicy(
      this.owner(),
      new PublicKey(row.vaultPda),
      toBaseUnits(dto.perTx, row.decimals),
      toBaseUnits(dto.daily, row.decimals),
      toBaseUnits(dto.cosign, row.decimals),
    );
    this.ensure(res, 'set_policy');
    await this.audit(id, 'vault.set_policy', row.owner, dto, res.signature);
    return this.syncFromChain(id);
  }

  async setDelegateActive(id: string, active: boolean) {
    const row = await this.getOrThrow(id);
    const res = await this.solana.setDelegateActive(this.owner(), new PublicKey(row.vaultPda), active);
    this.ensure(res, 'set_delegate_active');
    await this.audit(id, active ? 'vault.delegate.activate' : 'vault.delegate.revoke', row.owner, {}, res.signature);
    return this.syncFromChain(id);
  }

  async resetWindow(id: string) {
    const row = await this.getOrThrow(id);
    const res = await this.solana.resetWindow(this.owner(), new PublicKey(row.vaultPda));
    this.ensure(res, 'reset_window');
    await this.audit(id, 'vault.reset_window', row.owner, {}, res.signature);
    return this.syncFromChain(id);
  }

  /** kind: 0=allow, 1=block. addr is a recipient pubkey. */
  async manageList(id: string, kind: 0 | 1, addr: string, add: boolean) {
    const row = await this.getOrThrow(id);
    let pub: PublicKey;
    try {
      pub = new PublicKey(addr);
    } catch {
      throw new BadRequestException('invalid recipient address');
    }
    const res = await this.solana.manageList(this.owner(), new PublicKey(row.vaultPda), kind, pub, add);
    this.ensure(res, 'manage_list');
    await this.audit(id, 'vault.manage_list', row.owner, { kind, addr, add }, res.signature);
    return this.syncFromChain(id);
  }

  async deposit(id: string, amountUi: number) {
    const row = await this.getOrThrow(id);
    const owner = this.owner();
    const base = toBaseUnits(amountUi, row.decimals);
    const res = row.mint === NATIVE_MINT_SENTINEL
      ? await this.solana.depositSol(owner, new PublicKey(row.vaultPda), base)
      : await this.solana.depositSpl(owner, new PublicKey(row.vaultPda), new PublicKey(row.mint), base);
    this.ensure(res, 'deposit');
    await this.audit(id, 'vault.deposit', row.owner, { amountUi }, res.signature);
    return this.syncFromChain(id);
  }

  async withdraw(id: string, amountUi: number | 'all') {
    const row = await this.getOrThrow(id);
    const owner = this.owner();
    const pda = new PublicKey(row.vaultPda);
    const balance = await this.solana.vaultBalance(pda, new PublicKey(row.mint));
    const base = amountUi === 'all' ? balance : toBaseUnits(amountUi, row.decimals);
    if (base <= 0n) throw new BadRequestException('nothing to withdraw');
    const res = row.mint === NATIVE_MINT_SENTINEL
      ? await this.solana.withdrawSol(owner, pda, base)
      : await this.solana.withdrawSpl(owner, pda, new PublicKey(row.mint), base);
    this.ensure(res, 'withdraw');
    await this.audit(id, 'vault.withdraw', row.owner, { amountUi: amountUi === 'all' ? toUi(base, row.decimals) : amountUi }, res.signature);
    return this.syncFromChain(id);
  }

  async close(id: string) {
    const row = await this.getOrThrow(id);
    const owner = this.owner();
    const pda = new PublicKey(row.vaultPda);
    const res = row.mint === NATIVE_MINT_SENTINEL
      ? await this.solana.closeVaultSol(owner, pda)
      : await this.solana.closeVaultSpl(owner, pda, new PublicKey(row.mint));
    this.ensure(res, 'close_vault');
    await this.audit(id, 'vault.close', row.owner, {}, res.signature);
    await this.prisma.vault.update({ where: { id }, data: { balanceBase: 0n, delegateActive: false } });
    return { closed: true, signature: res.signature };
  }

  async view(row: any) {
    return {
      id: row.id,
      vaultPda: row.vaultPda,
      owner: row.owner,
      seedId: row.seedId.toString(),
      asset: row.asset,
      mint: row.mint,
      decimals: row.decimals,
      delegate: row.delegatePubkey,
      delegateActive: row.delegateActive,
      label: row.label,
      policy: {
        perTx: toUi(row.perTxBase, row.decimals),
        daily: toUi(row.dailyBase, row.decimals),
        cosign: toUi(row.cosignBase, row.decimals),
        allowlist: row.allowlist,
        blocklist: row.blocklist,
      },
      state: {
        balance: toUi(row.balanceBase, row.decimals),
        spentInWindow: toUi(row.spentInWindow, row.decimals),
        windowStart: Number(row.windowStart),
        totalPaid: toUi(row.totalPaidBase, row.decimals),
        paymentCount: Number(row.paymentCount),
      },
      explorer: `https://solscan.io/account/${row.vaultPda}`,
      policySyncedAt: row.policySyncedAt,
      createdAt: row.createdAt,
    };
  }

  async audit(vaultId: string | null, action: string, actor: string, detail: any, signature?: string | null) {
    await this.prisma.auditLog.create({
      data: { vaultId, action, actor, detail, signature: signature || null },
    });
  }
}
