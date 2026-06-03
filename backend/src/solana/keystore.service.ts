import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@solana/web3.js';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Encrypted-at-rest keystore for delegate (agent) keys, plus the owner keypair loader.
 *
 * Delegate secrets are sealed with AES-256-GCM under KEYSTORE_SECRET and written to the
 * keystore dir. In production this maps onto a KMS/HSM/TEE; the interface (generate / load
 * by ref) is the same. The owner key is the CLI keypair file (also used for deploy).
 */
@Injectable()
export class KeystoreService {
  private readonly log = new Logger('Keystore');
  private readonly dir: string;
  private readonly key: Buffer;

  constructor(private cfg: ConfigService) {
    this.dir = cfg.get<string>('KEYSTORE_DIR') || '../.keys';
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const secret = cfg.get<string>('KEYSTORE_SECRET');
    if (!secret) throw new Error('KEYSTORE_SECRET is required');
    this.key = createHash('sha256').update(secret).digest(); // 32 bytes
  }

  loadOwner(): Keypair {
    const path = this.cfg.get<string>('OWNER_KEYPAIR');
    if (!path) throw new Error('OWNER_KEYPAIR is required');
    return this.loadKeypairFile(path);
  }

  loadKeypairFile(path: string): Keypair {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }

  /** Generate a fresh delegate key, seal it, and return a ref + the keypair. */
  generateDelegate(label: string): { ref: string; keypair: Keypair } {
    const keypair = Keypair.generate();
    const ref = `delegate-${keypair.publicKey.toBase58().slice(0, 8)}-${Date.now()}`;
    this.seal(ref, keypair.secretKey, label);
    return { ref, keypair };
  }

  loadDelegate(ref: string): Keypair {
    const secret = this.unseal(ref);
    return Keypair.fromSecretKey(secret);
  }

  private seal(ref: string, secret: Uint8Array, label: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = {
      v: 1,
      label,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ct.toString('base64'),
    };
    writeFileSync(this.path(ref), JSON.stringify(blob), { mode: 0o600 });
  }

  private unseal(ref: string): Uint8Array {
    const blob = JSON.parse(readFileSync(this.path(ref), 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]);
    return Uint8Array.from(pt);
  }

  private path(ref: string): string {
    return join(this.dir, `${ref}.enc.json`);
  }
}
