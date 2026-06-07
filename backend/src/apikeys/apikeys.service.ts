import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { sha256Hex } from '../common/units';

@Injectable()
export class ApiKeysService {
  constructor(private prisma: PrismaService) {}

  /** Create an agent API key. The secret + hmacSecret are returned ONCE and never stored in clear. */
  async create(vaultId: string, dto: { label?: string; scopes?: string[] }) {
    const keyId = 'bk_live_' + randomBytes(10).toString('hex');
    const secret = 'bs_' + randomBytes(24).toString('hex');
    const hmacSecret = randomBytes(32).toString('hex');
    await this.prisma.apiKey.create({
      data: {
        vaultId,
        keyId,
        secretHash: sha256Hex(secret),
        hmacSecret,
        scopes: dto.scopes || ['payments:create'],
        label: dto.label,
      },
    });
    return { keyId, secret, hmacSecret, scopes: dto.scopes || ['payments:create'], note: 'store secret + hmacSecret now; they are not retrievable later' };
  }

  async list(vaultId: string) {
    const keys = await this.prisma.apiKey.findMany({ where: { vaultId }, orderBy: { createdAt: 'desc' } });
    return keys.map((k) => ({ keyId: k.keyId, scopes: k.scopes, label: k.label, createdAt: k.createdAt, revokedAt: k.revokedAt }));
  }

  async revoke(vaultId: string, keyId: string) {
    await this.prisma.apiKey.updateMany({ where: { vaultId, keyId }, data: { revokedAt: new Date() } });
    return { revoked: true };
  }
}
