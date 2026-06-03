import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

/** Owner/admin auth: a static Bearer token. The owner console uses this. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private cfg: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const expected = this.cfg.get<string>('ADMIN_TOKEN') || '';
    const header = String(req.headers['authorization'] || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!expected || !token || token.length !== expected.length) {
      throw new UnauthorizedException('admin auth required');
    }
    if (!timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      throw new UnauthorizedException('invalid admin token');
    }
    return true;
  }
}
