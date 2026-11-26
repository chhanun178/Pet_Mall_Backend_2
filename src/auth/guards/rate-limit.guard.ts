import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const RATE_LIMIT_KEY = 'rateLimitConfig';

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
  keyByEmail?: boolean;
}

export const RateLimit = (
  limit: number,
  windowSeconds: number,
  keyByEmail = false,
) =>
  SetMetadata(RATE_LIMIT_KEY, {
    limit,
    windowSeconds,
    keyByEmail,
  } satisfies RateLimitConfig);

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const config = this.reflector.getAllAndOverride<RateLimitConfig | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!config) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const routeKey = `${req.method}:${req.route?.path ?? req.url}`;
    const rawEmail = req.body?.email;
    const emailPart =
      config.keyByEmail && typeof rawEmail === 'string'
        ? `:${rawEmail.trim().toLowerCase()}`
        : '';

    const bucketKey = `${routeKey}:${ip}${emailPart}`;
    const now = Date.now();
    const cutoff = now - config.windowSeconds * 1000;

    const recent = (this.buckets.get(bucketKey) ?? []).filter((ts) => ts > cutoff);

    if (recent.length >= config.limit) {
      throw new HttpException(
        `Too many requests. Please wait ${config.windowSeconds} seconds and try again.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    this.buckets.set(bucketKey, recent);

    if (this.buckets.size > 5000) {
      this.pruneExpired(now);
    }

    return true;
  }

  private pruneExpired(now: number): void {
    const maxAgeCutoff = now - 3600 * 1000;
    for (const [key, timestamps] of this.buckets.entries()) {
      const latest = timestamps[timestamps.length - 1] ?? 0;
      if (latest < maxAgeCutoff) {
        this.buckets.delete(key);
      }
    }
  }
}
