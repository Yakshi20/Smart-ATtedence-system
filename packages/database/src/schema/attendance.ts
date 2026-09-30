import { customType, date, integer, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';

/**
 * Typed mirror of migrations/0004_attendance.sql. Composite keys and the integrity triggers exist
 * only in SQL; `schema.test.ts` keeps the columns in step.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'approved_leave'] as const;
export const ATTENDANCE_SESSION_STATUSES = ['open', 'submitted'] as const;

export const attendanceSessions = pgTable('attendance_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  academicYearId: uuid('academic_year_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  classSubjectId: uuid('class_subject_id').notNull(),
  sessionDate: date('session_date', { mode: 'string' }).notNull(),
  period: smallint('period').notNull(),
  status: text('status', { enum: ATTENDANCE_SESSION_STATUSES }).notNull().default('open'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  submittedBy: uuid('submitted_by').references(() => users.id),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submitIdempotencyKey: uuid('submit_idempotency_key'),
  submitPayloadHash: bytea('submit_payload_hash'),
});

export const attendanceRecords = pgTable('attendance_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  studentId: uuid('student_id').notNull(),
  enrollmentId: uuid('enrollment_id').notNull(),
  status: text('status', { enum: ATTENDANCE_STATUSES }).notNull(),
  revision: integer('revision').notNull().default(0),
  markedBy: uuid('marked_by').references(() => users.id),
  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const attendanceCorrections = pgTable('attendance_corrections', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  recordId: uuid('record_id').notNull(),
  revision: integer('revision').notNull(),
  oldStatus: text('old_status', { enum: ATTENDANCE_STATUSES }),
  newStatus: text('new_status', { enum: ATTENDANCE_STATUSES }).notNull(),
  reason: text('reason').notNull(),
  correctedBy: uuid('corrected_by')
    .notNull()
    .references(() => users.id),
  correctedAt: timestamp('corrected_at', { withTimezone: true }).notNull().defaultNow(),
});
