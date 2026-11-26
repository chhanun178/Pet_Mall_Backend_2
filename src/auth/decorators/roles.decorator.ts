import { SetMetadata } from '@nestjs/common';
import type { Role } from '../auth.types.js';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const REQUIRE_ACTIVE_VENDOR_KEY = 'requireActiveVendor';
export const RequireActiveVendor = () => SetMetadata(REQUIRE_ACTIVE_VENDOR_KEY, true);
