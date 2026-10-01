import { customType, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { schools, users } from './identity';

/**
 * Typed mirror of migrations/0003_guardians.sql. The composite keys, partial unique indexes and
 * the link-history trigger exist only in SQL; `schema.test.ts` keeps the columns in step.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const RELATIONSHIP_TYPES = [
  'mother',
  'father',
  'grandparent',
  'sibling',
  'relative',
  'legal_guardian',
  'other',
] as const;
export const GUARDIAN_LINK_STATUSES = ['pending', 'verified', 'rejected', 'revoked'] as const;
export const GUARDIAN_LINK_ORIGINS = ['school', 'guardian_claim'] as const;
export const OTP_PURPOSES = ['guardian_login'] as const;
export const OTP_DELIVERY_STATUSES = ['pending', 'sent', 'dev_outbox', 'failed'] as const;

export const otpChallenges = pgTable('otp_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull(),
  purpose: text('purpose', { enum: OTP_PURPOSES }).notNull(),
  codeHmac: bytea('code_hmac').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: smallint('attempts').notNull().default(0),
  maxAttempts: smallint('max_attempts').notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  deliveryStatus: text('delivery_status', { enum: OTP_DELIVERY_STATUSES }).notNull().default('pending'),
});

export const guardians = pgTable('guardians', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id')
    .notNull()
    .references(() => schools.id),
  fullName: text('full_name').notNull(),
  phone: text('phone').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const studentGuardians = pgTable('student_guardians', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  studentId: uuid('student_id').notNull(),
  guardianId: uuid('guardian_id').notNull(),
  relationshipType: text('relationship_type', { enum: RELATIONSHIP_TYPES }).notNull(),
  status: text('status', { enum: GUARDIAN_LINK_STATUSES }).notNull().default('pending'),
  initiatedVia: text('initiated_via', { enum: GUARDIAN_LINK_ORIGINS }).notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  verifiedBy: uuid('verified_by').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  rejectedBy: uuid('rejected_by').references(() => users.id),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  statusReason: text('status_reason'),
});

export const guardianLinkClaims = pgTable('guardian_link_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  claimantUserId: uuid('claimant_user_id')
    .notNull()
    .references(() => users.id),
  claimantPhone: text('claimant_phone').notNull(),
  schoolCode: text('school_code').notNull(),
  studentNumber: text('student_number').notNull(),
  relationshipType: text('relationship_type', { enum: RELATIONSHIP_TYPES }).notNull(),
  claimantName: text('claimant_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  schoolId: uuid('school_id').references(() => schools.id),
  linkId: uuid('link_id').references(() => studentGuardians.id),
});
