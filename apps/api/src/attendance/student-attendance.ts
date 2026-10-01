import { Logger } from '@nestjs/common';
import type { Database } from '@smart-school/database';
import { ATTENDANCE_REPORT_DEFINITIONS, ratio, type AttendanceStatus } from '@smart-school/shared';
import { aggregate, reportTransaction, studentPeriodsQuery } from '../reports/report-sql';

const logger = new Logger('StudentAttendance');

interface PeriodRow extends Record<string, unknown> {
  date: string;
  period: number;
  section_name: string;
  grade_number: number;
  subject_code: string;
  subject_name: string;
  status: AttendanceStatus | null;
  revision: number;
}

export interface StudentAttendanceEntry {
  date: string;
  period: number;
  /** The class and section the pupil was in on that date — historical, not current. */
  gradeNumber: number;
  sectionName: string;
  subjectCode: string;
  subjectName: string;
  /** null = unmarked (register open, or enrolled later with a backdated start). Never absent. */
  status: AttendanceStatus | null;
  /** True when the status differs from what was first submitted. Reasons are not exposed here. */
  corrected: boolean;
}

/**
 * Per-period counts for one student (Q1). Field names from Slice 4 are kept unchanged —
 * `attendanceRate` = (present + late) / periodsMarked, approved_leave in the denominator — and
 * the Slice 5 fields are added alongside.
 */
export interface AttendanceSummary {
  basis: 'periods';
  eligiblePeriods: number;
  periodsMarked: number;
  unmarkedPeriods: number;
  attendedPeriods: number;
  byStatus: Record<AttendanceStatus, number>;
  attendanceRate: number | null;
  markingCompleteness: number | null;
  daysWithRegisters: number;
  daysWithAnyMark: number;
}

export interface StudentAttendanceReport {
  from: string;
  to: string;
  items: StudentAttendanceEntry[];
  summary: AttendanceSummary;
  definitions: typeof ATTENDANCE_REPORT_DEFINITIONS;
}

/**
 * One student's attendance in one school over a date range: every eligible period, marked or
 * not, with the section the pupil was actually in that day.
 *
 * Authorization is the caller's job: `schoolId` and `studentId` must already be proven visible
 * (school-wide scope, a teacher's relationship check, or a verified guardian link). A teacher's
 * view passes `teacherMembershipId`, which limits it to their actively assigned class-subjects.
 */
export async function studentAttendance(
  db: Database,
  filter: { schoolId: string; studentId: string; from: string; to: string; teacherMembershipId?: string | undefined },
): Promise<StudentAttendanceReport> {
  // History and summary from one snapshot, so the counts always match the listed periods.
  const { rows, totals } = await reportTransaction(db, async (tx) => {
    const history = await tx.execute<PeriodRow>(studentPeriodsQuery(filter));
    const [total] = await aggregate(tx, filter, 'total');
    return { rows: history.rows, totals: total! };
  });
  const t = totals;
  if (t.marked > t.eligible) {
    // Impossible while the 0004 invariants hold; surfaced loudly rather than clamped.
    logger.error({ event: 'attendance_report_integrity', scope: 'student', marked: t.marked, eligible: t.eligible });
  }
  const attendedPeriods = t.present + t.late;

  return {
    from: filter.from,
    to: filter.to,
    items: rows.map((r) => ({
      date: r.date,
      period: Number(r.period),
      gradeNumber: Number(r.grade_number),
      sectionName: r.section_name,
      subjectCode: r.subject_code,
      subjectName: r.subject_name,
      status: r.status,
      corrected: Number(r.revision) > 0,
    })),
    summary: {
      basis: 'periods',
      eligiblePeriods: t.eligible,
      periodsMarked: t.marked,
      unmarkedPeriods: t.eligible - t.marked,
      attendedPeriods,
      byStatus: { present: t.present, absent: t.absent, late: t.late, approved_leave: t.approvedLeave },
      attendanceRate: ratio(attendedPeriods, t.marked),
      markingCompleteness: ratio(t.marked, t.eligible),
      daysWithRegisters: t.daysWithEligiblePeriods,
      daysWithAnyMark: t.daysWithAnyMark,
    },
    definitions: ATTENDANCE_REPORT_DEFINITIONS,
  };
}
