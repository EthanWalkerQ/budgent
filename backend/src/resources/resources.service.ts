import { BadRequestException, Injectable } from '@nestjs/common';
import { PublicKey } from '@solana/web3.js';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The domain → recipient registry. On-chain enforcement is by recipient PUBKEY; this maps
 * the human context (a domain / resource) to the address the agent actually pays, and is
 * how the console's domain-based allow/block lists become on-chain address lists.
 */
@Injectable()
export class ResourcesService {
  constructor(private prisma: PrismaService) {}

  async upsert(vaultId: string, dto: { domain: string; recipient: string; label?: string; url?: string; priceUi?: number }) {
    try {
      new PublicKey(dto.recipient);
    } catch {
      throw new BadRequestException('invalid recipient address');
    }
    if (!dto.domain) throw new BadRequestException('domain is required');
    return this.prisma.resource.upsert({
      where: { vaultId_domain: { vaultId, domain: dto.domain } },
      create: { vaultId, domain: dto.domain, recipient: dto.recipient, label: dto.label, url: dto.url, priceUi: dto.priceUi },
      update: { recipient: dto.recipient, label: dto.label, url: dto.url, priceUi: dto.priceUi },
    });
  }

  async list(vaultId: string) {
    return this.prisma.resource.findMany({ where: { vaultId }, orderBy: { domain: 'asc' } });
  }

  async remove(vaultId: string, domain: string) {
    await this.prisma.resource.deleteMany({ where: { vaultId, domain } });
    return { removed: true };
  }

  async resolve(vaultId: string, domain: string) {
    return this.prisma.resource.findUnique({ where: { vaultId_domain: { vaultId, domain } } });
  }
}
