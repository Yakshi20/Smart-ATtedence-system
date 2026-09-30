import { sql, type SQL } from 'drizzle-orm';
import type { Executor } from '@smart-school/database';

/**
 * The attendance-report aggregation, written once and parameterised, so every report — section
 * rows, grade rows, school totals and one student's summary — uses the same definitions
 * (ATTENDANCE_REPORT_DEFINITIONS in @smart-school/shared):
 *
 *   scoped_sessions  registers in the caller's school and range (+ optional filters, + the
 *                    teacher's actively assigned class-subjects when not school-wide)
 *   eligible         each register × each student whose live enrolment in THAT register's
 *                    section covers its date — the roster rule of academic/roster.ts. Because a
 *                    student's enrolments cannot overlap (0002 EXCLUDE), a student who changes
 *                    section mid-range is counted in each section only for its own dates.
 *   marks            eligible LEFT JOIN records: status NULL = unmarked, never absent (D-11)
 *
 * Everything is aggregated in PostgreSQL; only one row per group returns to the application.
 * All values are bound parameters — nothing from the request is concatenated into SQL.
 */

export interface ReportFilter {
  /** From a resolved SchoolScope, never from the request. */
  schoolId: string;
  from: string;
  to: string;
  academicYearId?: string | undefined;
  gradeId?: string | undefined;
  sectionId?: string | undefined;
  studentId?: string | undefined;
  /** Set for teachers: only registers of class-subjects this membership is actively assigned to. */
  teacherMembershipId?: string | undefined;
}

export type GroupLevel = 'total' | 'grade' | 'section' | 'period';

const KEYS: Record<GroupLevel, string[]> = {
  total: [],
  grade: ['grade_number'],
  section: ['grade_number', 'section_id', 'section_name'],
  period: ['grade_number', 'section_id', 'section_name', 'period'],
};

export interface AggregateRow {
  gradeNumber: number | null;
  sectionId: string | null;
  sectionName: string | null;
  period: number | null;
  registersOpened: number;
  registersSubmitted: number;
  daysWithRegisters: number;
  eligible: number;
  marked: number;
  present: number;
  absent: number;
  late: number;
  approvedLeave: number;
  distinctStudents: number;
  daysWithEligiblePeriods: number;
  daysWithAnyMark: number;
}

function optional(condition: unknown, fragment: SQL): SQL {
  return condition ? fragment : sql``;
}

function ctes(f: ReportFilter): SQL {
  return sql`
    WITH scoped_sessions AS (
      SELECT s.id, s.section_id, s.session_date, s.period, s.status,
             sec.name AS section_name, g.grade_number
      FROM attendance_sessions s
      JOIN sections sec ON sec.id = s.section_id
      JOIN grades g ON g.id = sec.grade_id
      WHERE s.school_id = ${f.schoolId}
        AND s.session_date BETWEEN ${f.from}::date AND ${f.to}::date
        ${optional(f.academicYearId, sql`AND s.academic_year_id = ${f.academicYearId}`)}
        ${optional(f.gradeId, sql`AND sec.grade_id = ${f.gradeId}`)}
        ${optional(f.sectionId, sql`AND s.section_id = ${f.sectionId}`)}
        ${optional(
          f.teacherMembershipId,
          sql`AND EXISTS (SELECT 1 FROM teacher_assignments ta
                          WHERE ta.class_subject_id = s.class_subject_id
                            AND ta.membership_id = ${f.teacherMembershipId}
                            AND ta.ended_at IS NULL)`,
        )}
    ),
    eligible AS (
      SELECT ss.id AS session_id, ss.section_id, ss.section_name, ss.grade_number, ss.period,
             ss.session_date, e.student_id
      FROM scoped_sessions ss
      JOIN enrollments e
        ON e.section_id = ss.section_id
       AND e.school_id = ${f.schoolId}
       AND e.voided_at IS NULL
       AND e.effective_from <= ss.session_date
       AND (e.effective_to IS NULL OR e.effective_to > ss.session_date)
      ${optional(f.studentId, sql`WHERE e.student_id = ${f.studentId}`)}
    ),
    marks AS (
      SELECT el.*, r.status
      FROM eligible el
      LEFT JOIN attendance_records r ON r.session_id = el.session_id AND r.student_id = el.student_id
    )`;
}

function aggregateQuery(f: ReportFilter, level: GroupLevel): SQL {
  const keys = KEYS[level];
  const keyList = sql.raw(keys.join(', '));
  const groupBy = keys.length ? sql`GROUP BY ${keyList}` : sql``;
  const selectKeys = keys.length ? sql`${keyList},` : sql``;
  const join = keys.length ? sql`LEFT JOIN sp USING (${keyList})` : sql`CROSS JOIN sp`;
  const orderBy = keys.length ? sql`ORDER BY ${keyList}` : sql``;
  const out = (name: string) => sql.raw(keys.includes(name) ? `reg.${name}` : 'NULL');

  // Registers come from scoped_sessions; student-periods from marks. A student report has no
  // meaningful "registers opened", so its registers are those with at least one eligible period.
  const registerSource = f.studentId ? sql`(SELECT DISTINCT ON (session_id) session_id AS id, section_id, section_name, grade_number, period, session_date, NULL::text AS status FROM eligible) rs` : sql`scoped_sessions rs`;

  return sql`
    ${ctes(f)},
    reg AS (
      SELECT ${selectKeys}
             count(*)::int AS registers_opened,
             count(*) FILTER (WHERE rs.status = 'submitted')::int AS registers_submitted,
             count(DISTINCT rs.session_date)::int AS days_with_registers
      FROM ${registerSource}
      ${groupBy}
    ),
    sp AS (
      SELECT ${selectKeys}
             count(*)::int AS eligible,
             count(status)::int AS marked,
             count(*) FILTER (WHERE status = 'present')::int AS present,
             count(*) FILTER (WHERE status = 'absent')::int AS absent,
             count(*) FILTER (WHERE status = 'late')::int AS late,
             count(*) FILTER (WHERE status = 'approved_leave')::int AS approved_leave,
             count(DISTINCT student_id)::int AS distinct_students,
             count(DISTINCT session_date)::int AS days_with_eligible,
             count(DISTINCT session_date) FILTER (WHERE status IS NOT NULL)::int AS days_with_any_mark
      FROM marks
      ${groupBy}
    )
    SELECT ${out('grade_number')} AS grade_number,
           ${out('section_id')} AS section_id,
           ${out('section_name')} AS section_name,
           ${out('period')} AS period,
           reg.registers_opened, reg.registers_submitted, reg.days_with_registers,
           coalesce(sp.eligible, 0) AS eligible, coalesce(sp.marked, 0) AS marked,
           coalesce(sp.present, 0) AS present, coalesce(sp.absent, 0) AS absent,
           coalesce(sp.late, 0) AS late, coalesce(sp.approved_leave, 0) AS approved_leave,
           coalesce(sp.distinct_students, 0) AS distinct_students,
           coalesce(sp.days_with_eligible, 0) AS days_with_eligible,
           coalesce(sp.days_with_any_mark, 0) AS days_with_any_mark
    FROM reg
    ${join}
    ${orderBy}`;
}

export async function aggregate(executor: Executor, f: ReportFilter, level: GroupLevel): Promise<AggregateRow[]> {
  const { rows } = await executor.execute<Record<string, unknown>>(aggregateQuery(f, level));
  return rows.map((r) => ({
    gradeNumber: r['grade_number'] === null ? null : Number(r['grade_number']),
    sectionId: (r['section_id'] as string | null) ?? null,
    sectionName: (r['section_name'] as string | null) ?? null,
    period: r['period'] === null ? null : Number(r['period']),
    registersOpened: Number(r['registers_opened'] ?? 0),
    registersSubmitted: Number(r['registers_submitted'] ?? 0),
    daysWithRegisters: Number(r['days_with_registers'] ?? 0),
    eligible: Number(r['eligible']),
    marked: Number(r['marked']),
    present: Number(r['present']),
    absent: Number(r['absent']),
    late: Number(r['late']),
    approvedLeave: Number(r['approved_leave']),
    distinctStudents: Number(r['distinct_students']),
    daysWithEligiblePeriods: Number(r['days_with_eligible']),
    daysWithAnyMark: Number(r['days_with_any_mark']),
  }));
}

/** For EXPLAIN in development: the exact SQL text and parameters of a report query. */
export function reportQueryForExplain(f: ReportFilter, level: GroupLevel): SQL {
  return aggregateQuery(f, level);
}

/** One student's per-period history, including unmarked periods (status NULL). */
export function studentPeriodsQuery(f: ReportFilter & { studentId: string }): SQL {
  return sql`
    ${ctes(f)}
    SELECT el.session_date::text AS date, el.period, el.section_name, el.grade_number,
           subj.code AS subject_code, subj.name AS subject_name,
           r.status, coalesce(r.revision, 0) AS revision
    FROM eligible el
    JOIN attendance_sessions s ON s.id = el.session_id
    JOIN class_subjects cs ON cs.id = s.class_subject_id
    JOIN subjects subj ON subj.id = cs.subject_id
    LEFT JOIN attendance_records r ON r.session_id = el.session_id AND r.student_id = el.student_id
    ORDER BY el.session_date, el.period`;
}
