import { sql, type SQL } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '@smart-school/database';

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

/**
 * Runs report queries in one read-only REPEATABLE READ transaction — so several aggregates of one
 * response (e.g. school total, classes, sections) come from the same snapshot and always agree —
 * with JIT disabled for the transaction only. Measured on 300k records: JIT compilation alone
 * took ~2.4 s of a ~3.4 s summary; these queries finish in about a second without it.
 */
export function reportTransaction<T>(db: Database, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL jit = off`);
      return fn(tx);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

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

/**
 * Presentation order: class, then section name, then period — never by a metric (no rankings)
 * and never by an id (ids are random, so the order would be too).
 */
const ORDER: Record<GroupLevel, string[]> = {
  total: [],
  grade: ['grade_number'],
  section: ['grade_number', 'section_name', 'section_id'],
  period: ['grade_number', 'section_name', 'section_id', 'period'],
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

/** An enrolment `e` that is live and covers the date of register `ss` (the roster rule). */
function covers(f: ReportFilter): SQL {
  return sql`e.section_id = ss.section_id
         AND e.school_id = ${f.schoolId}
         AND e.voided_at IS NULL
         AND e.effective_from <= ss.session_date
         AND (e.effective_to IS NULL OR e.effective_to > ss.session_date)`;
}

function scopedSessions(f: ReportFilter): SQL {
  return sql`
    scoped_sessions AS (
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
          f.studentId,
          // Only sections the student was ever placed in can hold their periods.
          sql`AND s.section_id IN (SELECT section_id FROM enrollments
                                   WHERE student_id = ${f.studentId} AND school_id = ${f.schoolId})`,
        )}
        ${optional(
          f.teacherMembershipId,
          sql`AND EXISTS (SELECT 1 FROM teacher_assignments ta
                          WHERE ta.class_subject_id = s.class_subject_id
                            AND ta.membership_id = ${f.teacherMembershipId}
                            AND ta.ended_at IS NULL)`,
        )}
    )`;
}

/** Per-student-period expansion; used only by the single-student history, where it is small. */
function ctes(f: ReportFilter): SQL {
  return sql`
    WITH ${scopedSessions(f)},
    eligible AS (
      SELECT ss.id AS session_id, ss.section_id, ss.section_name, ss.grade_number, ss.period,
             ss.session_date, e.student_id
      FROM scoped_sessions ss
      JOIN enrollments e ON ${covers(f)}
      ${optional(f.studentId, sql`WHERE e.student_id = ${f.studentId}`)}
    )`;
}

/**
 * Aggregation CTEs. Eligible and marked counts are computed per register, each register driving
 * index lookups and being aggregated in place, so cost grows with the registers in the range —
 * not with all attendance ever stored.
 *
 * Marked rows are counted straight from the register's records. That every record lies inside
 * an eligible student-period is an invariant the database enforces (0004): a record can only be
 * inserted against a live enrolment covering its date, that enrolment can never afterwards be
 * voided or ended on/before the date, and neither row's placement can be rewritten (0002/0004
 * triggers). Re-checking it per record here was measured at ~2.4× the cost of the whole
 * 60-day school summary (docs/decisions/01 §12), so the service instead logs an integrity error
 * if any row ever reports marked > eligible.
 */
function aggregateCtes(f: ReportFilter): SQL {
  const studentOnly = (column: string) => optional(f.studentId, sql`AND ${sql.raw(column)} = ${f.studentId}`);
  return sql`
    WITH ${scopedSessions(f)},
    -- LATERAL, per register: each register drives index lookups (enrollments_section_dates_idx,
    -- attendance_records_session_student_key) and is aggregated in place, so the cost grows with
    -- the registers in the requested range — not with the school's whole attendance history.
    reg_eligible AS (
      SELECT ss.id, el.eligible
      FROM scoped_sessions ss
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS eligible
        FROM enrollments e
        WHERE ${covers(f)} ${studentOnly('e.student_id')}
      ) el
    ),
    reg_marks AS (
      SELECT ss.id, m.*
      FROM scoped_sessions ss
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS marked,
               count(*) FILTER (WHERE r.status = 'present')::int AS present,
               count(*) FILTER (WHERE r.status = 'absent')::int AS absent,
               count(*) FILTER (WHERE r.status = 'late')::int AS late,
               count(*) FILTER (WHERE r.status = 'approved_leave')::int AS approved_leave
        FROM attendance_records r
        WHERE r.session_id = ss.id AND r.section_id = ss.section_id AND r.school_id = ${f.schoolId}
          ${studentOnly('r.student_id')}
      ) m
    ),
    per_register AS (
      SELECT ss.id, ss.section_id, ss.section_name, ss.grade_number, ss.period, ss.session_date, ss.status,
             coalesce(el.eligible, 0) AS eligible, coalesce(m.marked, 0) AS marked,
             coalesce(m.present, 0) AS present, coalesce(m.absent, 0) AS absent,
             coalesce(m.late, 0) AS late, coalesce(m.approved_leave, 0) AS approved_leave
      FROM scoped_sessions ss
      JOIN reg_eligible el ON el.id = ss.id
      JOIN reg_marks m ON m.id = ss.id
    )`;
}

function aggregateQuery(f: ReportFilter, level: GroupLevel): SQL {
  const keys = KEYS[level];
  const keyList = sql.raw(keys.join(', '));
  const groupBy = keys.length ? sql`GROUP BY ${keyList}` : sql``;
  const selectKeys = keys.length ? sql`${keyList},` : sql``;
  const join = keys.length ? sql`LEFT JOIN st USING (${keyList})` : sql`CROSS JOIN st`;
  const orderBy = keys.length ? sql`ORDER BY ${sql.raw(ORDER[level].map((k) => `reg.${k}`).join(', '))}` : sql``;
  const out = (name: string) => sql.raw(keys.includes(name) ? `reg.${name}` : 'NULL');
  // Distinct students per group: deduplicate (group keys, student) first — at most
  // students × periods rows — so a pupil who moved section is one pupil at class level.
  const studentKeys = sql.raw([...keys, 'student_id'].join(', '));

  return sql`
    ${aggregateCtes(f)},
    reg AS (
      SELECT ${selectKeys}
             count(*)::int AS registers_opened,
             count(*) FILTER (WHERE status = 'submitted')::int AS registers_submitted,
             count(DISTINCT session_date)::int AS days_with_registers,
             count(DISTINCT session_date) FILTER (WHERE eligible > 0)::int AS days_with_eligible,
             count(DISTINCT session_date) FILTER (WHERE marked > 0)::int AS days_with_any_mark,
             coalesce(sum(eligible), 0)::int AS eligible,
             coalesce(sum(marked), 0)::int AS marked,
             coalesce(sum(present), 0)::int AS present,
             coalesce(sum(absent), 0)::int AS absent,
             coalesce(sum(late), 0)::int AS late,
             coalesce(sum(approved_leave), 0)::int AS approved_leave
      FROM per_register
      ${groupBy}
    ),
    st AS (
      SELECT ${selectKeys} count(*)::int AS distinct_students
      FROM (
        SELECT DISTINCT ${studentKeys}
        FROM (SELECT ss.grade_number, ss.section_id, ss.section_name, ss.period, e.student_id
              FROM scoped_sessions ss
              JOIN enrollments e ON ${covers(f)} ${optional(f.studentId, sql`AND e.student_id = ${f.studentId}`)}) x
      ) d
      ${groupBy}
    )
    SELECT ${out('grade_number')} AS grade_number,
           ${out('section_id')} AS section_id,
           ${out('section_name')} AS section_name,
           ${out('period')} AS period,
           reg.registers_opened, reg.registers_submitted, reg.days_with_registers,
           reg.eligible, reg.marked, reg.present, reg.absent, reg.late, reg.approved_leave,
           coalesce(st.distinct_students, 0) AS distinct_students,
           reg.days_with_eligible, reg.days_with_any_mark
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
