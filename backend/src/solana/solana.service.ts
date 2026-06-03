import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as anchor from '@coral-xyz/anchor';
import { BN } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Commitment,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import idl from './idl/budgent_vault.json';
import { NATIVE_MINT_SENTINEL } from '../common/units';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export interface SendResult {
  signature: string | null;
  slot: number | null;
  blockTime: number | null;
  feeLamports: number | null;
  err: any | null;
  logs?: string[] | null;
}

export interface VaultState {
  owner: PublicKey;
  vaultId: bigint;
  delegate: PublicKey;
  mint: PublicKey;
  bump: number;
  delegateActive: boolean;
  perTxLimit: bigint;
  dailyLimit: bigint;
  cosignThreshold: bigint;
  windowStart: bigint;
  spentInWindow: bigint;
  allowlist: string[];
  blocklist: string[];
  totalPaid: bigint;
  paymentCount: bigint;
}

@Injectable()
export class SolanaService {
  private readonly log = new Logger('Solana');
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly commitment: Commitment;
  readonly wsUrl: string;
  private readonly program: anchor.Program;

  constructor(private cfg: ConfigService) {
    const rpc = cfg.get<string>('RPC_URL')!;
    this.wsUrl = cfg.get<string>('WS_URL')!;
    this.commitment = (cfg.get<string>('COMMITMENT') as Commitment) || 'confirmed';
    this.connection = new Connection(rpc, { commitment: this.commitment, wsEndpoint: this.wsUrl });
    this.programId = new PublicKey((idl as any).address);
    const provider = new anchor.AnchorProvider(
      this.connection,
      new anchor.Wallet(Keypair.generate()),
      { commitment: this.commitment, skipPreflight: false },
    );
    this.program = new anchor.Program(idl as anchor.Idl, provider);
  }

  // ---------- PDA / ATA helpers ----------

  u64le(v: bigint | number): Buffer {
    return new BN(v.toString()).toArrayLike(Buffer, 'le', 8);
  }

  vaultPda(owner: PublicKey, vaultId: bigint): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), owner.toBuffer(), this.u64le(vaultId)],
      this.programId,
    );
  }

  ata(mint: PublicKey, owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(mint, owner, true);
  }

  isNative(mint: PublicKey | string): boolean {
    const s = typeof mint === 'string' ? mint : mint.toBase58();
    return s === NATIVE_MINT_SENTINEL;
  }

  memoIx(text: string): TransactionInstruction {
    return new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(text, 'utf8'),
    });
  }

  // ---------- low-level send ----------

  /**
   * Build, sign and submit a transaction. Never throws on an on-chain failure — returns a
   * SendResult whose `err` is populated. Use skipPreflight=true to force a known-failing
   * (policy-violating) tx onto the chain so the network records the real revert.
   */
  async send(
    ixs: TransactionInstruction[],
    signers: Keypair[],
    feePayer: PublicKey,
    opts: { skipPreflight?: boolean; priorityMicroLamports?: number } = {},
  ): Promise<SendResult> {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports ?? 50_000 }));
    for (const ix of ixs) tx.add(ix);
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.commitment);
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayer;
    tx.sign(...signers);

    let signature: string | null = null;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: opts.skipPreflight ?? false,
        maxRetries: 5,
      });
      const conf = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        this.commitment,
      );
      const slot = conf.context?.slot ?? null;
      const meta = await this.fetchTxMeta(signature);
      return {
        signature,
        slot: meta.slot ?? slot,
        blockTime: meta.blockTime,
        feeLamports: meta.fee,
        err: conf.value.err,
        logs: meta.logs,
      };
    } catch (e: any) {
      // preflight failure (no signature) or send error — surface logs if present
      const logs = e?.logs ?? (typeof e?.getLogs === 'function' ? await e.getLogs(this.connection).catch(() => null) : null);
      // SendTransactionError may carry a signature for skipPreflight sends
      const sig = signature ?? e?.signature ?? null;
      return { signature: sig, slot: null, blockTime: null, feeLamports: null, err: e?.message || String(e), logs };
    }
  }

  private async fetchTxMeta(signature: string): Promise<{ slot: number | null; blockTime: number | null; fee: number | null; logs: string[] | null }> {
    for (let i = 0; i < 4; i++) {
      try {
        const tx = await this.connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (tx) {
          return {
            slot: tx.slot ?? null,
            blockTime: tx.blockTime ?? null,
            fee: tx.meta?.fee ?? null,
            logs: tx.meta?.logMessages ?? null,
          };
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 400));
    }
    return { slot: null, blockTime: null, fee: null, logs: null };
  }

  // ---------- reads ----------

  async fetchVault(vaultPda: PublicKey): Promise<VaultState | null> {
    const acc: any = await (this.program.account as any).vault.fetchNullable(vaultPda);
    if (!acc) return null;
    return {
      owner: acc.owner,
      vaultId: BigInt(acc.vaultId.toString()),
      delegate: acc.delegate,
      mint: acc.mint,
      bump: acc.bump,
      delegateActive: acc.delegateActive,
      perTxLimit: BigInt(acc.perTxLimit.toString()),
      dailyLimit: BigInt(acc.dailyLimit.toString()),
      cosignThreshold: BigInt(acc.cosignThreshold.toString()),
      windowStart: BigInt(acc.windowStart.toString()),
      spentInWindow: BigInt(acc.spentInWindow.toString()),
      allowlist: (acc.allowlist as PublicKey[]).map((p) => p.toBase58()),
      blocklist: (acc.blocklist as PublicKey[]).map((p) => p.toBase58()),
      totalPaid: BigInt(acc.totalPaid.toString()),
      paymentCount: BigInt(acc.paymentCount.toString()),
    };
  }

  /** Spendable balance in base units (native: lamports above rent; SPL: vault ATA amount). */
  async vaultBalance(vaultPda: PublicKey, mint: PublicKey): Promise<bigint> {
    if (this.isNative(mint)) {
      const info = await this.connection.getAccountInfo(vaultPda, this.commitment);
      if (!info) return 0n;
      const rentMin = await this.connection.getMinimumBalanceForRentExemption(info.data.length);
      const avail = info.lamports - rentMin;
      return avail > 0 ? BigInt(avail) : 0n;
    }
    const ata = this.ata(mint, vaultPda);
    try {
      const bal = await this.connection.getTokenAccountBalance(ata, this.commitment);
      return BigInt(bal.value.amount);
    } catch {
      return 0n;
    }
  }

  // ---------- owner instructions ----------

  async initializeVault(p: {
    owner: Keypair;
    vaultId: bigint;
    mint: PublicKey; // native sentinel or real mint
    perTx: bigint;
    daily: bigint;
    cosign: bigint;
    delegate: PublicKey; // default pubkey if none
  }): Promise<SendResult & { vaultPda: string }> {
    const [vault] = this.vaultPda(p.owner.publicKey, p.vaultId);
    const ix = await this.program.methods
      .initializeVault(
        new BN(p.vaultId.toString()),
        p.mint,
        new BN(p.perTx.toString()),
        new BN(p.daily.toString()),
        new BN(p.cosign.toString()),
        p.delegate,
      )
      .accountsPartial({ vault, owner: p.owner.publicKey, systemProgram: anchor.web3.SystemProgram.programId })
      .instruction();
    const res = await this.send([ix], [p.owner], p.owner.publicKey);
    return { ...res, vaultPda: vault.toBase58() };
  }

  async setPolicy(owner: Keypair, vault: PublicKey, perTx: bigint, daily: bigint, cosign: bigint): Promise<SendResult> {
    const ix = await this.program.methods
      .setPolicy(new BN(perTx.toString()), new BN(daily.toString()), new BN(cosign.toString()))
      .accountsPartial({ vault, owner: owner.publicKey })
      .instruction();
    return this.send([ix], [owner], owner.publicKey);
  }

  async setDelegate(owner: Keypair, vault: PublicKey, delegate: PublicKey): Promise<SendResult> {
    const ix = await this.program.methods
      .setDelegate(delegate)
      .accountsPartial({ vault, owner: owner.publicKey })
      .instruction();
    return this.send([ix], [owner], owner.publicKey);
  }

  async setDelegateActive(owner: Keypair, vault: PublicKey, active: boolean): Promise<SendResult> {
    const ix = await this.program.methods
      .setDelegateActive(active)
      .accountsPartial({ vault, owner: owner.publicKey })
      .instruction();
    return this.send([ix], [owner], owner.publicKey);
  }

  async manageList(owner: Keypair, vault: PublicKey, kind: number, addr: PublicKey, add: boolean): Promise<SendResult> {
    const ix = await this.program.methods
      .manageList(kind, addr, add)
      .accountsPartial({ vault, owner: owner.publicKey })
      .instruction();
    return this.send([ix], [owner], owner.publicKey);
  }

  async resetWindow(owner: Keypair, vault: PublicKey): Promise<SendResult> {
    const ix = await this.program.methods
      .resetWindow()
      .accountsPartial({ vault, owner: owner.publicKey })
      .instruction();
    return this.send([ix], [owner], owner.publicKey);
  }

  // ---------- deposits ----------

  async depositSol(payer: Keypair, vault: PublicKey, lamports: bigint): Promise<SendResult> {
    const ix = await this.program.methods
      .depositSol(new BN(lamports.toString()))
      .accountsPartial({ vault, depositor: payer.publicKey, systemProgram: anchor.web3.SystemProgram.programId })
      .instruction();
    return this.send([ix], [payer], payer.publicKey);
  }

  async depositSpl(payer: Keypair, vault: PublicKey, mint: PublicKey, amount: bigint): Promise<SendResult> {
    const ix = await this.program.methods
      .depositSpl(new BN(amount.toString()))
      .accountsPartial({
        vault,
        mint,
        vaultAta: this.ata(mint, vault),
        depositor: payer.publicKey,
        depositorAta: this.ata(mint, payer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    return this.send([ix], [payer], payer.publicKey);
  }

  // ---------- pay (agent path) ----------

  async paySol(p: {
    vault: PublicKey;
    delegate: Keypair;
    recipient: PublicKey;
    owner: PublicKey;
    ownerSigner?: Keypair; // present when co-signing
    amount: bigint;
    contextHashBytes: number[];
    memo: string;
    forceRevert?: boolean; // submit even though it will fail, to capture the real on-chain revert
  }): Promise<SendResult> {
    const ix = await this.program.methods
      .paySol(new BN(p.amount.toString()), p.contextHashBytes)
      .accountsPartial({ vault: p.vault, delegate: p.delegate.publicKey, recipient: p.recipient, owner: p.owner })
      .instruction();
    if (p.ownerSigner) this.markSigner(ix, p.owner); // co-sign: owner must sign this tx
    const signers = [p.delegate, ...(p.ownerSigner ? [p.ownerSigner] : [])];
    return this.send([this.memoIx(p.memo), ix], signers, p.delegate.publicKey, {
      skipPreflight: !!p.forceRevert,
    });
  }

  async paySpl(p: {
    vault: PublicKey;
    mint: PublicKey;
    delegate: Keypair;
    recipient: PublicKey;
    owner: PublicKey;
    ownerSigner?: Keypair;
    amount: bigint;
    contextHashBytes: number[];
    memo: string;
    forceRevert?: boolean;
  }): Promise<SendResult> {
    const ix = await this.program.methods
      .paySpl(new BN(p.amount.toString()), p.contextHashBytes)
      .accountsPartial({
        vault: p.vault,
        mint: p.mint,
        vaultAta: this.ata(p.mint, p.vault),
        delegate: p.delegate.publicKey,
        recipient: p.recipient,
        recipientAta: this.ata(p.mint, p.recipient),
        owner: p.owner,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    if (p.ownerSigner) this.markSigner(ix, p.owner); // co-sign: owner must sign this tx
    const signers = [p.delegate, ...(p.ownerSigner ? [p.ownerSigner] : [])];
    return this.send([this.memoIx(p.memo), ix], signers, p.delegate.publicKey, {
      skipPreflight: !!p.forceRevert,
    });
  }

  /** Flip an account's AccountMeta to signer (the program's `owner` is an UncheckedAccount,
   *  so Anchor builds it non-signer; co-sign requires the owner's signature to count). */
  private markSigner(ix: TransactionInstruction, key: PublicKey) {
    const m = ix.keys.find((k) => k.pubkey.equals(key));
    if (m) m.isSigner = true;
  }

  // ---------- owner withdraw / close / sweep (no policy limits) ----------

  async withdrawSol(owner: Keypair, vault: PublicKey, lamports: bigint): Promise<SendResult> {
    const ix = await this.program.methods
      .withdrawSol(new BN(lamports.toString()))
      .accountsPartial({ vault, owner: owner.publicKey })
      .instruction();
    return this.send([ix], [owner], owner.publicKey);
  }

  async withdrawSpl(owner: Keypair, vault: PublicKey, mint: PublicKey, amount: bigint): Promise<SendResult> {
    const ix = await this.program.methods
      .withdrawSpl(new BN(amount.toString()))
      .accountsPartial({
        vault,
        mint,
        vaultAta: this.ata(mint, vault),
        ownerAta: this.ata(mint, owner.publicKey),
        owner: owner.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    return this.send([ix], [owner], owner.publicKey);
  }

  async closeVaultSol(owner: Keypair, vault: PublicKey): Promise<SendResult> {
    const ix = await this.program.methods
      .closeVaultSol()
      .accountsPartial({ vault, owner: owner.publicKey })
      .instruction();
    return this.send([ix], [owner], owner.publicKey);
  }

  async closeVaultSpl(owner: Keypair, vault: PublicKey, mint: PublicKey): Promise<SendResult> {
    const ix = await this.program.methods
      .closeVaultSpl()
      .accountsPartial({
        vault,
        mint,
        vaultAta: this.ata(mint, vault),
        ownerAta: this.ata(mint, owner.publicKey),
        owner: owner.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    return this.send([ix], [owner], owner.publicKey);
  }

  /** Decode budgent program events from a transaction's log messages. */
  parseEvents(logs: string[]): { name: string; data: any }[] {
    try {
      const parser = new anchor.EventParser(this.programId, this.program.coder);
      const out: { name: string; data: any }[] = [];
      for (const e of parser.parseLogs(logs)) out.push({ name: e.name, data: e.data });
      return out;
    } catch {
      return [];
    }
  }

  async fundLamports(from: Keypair, to: PublicKey, lamports: bigint): Promise<SendResult> {
    const ix = anchor.web3.SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: to,
      lamports: Number(lamports),
    });
    return this.send([ix], [from], from.publicKey);
  }
}
