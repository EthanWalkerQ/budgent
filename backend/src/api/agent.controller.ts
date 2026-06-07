import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../common/apikey.guard';
import { PaymentsService } from '../payments/payments.service';
import { VaultsService } from '../vaults/vaults.service';

/**
 * The agent-facing REST API (the "REST, not x402" surface). Authenticated with an API key
 * (HMAC or bearer). The agent never holds the on-chain delegate key — it asks the backend
 * to pay, and the on-chain program enforces the budget.
 */
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class AgentController {
  constructor(private payments: PaymentsService, private vaults: VaultsService) {}

  /** Create + execute a payment (push model). Returns the verdict + on-chain result. */
  @Post('payments')
  createPayment(@Req() req: any, @Body() body: any) {
    return this.payments.createAndExecute(req.vaultId, body);
  }

  /** Alias matching the spec's "create intent" verb. */
  @Post('intents')
  createIntent(@Req() req: any, @Body() body: any) {
    return this.payments.createAndExecute(req.vaultId, body);
  }

  @Get('payments/:id')
  async getPayment(@Req() req: any, @Param('id') id: string) {
    const p = await this.payments.get(id);
    if (p.vaultId !== req.vaultId) throw new ForbiddenException('not your payment');
    return this.payments.view(p);
  }

  /** The agent's own budget snapshot. */
  @Get('me')
  me(@Req() req: any) {
    return this.vaults.syncFromChain(req.vaultId);
  }
}
