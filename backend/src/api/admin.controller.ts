import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard } from '../common/admin.guard';
import { VaultsService } from '../vaults/vaults.service';
import { PaymentsService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { ResourcesService } from '../resources/resources.service';
import { ApiKeysService } from '../apikeys/apikeys.service';

@UseGuards(AdminGuard)
@Controller('v1/admin')
export class AdminController {
  constructor(
    private vaults: VaultsService,
    private payments: PaymentsService,
    private ledger: LedgerService,
    private resources: ResourcesService,
    private apikeys: ApiKeysService,
  ) {}

  // ----- vault lifecycle -----
  @Post('vaults')
  createVault(@Body() body: any) {
    return this.vaults.create(body);
  }
  @Get('vaults')
  listVaults() {
    return this.vaults.list();
  }
  @Get('vaults/:id')
  getVault(@Param('id') id: string) {
    return this.vaults.syncFromChain(id);
  }
  @Post('vaults/:id/policy')
  setPolicy(@Param('id') id: string, @Body() body: any) {
    return this.vaults.setPolicy(id, body);
  }
  @Post('vaults/:id/delegate/active')
  setDelegateActive(@Param('id') id: string, @Body() body: any) {
    return this.vaults.setDelegateActive(id, body.active !== false);
  }
  @Post('vaults/:id/reset-window')
  resetWindow(@Param('id') id: string) {
    return this.vaults.resetWindow(id);
  }
  @Post('vaults/:id/allow')
  allow(@Param('id') id: string, @Body() body: any) {
    return this.vaults.manageList(id, 0, body.address, body.add !== false);
  }
  @Post('vaults/:id/block')
  block(@Param('id') id: string, @Body() body: any) {
    return this.vaults.manageList(id, 1, body.address, body.add !== false);
  }
  @Post('vaults/:id/deposit')
  deposit(@Param('id') id: string, @Body() body: any) {
    return this.vaults.deposit(id, Number(body.amount));
  }
  @Post('vaults/:id/withdraw')
  withdraw(@Param('id') id: string, @Body() body: any) {
    return this.vaults.withdraw(id, body.amount === 'all' ? 'all' : Number(body.amount));
  }
  @Post('vaults/:id/close')
  close(@Param('id') id: string) {
    return this.vaults.close(id);
  }

  // ----- payments (console "run agent" + co-sign) -----
  @Post('vaults/:id/pay')
  pay(@Param('id') id: string, @Body() body: any) {
    return this.payments.createAndExecute(id, body);
  }
  @Post('payments/:id/approve')
  approve(@Param('id') id: string) {
    return this.payments.approveHeld(id);
  }
  @Post('payments/:id/deny')
  deny(@Param('id') id: string) {
    return this.payments.denyHeld(id);
  }
  @Get('payments/:id')
  async getPayment(@Param('id') id: string) {
    return this.payments.view(await this.payments.get(id));
  }

  // ----- ledger -----
  @Get('vaults/:id/ledger')
  ledgerList(@Param('id') id: string, @Query('status') status?: string, @Query('taskId') taskId?: string, @Query('domain') domain?: string) {
    return this.ledger.list(id, { status, taskId, domain });
  }
  @Get('vaults/:id/contexts')
  contexts(@Param('id') id: string) {
    return this.ledger.contexts(id);
  }
  @Get('vaults/:id/held')
  held(@Param('id') id: string) {
    return this.ledger.held(id);
  }
  @Get('vaults/:id/export')
  async export(@Param('id') id: string, @Query('fmt') fmt: 'csv' | 'json' = 'json', @Res() res: Response) {
    const out = await this.ledger.export(id, fmt === 'csv' ? 'csv' : 'json');
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  }

  // ----- resources (domain -> recipient) -----
  @Post('vaults/:id/resources')
  upsertResource(@Param('id') id: string, @Body() body: any) {
    return this.resources.upsert(id, body);
  }
  @Get('vaults/:id/resources')
  listResources(@Param('id') id: string) {
    return this.resources.list(id);
  }
  @Delete('vaults/:id/resources/:domain')
  removeResource(@Param('id') id: string, @Param('domain') domain: string) {
    return this.resources.remove(id, domain);
  }

  // ----- api keys -----
  @Post('vaults/:id/apikeys')
  createKey(@Param('id') id: string, @Body() body: any) {
    return this.apikeys.create(id, body || {});
  }
  @Get('vaults/:id/apikeys')
  listKeys(@Param('id') id: string) {
    return this.apikeys.list(id);
  }
  @Post('vaults/:id/apikeys/:keyId/revoke')
  revokeKey(@Param('id') id: string, @Param('keyId') keyId: string) {
    return this.apikeys.revoke(id, keyId);
  }
}
