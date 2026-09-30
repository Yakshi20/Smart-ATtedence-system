import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@smart-school/database';
import { Permission, roleHasPermission, ScopeType } from '@smart-school/permissions';
import { ATTENDANCE_REPORT_DEFINITIONS, DomainError, ErrorCode, notVisible, permissionDenied, ratio } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { AcademicAccess } from '../academic/academic-access';
import { studentAttendance, type StudentAttendanceReport } from '../attendance/student-attendance';
import { writeAudit } from '../audit/audit';
import type { RequestMeta } from '../common/request-meta';
import { DATABASE } from '../database/database.module';
import { toCsv, type CsvValue } from './csv';
import { aggregate, type AggregateRow, type GroupLevel, type ReportFilter } from './report-sql';

export interface ReportRow {
  gradeNumber: number | null;
  sectionId: string | null;
  sectionName: string | null;
  period: number | null;
  registers: {
    opened: number;
    submitted: number;
    open: number;
    /** submitted / opened — only registers that were actually opened; not timetable coverage. */
    submissionRate: number | null;
    daysWithRegisters: number;
  };
  studentPeriods: {
    eligible: number;
    marked: number;
    unmarked: number;
    attended: number;
    byStatus: { present: number; absent: number; late: number; approved_leave: number };
    markingCompleteness: number | null;
  };
  /** (present + late) / marked. Unmarked periods are excluded, never counted as absent. */
  attendanceRate: number | null;
  distinctStudents: number;
  daysWithAnyMark: number;
}

export interface Included {
  from: string;
  to: string;
  academicYearId: string | null;
  gradeId: string | null;
  sectionId: string | null;
  registers: 'all registers in the school' | 'registers of class-subjects you are actively assigned to';
}

type SectionQuery = {
  from: string;
  to: string;
  academicYearId?: string | undefined;
  gradeId?: string | undefined;
  sectionId?: string | undefined;
  groupBy: 'section' | 'period';
};

/**
 * Attendance reports (Slice 5). Read-only: every figure is derived on request from
 * attendance_sessions / attendance_records / enrollments, so a correction is reflected
 * immediately and there are no stored totals to go stale. Nothing is cached, so no result can be
 * served to another school.
 *
 * Scope:
 * - School-wide staff (`school.attendance.read_all`) see every register in their school.
 * - Teachers see only registers of class-subjects they are **actively** assigned to, re-checked
 *   on every request; a section in their school with no such assignment is 403, one outside it 404.
 * - No report ranks sections or lists individual children; rows are ordered by class and section.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly academicAccess: AcademicAccess,
  ) {}

  async sectionReport(scope: SchoolScope, q: SectionQuery): Promise<{ included: Included; rows: ReportRow[]; definitions: typeof ATTENDANCE_REPORT_DEFINITIONS }> {
    const filter = await this.resolveFilter(scope, q);
    const rows = await aggregate(this.db, filter, q.groupBy);
    return { included: this.included(scope, q), rows: rows.map(toReportRow), definitions: ATTENDANCE_REPORT_DEFINITIONS };
  }

  /** School-wide only: the controller requires `school.attendance.read_all`. */
  async schoolSummary(
    scope: SchoolScope,
    q: { from: string; to: string; academicYearId?: string | undefined },
  ): Promise<{
    included: Included;
    total: ReportRow;
    grades: ReportRow[];
    sections: ReportRow[];
    definitions: typeof ATTENDANCE_REPORT_DEFINITIONS;
  }> {
    const filter = await this.resolveFilter(scope, q);
    // Three aggregates over the same CTE; distinct students are counted per level, never summed,
    // so a pupil who moved between sections is one pupil at class and school level.
    const [total, grades, sections] = await Promise.all(
      (['total', 'grade', 'section'] as GroupLevel[]).map((level) => aggregate(this.db, filter, level)),
    );
    return {
      included: this.included(scope, q),
      total: toReportRow(total![0]!),
      grades: grades!.map(toReportRow),
      sections: sections!.map(toReportRow),
      definitions: ATTENDANCE_REPORT_DEFINITIONS,
    };
  }

  async studentReport(scope: SchoolScope, studentId: string, q: { from: string; to: string }): Promise<StudentAttendanceReport> {
    if (this.schoolWide(scope)) {
      const [student] = await this.db
        .select({ id: schema.students.id })
        .from(schema.students)
        .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, scope.schoolId)));
      if (!student) throw notVisible('student');
      return studentAttendance(this.db, { schoolId: scope.schoolId, studentId, ...q });
    }
    // Teachers: the student must currently be in a section they actively teach (404 otherwise,
    // as for any student they cannot see), and only their own class-subjects are included.
    await this.academicAccess.requireStudentVisible(scope, studentId);
    return studentAttendance(this.db, { schoolId: scope.schoolId, studentId, ...q, teacherMembershipId: scope.membershipId });
  }

  // ------------------------------------------------------------------ CSV

  /** Aggregate rows only — no student names or ids. Same authorization as the JSON report; audited. */
  async sectionReportCsv(scope: SchoolScope, q: SectionQuery, meta: RequestMeta): Promise<string> {
    const report = await this.sectionReport(scope, q);
    const withPeriod = q.groupBy === 'period';
    const header = [
      'range_from', 'range_to', 'registers_included', 'grade_number', 'section_name',
      ...(withPeriod ? ['period'] : []),
      ...METRIC_COLUMNS,
    ];
    const rows = report.rows.map((r) => [
      q.from, q.to, report.included.registers, r.gradeNumber, r.sectionName,
      ...(withPeriod ? [r.period] : []),
      ...metricCells(r),
    ]);
    await this.auditExport(scope, meta, 'sections', q, rows.length);
    return toCsv(header, rows);
  }

  async schoolSummaryCsv(
    scope: SchoolScope,
    q: { from: string; to: string; academicYearId?: string | undefined },
    meta: RequestMeta,
  ): Promise<string> {
    const s = await this.schoolSummary(scope, q);
    const header = ['range_from', 'range_to', 'level', 'grade_number', 'section_name', ...METRIC_COLUMNS];
    const rows: CsvValue[][] = [
      [q.from, q.to, 'school', null, null, ...metricCells(s.total)],
      ...s.grades.map((r) => [q.from, q.to, 'class', r.gradeNumber, null, ...metricCells(r)]),
      ...s.sections.map((r) => [q.from, q.to, 'section', r.gradeNumber, r.sectionName, ...metricCells(r)]),
    ];
    await this.auditExport(scope, meta, 'summary', q, rows.length);
    return toCsv(header, rows);
  }

  // ------------------------------------------------------------------ helpers

  private schoolWide(scope: SchoolScope): boolean {
    return roleHasPermission(ScopeType.SCHOOL, scope.role, Permission.SCHOOL_ATTENDANCE_READ_ALL);
  }

  private included(scope: SchoolScope, q: { from: string; to: string; academicYearId?: string | undefined; gradeId?: string | undefined; sectionId?: string | undefined }): Included {
    return {
      from: q.from,
      to: q.to,
      academicYearId: q.academicYearId ?? null,
      gradeId: q.gradeId ?? null,
      sectionId: q.sectionId ?? null,
      registers: this.schoolWide(scope) ? 'all registers in the school' : 'registers of class-subjects you are actively assigned to',
    };
  }

  /**
   * Every filter id is re-resolved inside the caller's school: another school's id behaves
   * exactly like one that does not exist (404). The school id itself always comes from the scope.
   */
  private async resolveFilter(
    scope: SchoolScope,
    q: { from: string; to: string; academicYearId?: string | undefined; gradeId?: string | undefined; sectionId?: string | undefined },
  ): Promise<ReportFilter> {
    if (q.academicYearId) {
      const [year] = await this.db
        .select()
        .from(schema.academicYears)
        .where(and(eq(schema.academicYears.id, q.academicYearId), eq(schema.academicYears.schoolId, scope.schoolId)));
      if (!year) throw notVisible('academic year');
      if (q.to < year.startDate || q.from > year.endDate) {
        throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, `The date range does not overlap academic year ${year.name}`);
      }
    }
    if (q.gradeId) {
      const [grade] = await this.db
        .select({ id: schema.grades.id })
        .from(schema.grades)
        .where(and(eq(schema.grades.id, q.gradeId), eq(schema.grades.schoolId, scope.schoolId)));
      if (!grade) throw notVisible('grade');
    }
    if (q.sectionId) {
      const [section] = await this.db
        .select({ id: schema.sections.id, academicYearId: schema.sections.academicYearId, gradeId: schema.sections.gradeId })
        .from(schema.sections)
        .where(and(eq(schema.sections.id, q.sectionId), eq(schema.sections.schoolId, scope.schoolId)));
      if (!section) throw notVisible('section');
      if (q.academicYearId && section.academicYearId !== q.academicYearId) {
        throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, 'The section is not in that academic year');
      }
      if (q.gradeId && section.gradeId !== q.gradeId) {
        throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, 'The section is not in that class');
      }
      if (!this.schoolWide(scope)) {
        // Visible structure, but not theirs to report on: 403 (D-19).
        const [assigned] = await this.db
          .select({ id: schema.teacherAssignments.id })
          .from(schema.teacherAssignments)
          .innerJoin(schema.classSubjects, eq(schema.classSubjects.id, schema.teacherAssignments.classSubjectId))
          .where(
            and(
              eq(schema.classSubjects.sectionId, section.id),
              eq(schema.teacherAssignments.membershipId, scope.membershipId),
              isNull(schema.teacherAssignments.endedAt),
            ),
          )
          .limit(1);
        if (!assigned) throw permissionDenied('view reports for this section');
      }
    }
    return {
      schoolId: scope.schoolId,
      from: q.from,
      to: q.to,
      academicYearId: q.academicYearId,
      gradeId: q.gradeId,
      sectionId: q.sectionId,
      teacherMembershipId: this.schoolWide(scope) ? undefined : scope.membershipId,
    };
  }

  private auditExport(
    scope: SchoolScope,
    meta: RequestMeta,
    report: 'sections' | 'summary',
    q: { from: string; to: string; academicYearId?: string | undefined; gradeId?: string | undefined; sectionId?: string | undefined },
    rows: number,
  ): Promise<void> {
    return writeAudit(this.db, {
      action: 'attendance_report.exported',
      entityType: 'attendance_report',
      entityId: null,
      actorUserId: scope.userId,
      schoolId: scope.schoolId,
      requestId: meta.requestId,
      metadata: {
        report,
        format: 'csv',
        from: q.from,
        to: q.to,
        academicYearId: q.academicYearId ?? null,
        gradeId: q.gradeId ?? null,
        sectionId: q.sectionId ?? null,
        rows,
        scope: this.schoolWide(scope) ? 'school' : 'assigned',
      },
    });
  }
}

/** The documented CSV metric columns, in order. */
export const METRIC_COLUMNS = [
  'registers_opened',
  'registers_submitted',
  'registers_open',
  'register_submission_rate',
  'eligible_student_periods',
  'marked_student_periods',
  'unmarked_student_periods',
  'present',
  'absent',
  'late',
  'approved_leave',
  'attended_student_periods',
  'attendance_rate',
  'marking_completeness',
  'distinct_students',
  'days_with_registers',
  'days_with_any_mark',
] as const;

function metricCells(r: ReportRow): CsvValue[] {
  return [
    r.registers.opened,
    r.registers.submitted,
    r.registers.open,
    r.registers.submissionRate,
    r.studentPeriods.eligible,
    r.studentPeriods.marked,
    r.studentPeriods.unmarked,
    r.studentPeriods.byStatus.present,
    r.studentPeriods.byStatus.absent,
    r.studentPeriods.byStatus.late,
    r.studentPeriods.byStatus.approved_leave,
    r.studentPeriods.attended,
    r.attendanceRate,
    r.studentPeriods.markingCompleteness,
    r.distinctStudents,
    r.registers.daysWithRegisters,
    r.daysWithAnyMark,
  ];
}

function toReportRow(a: AggregateRow): ReportRow {
  const attended = a.present + a.late;
  return {
    gradeNumber: a.gradeNumber,
    sectionId: a.sectionId,
    sectionName: a.sectionName,
    period: a.period,
    registers: {
      opened: a.registersOpened,
      submitted: a.registersSubmitted,
      open: a.registersOpened - a.registersSubmitted,
      submissionRate: ratio(a.registersSubmitted, a.registersOpened),
      daysWithRegisters: a.daysWithRegisters,
    },
    studentPeriods: {
      eligible: a.eligible,
      marked: a.marked,
      unmarked: a.eligible - a.marked,
      attended,
      byStatus: { present: a.present, absent: a.absent, late: a.late, approved_leave: a.approvedLeave },
      markingCompleteness: ratio(a.marked, a.eligible),
    },
    attendanceRate: ratio(attended, a.marked),
    distinctStudents: a.distinctStudents,
    daysWithAnyMark: a.daysWithAnyMark,
  };
}
