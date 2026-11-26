import { ConflictException, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DrizzleService } from '../database/drizzle.service.js';
import {
  customerProfiles,
  emailOtpCodes,
  refreshSessions,
  users,
  vendorProfiles,
} from '../database/schema.js';
import type { SafeUser } from './auth.types.js';

export type AuthProvider = 'LOCAL' | 'GOOGLE';
export type OtpPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

export interface StoredUser extends SafeUser {
  passwordHash?: string | null;
  authProvider?: AuthProvider;
  googleId?: string | null;
  isActive: boolean;
}

export interface StoredRefreshSession {
  tokenHash: string;
  userId: string;
  isRevoked: boolean;
  expiresAt: Date;
}

export interface StoredEmailOtp {
  id: string;
  userId: string;
  email: string;
  codeHash: string;
  purpose: OtpPurpose;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class AuthRepository {
  private readonly usersByEmail = new Map<string, StoredUser>();
  private readonly usersById = new Map<string, StoredUser>();
  private readonly refreshSessionsMap = new Map<string, StoredRefreshSession>();
  private readonly otpsByEmail = new Map<string, StoredEmailOtp[]>();

  constructor(private readonly drizzle: DrizzleService) {}

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const normalized = email.toLowerCase().trim();

    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      return this.usersByEmail.get(normalized) ?? null;
    }

    const row = await this.drizzle.db.query.users.findFirst({
      where: eq(users.email, normalized),
      with: {
        customerProfile: true,
        vendorProfile: true,
      },
    });

    return row ? this.mapUserRow(row) : null;
  }

  async findUserById(userId: string): Promise<StoredUser | null> {
    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      return this.usersById.get(userId) ?? null;
    }

    const row = await this.drizzle.db.query.users.findFirst({
      where: eq(users.id, userId),
      with: {
        customerProfile: true,
        vendorProfile: true,
      },
    });

    return row ? this.mapUserRow(row) : null;
  }

  async createUser(user: StoredUser): Promise<void> {
    const normalized = user.email.toLowerCase().trim();

    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      this.usersByEmail.set(normalized, user);
      this.usersById.set(user.id, user);
      return;
    }

    try {
      await this.drizzle.db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: user.id,
          email: normalized,
          phone: user.phone ?? null,
          passwordHash: user.passwordHash ?? null,
          authProvider: user.authProvider ?? 'LOCAL',
          googleId: user.googleId ?? null,
          role: user.role,
          isEmailVerified: user.isEmailVerified,
          isActive: user.isActive,
        });

        if (user.role === 'CUSTOMER' && user.customerProfile) {
          await tx.insert(customerProfiles).values({
            userId: user.id,
            fullName: user.customerProfile.fullName,
            loyaltyPoints: user.customerProfile.loyaltyPoints,
          });
        }

        if (user.role === 'VENDOR' && user.vendorProfile) {
          await tx.insert(vendorProfiles).values({
            userId: user.id,
            ownerName: user.vendorProfile.ownerName,
            storeName: user.vendorProfile.storeName,
            storeSlug: user.vendorProfile.storeSlug,
            businessCategory: user.vendorProfile.businessCategory,
            taxOrLicenseId: user.vendorProfile.taxOrLicenseId,
            vendorStatus: user.vendorProfile.vendorStatus,
          });
        }
      });
    } catch (error: unknown) {
      const pgCode =
        (error as { code?: string; cause?: { code?: string } })?.code ??
        (error as { cause?: { code?: string } })?.cause?.code;
      if (pgCode === '23505') {
        throw new ConflictException('An account with this email already exists');
      }
      throw error;
    }
  }

  async linkGoogleAccount(userId: string, googleId: string): Promise<void> {
    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      const existing = this.usersById.get(userId);
      if (existing) {
        existing.googleId = googleId;
        existing.isEmailVerified = true;
      }
      return;
    }

    await this.drizzle.db
      .update(users)
      .set({
        googleId,
        isEmailVerified: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  }

  async createEmailOtp(otp: StoredEmailOtp): Promise<void> {
    const normalized = otp.email.toLowerCase().trim();

    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      const list = this.otpsByEmail.get(normalized) ?? [];
      const now = new Date();
      for (const existing of list) {
        if (existing.purpose === otp.purpose && !existing.consumedAt) {
          existing.consumedAt = now;
        }
      }
      list.push({ ...otp, email: normalized });
      this.otpsByEmail.set(normalized, list);
      return;
    }

    await this.drizzle.db.transaction(async (tx) => {
      await tx
        .update(emailOtpCodes)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(emailOtpCodes.email, normalized),
            eq(emailOtpCodes.purpose, otp.purpose),
            isNull(emailOtpCodes.consumedAt),
          ),
        );

      await tx.insert(emailOtpCodes).values({
        id: otp.id,
        userId: otp.userId,
        email: normalized,
        codeHash: otp.codeHash,
        purpose: otp.purpose,
        attempts: otp.attempts,
        expiresAt: otp.expiresAt,
        consumedAt: null,
        createdAt: otp.createdAt,
      });
    });
  }

  async findLatestActiveOtp(
    email: string,
    purpose: OtpPurpose = 'EMAIL_VERIFICATION',
  ): Promise<StoredEmailOtp | null> {
    const normalized = email.toLowerCase().trim();

    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      const list = this.otpsByEmail.get(normalized) ?? [];
      for (let i = list.length - 1; i >= 0; i--) {
        const item = list[i];
        if (item && item.purpose === purpose && !item.consumedAt) {
          return item;
        }
      }
      return null;
    }

    const row = await this.drizzle.db.query.emailOtpCodes.findFirst({
      where: and(
        eq(emailOtpCodes.email, normalized),
        eq(emailOtpCodes.purpose, purpose),
        isNull(emailOtpCodes.consumedAt),
      ),
      orderBy: [desc(emailOtpCodes.createdAt)],
    });

    if (!row) return null;

    return {
      id: row.id,
      userId: row.userId,
      email: row.email,
      codeHash: row.codeHash,
      purpose: row.purpose,
      attempts: row.attempts,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
      createdAt: row.createdAt,
    };
  }

  async incrementOtpAttempts(otpId: string): Promise<number> {
    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      for (const list of this.otpsByEmail.values()) {
        const found = list.find((item) => item.id === otpId);
        if (found) {
          found.attempts += 1;
          return found.attempts;
        }
      }
      return 1;
    }

    const current = await this.drizzle.db.query.emailOtpCodes.findFirst({
      where: eq(emailOtpCodes.id, otpId),
    });
    const nextAttempts = (current?.attempts ?? 0) + 1;

    await this.drizzle.db
      .update(emailOtpCodes)
      .set({ attempts: nextAttempts })
      .where(eq(emailOtpCodes.id, otpId));

    return nextAttempts;
  }

  async consumeOtpAndVerifyEmail(otpId: string, userId: string): Promise<void> {
    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      const now = new Date();
      for (const list of this.otpsByEmail.values()) {
        const found = list.find((item) => item.id === otpId);
        if (found) {
          found.consumedAt = now;
        }
      }
      const user = this.usersById.get(userId);
      if (user) {
        user.isEmailVerified = true;
      }
      return;
    }

    await this.drizzle.db.transaction(async (tx) => {
      await tx
        .update(emailOtpCodes)
        .set({ consumedAt: new Date() })
        .where(eq(emailOtpCodes.id, otpId));

      await tx
        .update(users)
        .set({ isEmailVerified: true, updatedAt: new Date() })
        .where(eq(users.id, userId));
    });
  }

  async consumeOtpAndResetPassword(
    otpId: string,
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      const now = new Date();
      for (const list of this.otpsByEmail.values()) {
        const found = list.find((item) => item.id === otpId);
        if (found) {
          found.consumedAt = now;
        }
      }
      const user = this.usersById.get(userId);
      if (user) {
        user.passwordHash = passwordHash;
        user.isEmailVerified = true;
      }
      for (const session of this.refreshSessionsMap.values()) {
        if (session.userId === userId) {
          session.isRevoked = true;
        }
      }
      return;
    }

    await this.drizzle.db.transaction(async (tx) => {
      await tx
        .update(emailOtpCodes)
        .set({ consumedAt: new Date() })
        .where(eq(emailOtpCodes.id, otpId));

      await tx
        .update(users)
        .set({
          passwordHash,
          isEmailVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      await tx
        .update(refreshSessions)
        .set({ isRevoked: true })
        .where(eq(refreshSessions.userId, userId));
    });
  }

  async saveRefreshSession(session: StoredRefreshSession): Promise<void> {
    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      this.refreshSessionsMap.set(session.tokenHash, session);
      return;
    }

    await this.drizzle.db.insert(refreshSessions).values({
      tokenHash: session.tokenHash,
      userId: session.userId,
      isRevoked: session.isRevoked,
      expiresAt: session.expiresAt,
    });
  }

  async findRefreshSession(tokenHash: string): Promise<StoredRefreshSession | null> {
    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      return this.refreshSessionsMap.get(tokenHash) ?? null;
    }

    const row = await this.drizzle.db.query.refreshSessions.findFirst({
      where: eq(refreshSessions.tokenHash, tokenHash),
    });

    if (!row) return null;

    return {
      tokenHash: row.tokenHash,
      userId: row.userId,
      isRevoked: row.isRevoked,
      expiresAt: row.expiresAt,
    };
  }

  async revokeRefreshSession(tokenHash: string): Promise<void> {
    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      const existing = this.refreshSessionsMap.get(tokenHash);
      if (existing) {
        existing.isRevoked = true;
      }
      return;
    }

    await this.drizzle.db
      .update(refreshSessions)
      .set({ isRevoked: true })
      .where(eq(refreshSessions.tokenHash, tokenHash));
  }

  async revokeAllUserRefreshSessions(userId: string): Promise<void> {
    if (!this.drizzle.isEnabled || !this.drizzle.db) {
      for (const session of this.refreshSessionsMap.values()) {
        if (session.userId === userId) {
          session.isRevoked = true;
        }
      }
      return;
    }

    await this.drizzle.db
      .update(refreshSessions)
      .set({ isRevoked: true })
      .where(eq(refreshSessions.userId, userId));
  }

  private mapUserRow(row: {
    id: string;
    email: string;
    phone: string | null;
    passwordHash: string | null;
    authProvider: AuthProvider;
    googleId: string | null;
    role: StoredUser['role'];
    isEmailVerified: boolean;
    isActive: boolean;
    customerProfile?: { fullName: string; loyaltyPoints: number } | null;
    vendorProfile?: {
      ownerName: string;
      storeName: string;
      storeSlug: string;
      businessCategory: NonNullable<StoredUser['vendorProfile']>['businessCategory'];
      taxOrLicenseId: string;
      vendorStatus: NonNullable<StoredUser['vendorProfile']>['vendorStatus'];
    } | null;
  }): StoredUser {
    return {
      id: row.id,
      email: row.email,
      phone: row.phone ?? undefined,
      role: row.role,
      isEmailVerified: row.isEmailVerified,
      isActive: row.isActive,
      passwordHash: row.passwordHash,
      authProvider: row.authProvider,
      googleId: row.googleId,
      ...(row.customerProfile
        ? {
            customerProfile: {
              fullName: row.customerProfile.fullName,
              loyaltyPoints: row.customerProfile.loyaltyPoints,
            },
          }
        : {}),
      ...(row.vendorProfile
        ? {
            vendorProfile: {
              ownerName: row.vendorProfile.ownerName,
              storeName: row.vendorProfile.storeName,
              storeSlug: row.vendorProfile.storeSlug,
              businessCategory: row.vendorProfile.businessCategory,
              taxOrLicenseId: row.vendorProfile.taxOrLicenseId,
              vendorStatus: row.vendorProfile.vendorStatus,
            },
          }
        : {}),
    };
  }
}
