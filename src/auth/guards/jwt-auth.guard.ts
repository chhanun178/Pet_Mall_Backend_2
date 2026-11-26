import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import jwt from 'jsonwebtoken';
import type { AccessTokenPayload } from '../auth.types.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private getAccessSecret(): string {
    const secret = process.env.JWT_ACCESS_SECRET?.trim();
    if (secret && !secret.includes('replace-with-')) {
      return secret;
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_ACCESS_SECRET must be set in production');
    }
    return 'dev-pet-mall-access-secret-change-me';
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const authHeader: string | undefined = req.headers?.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);

    try {
      const payload = jwt.verify(token, this.getAccessSecret(), {
        algorithms: ['HS256'],
      }) as AccessTokenPayload;
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Access token expired or invalid');
    }
  }
}
