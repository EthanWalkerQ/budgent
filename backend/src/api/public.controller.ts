import { Controller, Get } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { SolanaService } from '../solana/solana.service';
import idl from '../solana/idl/budgent_vault.json';

@Controller()
export class PublicController {
  constructor(private solana: SolanaService, private cfg: ConfigService) {}

  @Get('health')
  health() {
    return { ok: true, cluster: 'mainnet-beta', programId: this.solana.programId.toBase58(), time: new Date().toISOString() };
  }

  @Get('v1/program')
  program() {
    const i: any = idl;
    let verification: any = { verified: false, note: 'run scripts/verify.sh' };
    const depPath = join(this.cfg.get<string>('KEYSTORE_DIR') || '../.keys', 'deployment.json');
    if (existsSync(depPath)) {
      try {
        verification = JSON.parse(readFileSync(depPath, 'utf8'));
      } catch {}
    }
    return {
      programId: this.solana.programId.toBase58(),
      name: i.metadata?.name || 'budgent_vault',
      version: i.metadata?.version,
      instructions: i.instructions.map((x: any) => x.name),
      events: (i.events || []).map((x: any) => x.name),
      explorer: `https://solscan.io/account/${this.solana.programId.toBase58()}`,
      verification,
    };
  }
}
