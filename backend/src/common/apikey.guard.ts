import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { sha256Hex } from './units';

const MAX_SKEW_SECONDS = 300;

/**
 * Agent auth for the payment API. Two accepted schemes:
 *
 *   1. HMAC (replay-protected, recommended for autonomous agents):
 *        X-Budgent-Key:       <keyId>
 *        X-Budgent-Timestamp: <unix seconds>
 *        X-Budgent-Signature: hex( HMAC_SHA256( hmacSecret, `${ts}.${METHOD}.${path}.${rawBody}` ) )
 *
 *   2. Bearer secret (simple): Authorization: Bearer <secret>  (matched against secretHash)
 *
 * On success, attaches req.apiKey and req.vaultId.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const keyId = req.headers['x-budgent-key'] as string | undefined;

    if (keyId) return this.verifyHmac(req, keyId);

    const auth = String(req.headers['authorization'] || '');
    if (auth.startsWith('Bearer ')) return this.verifyBearer(req, auth.slice(7));

    throw new UnauthorizedException('agent api key required');
  }

  private async load(keyId: string) {
    const key = await this.prisma.apiKey.findUnique({ where: { keyId } });
    if (!key || key.revokedAt) throw new UnauthorizedException('unknown or revoked api key');
    return key;
  }

  private async verifyHmac(req: any, keyId: string): Promise<boolean> {
    const ts = String(req.headers['x-budgent-timestamp'] || '');
    const sig = String(req.headers['x-budgent-signature'] || '');
    if (!ts || !sig) throw new UnauthorizedException('missing hmac headers');
    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(skew) || skew > MAX_SKEW_SECONDS) throw new UnauthorizedException('timestamp skew too large');

    const key = await this.load(keyId);
    // Sign over the EXACT bytes sent: the raw body, or '' when there is none (e.g. GET).
    const raw = req.rawBody && req.rawBody.length ? req.rawBody.toString('utf8') : '';
    const base = `${ts}.${req.method}.${req.path}.${raw}`;
    const expected = createHmac('sha256', key.hmacSecret).update(base).digest('hex');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new UnauthorizedException('invalid signature');
    }
    req.apiKey = key;
    req.vaultId = key.vaultId;
    return true;
  }

  private async verifyBearer(req: any, secret: string): Promise<boolean> {
    const hash = sha256Hex(secret);
    // keyId is embedded as prefix bk_..._<random>; look up by hash via scan-free unique index on secretHash is not set,
    // so resolve through keyId prefix if provided, else search. We store secretHash; match by hashing.
    const candidates = await this.prisma.apiKey.findMany({ where: { secretHash: hash, revokedAt: null } });
    if (candidates.length !== 1) throw new UnauthorizedException('invalid api key');
    req.apiKey = candidates[0];
    req.vaultId = candidates[0].vaultId;
    return true;
  }
}
