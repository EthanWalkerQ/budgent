import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { SolanaModule } from './solana/solana.module';
import { PolicyModule } from './policy/policy.module';
import { VaultsService } from './vaults/vaults.service';
import { PaymentsService } from './payments/payments.service';
import { LedgerService } from './ledger/ledger.service';
import { ResourcesService } from './resources/resources.service';
import { ApiKeysService } from './apikeys/apikeys.service';
import { IndexerService } from './indexer/indexer.service';
import { AdminGuard } from './common/admin.guard';
import { ApiKeyGuard } from './common/apikey.guard';
import { AdminController } from './api/admin.controller';
import { AgentController } from './api/agent.controller';
import { PublicController } from './api/public.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    PrismaModule,
    RedisModule,
    SolanaModule,
    PolicyModule,
  ],
  controllers: [AdminController, AgentController, PublicController],
  providers: [
    VaultsService,
    PaymentsService,
    LedgerService,
    ResourcesService,
    ApiKeysService,
    IndexerService,
    AdminGuard,
    ApiKeyGuard,
  ],
})
export class AppModule {}
