import { z } from 'zod';
import { IsoDateSchema, PaginationQuerySchema } from './academic';
import { singleLineText } from './identity';

/**
 * Request schemas for Slice 4 (attendance).
 *
 * No schema accepts a school, section or teacher id: those come from the caller's membership and
 * from the class-subject the session belongs to. Student ids in a submission are checked against
 * the roster resolved on the server.
 */

/**
 * `approved_leave` is from FR-007 ("present, absent, late, approved leave"). Per-school custom
 * statuses are deferred; see the architecture notes.
 */
export const AttendanceStatusSchema = z.enum(['present', 'absent', 'late', 'approved_leave']);
export type AttendanceStatus = z.infer<typeof AttendanceStatusSchema>;

/**
 * Statuses that count as attended when periods are summarized. Reports use this constant
 * instead of hard-coding a list (D-11).
 */
export const PRESENT_EQUIVALENT_STATUSES: readonly AttendanceStatus[] = ['present', 'late'];

export const MAX_PERIODS_PER_DAY = 12;

export const OpenAttendanceSessionSchema = z.object({
  classSubjectId: z.uuid(),
  sessionDate: IsoDateSchema,
  period: z.coerce.number().int().min(1).max(MAX_PERIODS_PER_DAY),
});

/**
 * The whole register at once. Every student on the date's roster must appear exactly once; the
 * server rejects missing or extra students (policy: no partial submissions).
 */
export const SubmitAttendanceSchema = z
  .object({
    records: z
      .array(z.object({ studentId: z.uuid(), status: AttendanceStatusSchema }))
      .min(1)
      .max(300),
  })
  .refine((v) => new Set(v.records.map((r) => r.studentId)).size === v.records.length, {
    message: 'each student may appear once',
    path: ['records'],
  });

/** Sent as the `Idempotency-Key` header on submission. */
export const IdempotencyKeySchema = z.uuid({ message: 'Idempotency-Key header must be a UUID' });

export const AttendanceCorrectionSchema = z.object({
  studentId: z.uuid(),
  status: AttendanceStatusSchema,
  reason: singleLineText(500),
});

export const AttendanceSessionListQuerySchema = PaginationQuerySchema.extend({
  date: IsoDateSchema.optional(),
  sectionId: z.uuid().optional(),
  classSubjectId: z.uuid().optional(),
});

const MAX_RANGE_DAYS = 366;

/** A bounded date range for per-student attendance views. */
export const AttendanceRangeQuerySchema = z
  .object({ from: IsoDateSchema, to: IsoDateSchema })
  .superRefine((v, ctx) => {
    const days = (Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86_400_000;
    if (days < 0) ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before from' });
    else if (days > MAX_RANGE_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: `range may span at most ${MAX_RANGE_DAYS} days` });
  });
