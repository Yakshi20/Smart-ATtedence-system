import { z } from 'zod';
import { AttendanceRangeQuerySchema } from './attendance';

/**
 * Attendance reports (Slice 5). All metrics are counted in **periods** (Q1); there is no
 * daily attendance rate. These definitions are returned with every report so a client can
 * label figures correctly, and they are the single source for the documentation.
 */
export const ATTENDANCE_REPORT_DEFINITIONS = {
  basis: 'periods',
  eligibleStudentPeriod:
    'A register (one section, date and period) paired with a student whose live enrolment in that section covers the date.',
  marked: 'An eligible student-period that has a record: present, absent, late or approved_leave.',
  unmarked:
    'An eligible student-period with no record (register still open, or the pupil was enrolled afterwards with a backdated start). Never counted as absent.',
  attendanceRate: '(present + late) / marked. approved_leave is in the denominator. null when nothing is marked.',
  markingCompleteness: 'marked / eligible student-periods. null when there are none.',
  registerSubmissionRate:
    'submitted registers / registers opened in the range. Only registers that were actually opened are counted: this is NOT the share of timetabled periods that should have had a register (no timetable exists yet).',
  days: 'daysWithRegisters counts distinct dates that had at least one counted register; daysWithAnyMark counts distinct dates with at least one marked period. No daily attendance rate is calculated.',
} as const;

/** Rounded to 4 decimals; null for a zero denominator instead of dividing by zero. */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export const StudentReportQuerySchema = AttendanceRangeQuerySchema;

export const SectionReportQuerySchema = AttendanceRangeQuerySchema.safeExtend({
  academicYearId: z.uuid().optional(),
  gradeId: z.uuid().optional(),
  sectionId: z.uuid().optional(),
  groupBy: z.enum(['section', 'period']).default('section'),
});

export const SchoolSummaryQuerySchema = AttendanceRangeQuerySchema.safeExtend({
  academicYearId: z.uuid().optional(),
});
