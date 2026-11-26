import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AccessTokenPayload, Role } from '../auth.types.js';
import {
  REQUIRE_ACTIVE_VENDOR_KEY,
  ROLES_KEY,
} from '../decorators/roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user: AccessTokenPayload | undefined = req.user;

    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredRoles?.length) {
      if (!user || !requiredRoles.includes(user.role)) {
        throw new ForbiddenException('Insufficient role permissions');
      }
    }

    const requireActiveVendor = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_ACTIVE_VENDOR_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requireActiveVendor) {
      if (!user || user.role !== 'VENDOR') {
        throw new ForbiddenException('Vendor account required');
      }
      if (user.vendorStatus !== 'ACTIVE') {
        throw new ForbiddenException('Vendor store is suspended. Contact Pet Mall Admin.');
      }
    }

    return true;
  }
}
