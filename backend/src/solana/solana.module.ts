import { Global, Module } from '@nestjs/common';
import { SolanaService } from './solana.service';
import { KeystoreService } from './keystore.service';

@Global()
@Module({
  providers: [SolanaService, KeystoreService],
  exports: [SolanaService, KeystoreService],
})
export class SolanaModule {}
