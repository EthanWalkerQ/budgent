import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(cfg: ConfigService) {
    this.client = new Redis(cfg.get<string>('REDIS_URL') || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
  }

  /**
   * Idempotency latch: returns true if this is the first time we see `key`
   * (sets it with a TTL), false if it already existed.
   */
  async firstSeen(key: string, ttlSeconds = 86_400): Promise<boolean> {
    const res = await this.client.set(`idem:${key}`, '1', 'EX', ttlSeconds, 'NX');
    return res === 'OK';
  }

  async release(key: string): Promise<void> {
    await this.client.del(`idem:${key}`);
  }

  /** Fixed-window rate limit. Returns true if the call is allowed. */
  async rateLimit(bucket: string, limit: number, windowSeconds: number): Promise<boolean> {
    const k = `rl:${bucket}`;
    const n = await this.client.incr(k);
    if (n === 1) await this.client.expire(k, windowSeconds);
    return n <= limit;
  }

  onModuleDestroy() {
    this.client.disconnect();
  }
}
