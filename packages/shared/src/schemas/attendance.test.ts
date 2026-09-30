import {
  AttendanceCorrectionSchema,
  AttendanceRangeQuerySchema,
  AttendanceStatusSchema,
  IdempotencyKeySchema,
  OpenAttendanceSessionSchema,
  PRESENT_EQUIVALENT_STATUSES,
  SubmitAttendanceSchema,
} from './attendance';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';

test('statuses: present, absent, late, approved_leave — nothing else', () => {
  for (const s of ['present', 'absent', 'late', 'approved_leave']) expect(AttendanceStatusSchema.safeParse(s).success).toBe(true);
  for (const s of ['unmarked', 'sick', '', 'PRESENT']) expect(AttendanceStatusSchema.safeParse(s).success).toBe(false);
});

test('only present and late count as attended', () => {
  expect([...PRESENT_EQUIVALENT_STATUSES].sort()).toEqual(['late', 'present']);
});

test('a submission cannot list a student twice', () => {
  expect(
    SubmitAttendanceSchema.safeParse({ records: [{ studentId: a, status: 'present' }, { studentId: a, status: 'absent' }] }).success,
  ).toBe(false);
  expect(
    SubmitAttendanceSchema.safeParse({ records: [{ studentId: a, status: 'present' }, { studentId: b, status: 'late' }] }).success,
  ).toBe(true);
});

test('a submission ignores smuggled school or section ids', () => {
  const out = SubmitAttendanceSchema.parse({ records: [{ studentId: a, status: 'present', schoolId: b }], sectionId: b });
  expect(out).toEqual({ records: [{ studentId: a, status: 'present' }] });
});

test('periods are 1–12 and dates must be real', () => {
  expect(OpenAttendanceSessionSchema.safeParse({ classSubjectId: a, sessionDate: '2026-07-01', period: 0 }).success).toBe(false);
  expect(OpenAttendanceSessionSchema.safeParse({ classSubjectId: a, sessionDate: '2026-07-01', period: 13 }).success).toBe(false);
  expect(OpenAttendanceSessionSchema.safeParse({ classSubjectId: a, sessionDate: '2026-02-30', period: 1 }).success).toBe(false);
});

test('a correction requires a non-blank reason', () => {
  expect(AttendanceCorrectionSchema.safeParse({ studentId: a, status: 'present', reason: '   ' }).success).toBe(false);
  expect(AttendanceCorrectionSchema.safeParse({ studentId: a, status: 'present' }).success).toBe(false);
});

test('idempotency keys are UUIDs', () => {
  expect(IdempotencyKeySchema.safeParse('retry-1').success).toBe(false);
  expect(IdempotencyKeySchema.safeParse(a).success).toBe(true);
});

test('date ranges are ordered and bounded', () => {
  expect(AttendanceRangeQuerySchema.safeParse({ from: '2026-07-10', to: '2026-07-01' }).success).toBe(false);
  expect(AttendanceRangeQuerySchema.safeParse({ from: '2026-01-01', to: '2027-06-01' }).success).toBe(false);
  expect(AttendanceRangeQuerySchema.safeParse({ from: '2026-07-01', to: '2026-07-31' }).success).toBe(true);
});
