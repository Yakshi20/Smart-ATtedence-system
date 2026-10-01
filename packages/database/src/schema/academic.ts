import { date, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { schoolMemberships, schools, users } from './identity';

/**
 * Typed mirror of migrations/0002_academic_structure.sql.
 *
 * The composite foreign keys, EXCLUDE constraints and history-protection triggers live only in
 * the SQL migration; this file declares columns for the query builder. `schema.test.ts` fails
 * if the two drift.
 *
 * Dates use `mode: 'string'` (YYYY-MM-DD). A calendar date is not an instant: converting it to
 * a JS Date would shift it across midnight depending on the server's timezone.
 */

export const ACADEMIC_YEAR_STATUSES = ['planned', 'active', 'closed', 'archived'] as const;
export const SUBJECT_STATUSES = ['active', 'retired'] as const;
export const STUDENT_STATUSES = ['active', 'transferred', 'withdrawn'] as const;
export const ENROLLMENT_END_REASONS = ['section_transfer', 'promoted', 'withdrawn', 'transferred_out'] as const;
export const SUBJECT_LABEL_LANGUAGES = ['en', 'kn'] as const;

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const academicYears = pgTable('academic_years', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id')
    .notNull()
    .references(() => schools.id),
  name: text('name').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  status: text('status', { enum: ACADEMIC_YEAR_STATUSES }).notNull().default('planned'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt,
  updatedAt,
});

export const grades = pgTable('grades', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id')
    .notNull()
    .references(() => schools.id),
  gradeNumber: smallint('grade_number').notNull(),
  displayName: text('display_name').notNull(),
  createdAt,
  updatedAt,
});

export const sections = pgTable('sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  academicYearId: uuid('academic_year_id').notNull(),
  gradeId: uuid('grade_id').notNull(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt,
  updatedAt,
});

export const subjects = pgTable('subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id')
    .notNull()
    .references(() => schools.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  nameTranslations: jsonb('name_translations')
    .$type<Partial<Record<(typeof SUBJECT_LABEL_LANGUAGES)[number], string>>>()
    .notNull()
    .default({}),
  status: text('status', { enum: SUBJECT_STATUSES }).notNull().default('active'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt,
  updatedAt,
});

export const classSubjects = pgTable('class_subjects', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  academicYearId: uuid('academic_year_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  subjectId: uuid('subject_id').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt,
});

export const students = pgTable('students', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id')
    .notNull()
    .references(() => schools.id),
  studentNumber: text('student_number').notNull(),
  fullName: text('full_name').notNull(),
  dateOfBirth: date('date_of_birth', { mode: 'string' }),
  status: text('status', { enum: STUDENT_STATUSES }).notNull().default('active'),
  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt,
  updatedAt,
});

export const studentNumberCounters = pgTable('student_number_counters', {
  schoolId: uuid('school_id')
    .primaryKey()
    .references(() => schools.id),
  nextValue: integer('next_value').notNull().default(1),
});

export const enrollments = pgTable('enrollments', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  studentId: uuid('student_id').notNull(),
  academicYearId: uuid('academic_year_id').notNull(),
  sectionId: uuid('section_id').notNull(),
  effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
  effectiveTo: date('effective_to', { mode: 'string' }),
  endReason: text('end_reason', { enum: ENROLLMENT_END_REASONS }),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidReason: text('void_reason'),
  previousEnrollmentId: uuid('previous_enrollment_id'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt,
  updatedAt,
});

export const teacherAssignments = pgTable('teacher_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  schoolId: uuid('school_id').notNull(),
  academicYearId: uuid('academic_year_id').notNull(),
  classSubjectId: uuid('class_subject_id').notNull(),
  membershipId: uuid('membership_id')
    .notNull()
    .references(() => schoolMemberships.id),
  assignedBy: uuid('assigned_by').references(() => users.id),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endedBy: uuid('ended_by').references(() => users.id),
});
