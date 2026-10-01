import {
  bigint,
  customType,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Typed mirror of migrations/0001_tenancy_identity.sql.
 *
 * The SQL migration is the source of truth — it carries the CHECK constraints, partial
 * indexes and the audit trigger that Drizzle cannot express. `schema.test.ts` fails if a
 * column declared here is missing from the migrated database, so the two cannot drift.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const USER_STATUSES = ['active', 'disabled'] as const;
export const LANGUAGES = ['en', 'kn'] as const;
export const SCHOOL_SECTORS = ['government', 'private'] as const;
export const SCHOOL_STATUSES = ['pending', 'active', 'suspended', 'archived'] as const;
export const REGISTRATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const PLATFORM_ROLES = ['platform_admin'] as const;
export const SCHOOL_ROLES = ['school_admin', 'teacher'] as const;
export const MEMBERSHIP_STATUSES = ['active', 'revoked'] as const;
export const SESSION_REVOKE_REASONS = ['logout', 'refresh_token_reuse', 'administrative'] as const;
export const AUTH_PROVIDERS = ['staff_password', 'phone_otp'] as const;

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email'),
  phone: text('phone'),
  displayName: text('display_name').notNull(),
  status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
  preferredLanguage: text('preferred_language', { enum: LANGUAGES }).notNull().default('en'),
  ...timestamps,
});

export const authIdentities = pgTable('auth_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  provider: text('provider', { enum: AUTH_PROVIDERS }).notNull(),
  providerSubject: text('provider_subject').notNull(),
  /** argon2id for staff_password; NULL for phone_otp (0003). */
  secretHash: text('secret_hash'),
  ...timestamps,
});

export const schools = pgTable('schools', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolCode: text('school_code').notNull(),
  name: text('name').notNull(),
  sector: text('sector', { enum: SCHOOL_SECTORS }).notNull(),
  udiseCode: text('udise_code'),
  districtName: text('district_name').notNull(),
  status: text('status', { enum: SCHOOL_STATUSES }).notNull().default('active'),
  ...timestamps,
});

export const schoolRegistrationRequests = pgTable('school_registration_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolName: text('school_name').notNull(),
  sector: text('sector', { enum: SCHOOL_SECTORS }).notNull(),
  udiseCode: text('udise_code'),
  districtName: text('district_name').notNull(),
  addressLine: text('address_line').notNull(),
  pincode: text('pincode').notNull(),
  contactName: text('contact_name').notNull(),
  contactEmail: text('contact_email').notNull(),
  contactPhone: text('contact_phone').notNull(),
  status: text('status', { enum: REGISTRATION_STATUSES }).notNull().default('pending'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNote: text('review_note'),
  schoolId: uuid('school_id').references(() => schools.id),
});

export const platformMemberships = pgTable('platform_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  role: text('role', { enum: PLATFORM_ROLES }).notNull(),
  status: text('status', { enum: MEMBERSHIP_STATUSES }).notNull().default('active'),
  ...timestamps,
});

export const schoolMemberships = pgTable('school_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id')
    .notNull()
    .references(() => schools.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  role: text('role', { enum: SCHOOL_ROLES }).notNull(),
  status: text('status', { enum: MEMBERSHIP_STATUSES }).notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id),
  ...timestamps,
});

export const userSessions = pgTable('user_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason', { enum: SESSION_REVOKE_REASONS }),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => userSessions.id),
  parentTokenId: uuid('parent_token_id'),
  tokenHash: bytea('token_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export const accountActivationTokens = pgTable('account_activation_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: bytea('token_hash').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export const auditLogs = pgTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  schoolId: uuid('school_id').references(() => schools.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  requestId: text('request_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
});
