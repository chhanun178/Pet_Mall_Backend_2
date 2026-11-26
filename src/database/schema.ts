import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type { BusinessCategory, Role, VendorStatus } from '../auth/auth.types.js';

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull().unique(),
    phone: text('phone'),
    passwordHash: text('password_hash'),
    authProvider: text('auth_provider')
      .$type<'LOCAL' | 'GOOGLE'>()
      .notNull()
      .default('LOCAL'),
    googleId: text('google_id').unique(),
    role: text('role').$type<Role>().notNull(),
    isEmailVerified: boolean('is_email_verified').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_users_email').on(table.email)],
);

export const customerProfiles = pgTable('customer_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  loyaltyPoints: integer('loyalty_points').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const vendorProfiles = pgTable('vendor_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  ownerName: text('owner_name').notNull(),
  storeName: text('store_name').notNull(),
  storeSlug: text('store_slug').notNull().unique(),
  businessCategory: text('business_category').$type<BusinessCategory>().notNull(),
  taxOrLicenseId: text('tax_or_license_id').notNull(),
  vendorStatus: text('vendor_status').$type<VendorStatus>().notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const refreshSessions = pgTable(
  'refresh_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    isRevoked: boolean('is_revoked').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_refresh_sessions_user_id').on(table.userId),
    index('idx_refresh_sessions_expires_at').on(table.expiresAt),
  ],
);

export const emailOtpCodes = pgTable(
  'email_otp_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    purpose: text('purpose')
      .$type<'EMAIL_VERIFICATION' | 'PASSWORD_RESET'>()
      .notNull()
      .default('EMAIL_VERIFICATION'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_email_otp_codes_email').on(table.email),
    index('idx_email_otp_codes_user_id').on(table.userId),
  ],
);

export const usersRelations = relations(users, ({ one, many }) => ({
  customerProfile: one(customerProfiles, {
    fields: [users.id],
    references: [customerProfiles.userId],
  }),
  vendorProfile: one(vendorProfiles, {
    fields: [users.id],
    references: [vendorProfiles.userId],
  }),
  refreshSessions: many(refreshSessions),
  otpCodes: many(emailOtpCodes),
}));

export const customerProfilesRelations = relations(customerProfiles, ({ one }) => ({
  user: one(users, {
    fields: [customerProfiles.userId],
    references: [users.id],
  }),
}));

export const vendorProfilesRelations = relations(vendorProfiles, ({ one }) => ({
  user: one(users, {
    fields: [vendorProfiles.userId],
    references: [users.id],
  }),
}));

export const refreshSessionsRelations = relations(refreshSessions, ({ one }) => ({
  user: one(users, {
    fields: [refreshSessions.userId],
    references: [users.id],
  }),
}));

export const emailOtpCodesRelations = relations(emailOtpCodes, ({ one }) => ({
  user: one(users, {
    fields: [emailOtpCodes.userId],
    references: [users.id],
  }),
}));

export const schema = {
  users,
  customerProfiles,
  vendorProfiles,
  refreshSessions,
  emailOtpCodes,
  usersRelations,
  customerProfilesRelations,
  vendorProfilesRelations,
  refreshSessionsRelations,
  emailOtpCodesRelations,
};
