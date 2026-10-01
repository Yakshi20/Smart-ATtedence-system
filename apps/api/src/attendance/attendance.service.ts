import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { isUniqueViolation, schema, type Database, type Executor, type Transaction } from '@smart-school/database';
import { Permission, roleHasPermission, ScopeType } from '@smart-school/permissions';
import { DomainError, ErrorCode, notVisible, permissionDenied, type AttendanceStatus } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { conflict, now, translateConstraint } from '../academic/academic-common';
import { resolveRoster, type RosterEntry } from '../academic/roster';
import { writeAudit } from '../audit/audit';
import type { RequestMeta } from '../common/request-meta';
import { CONFIG, type AppConfig } from '../config/env';
import { DATABASE } from '../database/database.module';
import { studentAttendance } from './student-attendance';

type SessionRow = typeof schema.attendanceSessions.$inferSelect;

export interface AttendanceSessionView {
  id: string;
  academicYearId: string;
  sectionId: string;
  sectionName: string;
  gradeNumber: number;
  classSubjectId: string;
  subjectCode: string;
  sessionDate: string;
  period: number;
  status: 'open' | 'submitted';
  submittedAt: string | null;
}

export interface RegisterEntry extends RosterEntry {
  /** null = not marked. Never shown or counted as absent (D-11). */
  status: AttendanceStatus | null;
  corrected: boolean;
}

export interface AttendanceSessionDetail extends AttendanceSessionView {
  register: RegisterEntry[];
  counts: { onRoster: number; marked: number; unmarked: number };
}

export interface CorrectionView {
  id: string;
  studentId: string;
  revision: number;
  oldStatus: AttendanceStatus | null;
  newStatus: AttendanceStatus;
  reason: string;
  correctedBy: string;
  correctedAt: string;
}

const SUBMIT_CONSTRAINTS = {
  attendance_records_session_student_key: conflict('A student was already marked in this session; nothing was saved'),
  attendance_records_enrollment_covers_date: conflict(
    'The roster changed while the register was being saved; nothing was saved — reload and resubmit',
  ),
};

const OPEN_CONSTRAINTS = {
  attendance_sessions_within_academic_year: () =>
    new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, 'The date must fall inside the academic year'),
};

/**
 * Per-period attendance (Q1).
 *
 * Policy (docs/decisions/01 §11):
 * - Registers exist only in the school's **active** academic year; planned, closed and archived
 *   years are read-only for attendance.
 * - Dates in the future (in ATTENDANCE_TIMEZONE) are refused. Teachers may go back at most
 *   ATTENDANCE_TEACHER_BACKDATE_DAYS; school admins may use any date of the active year.
 * - A teacher needs an active assignment to the session's class-subject for every read and write.
 *   School-wide staff (school.attendance.read_all) need none.
 * - A register is submitted whole: exactly the roster for the date, in one transaction, once.
 *   `Idempotency-Key` makes the submission safely retryable.
 * - After submission, changes are corrections (school.attendance.correct, reason required), each
 *   appended to attendance_corrections and to audit_logs.
 */
@Injectable()
export class AttendanceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ sessions

  /**
   * Opens the register for (class-subject, date, period), or returns the one that already exists
   * for that same class-subject — so a retried "open" never creates a duplicate. A different
   * subject already occupying that section's period is a conflict.
   */
  async open(
    scope: SchoolScope,
    input: { classSubjectId: string; sessionDate: string; period: number },
    meta: RequestMeta,
  ): Promise<{ created: boolean; session: AttendanceSessionDetail }> {
    let created = false;
    let sessionId: string;
    try {
      sessionId = await this.db.transaction(async (tx) => {
        const [cs] = await tx
          .select({
            id: schema.classSubjects.id,
            sectionId: schema.classSubjects.sectionId,
            academicYearId: schema.classSubjects.academicYearId,
          })
          .from(schema.classSubjects)
          .where(and(eq(schema.classSubjects.id, input.classSubjectId), eq(schema.classSubjects.schoolId, scope.schoolId)));
        if (!cs) throw notVisible('class subject');
        await this.requireTeaches(tx, scope, cs.id);
        await this.requireMarkableDate(tx, scope, cs.academicYearId, input.sessionDate);

        const existing = await this.findSlot(tx, cs.sectionId, input.sessionDate, input.period);
        if (existing) return this.reuseSlot(existing, cs.id);

        try {
          // A savepoint, so a lost race on the slot can be resolved inside this transaction.
          const inserted = await tx.transaction(async (sp) => {
            const [row] = await sp
              .insert(schema.attendanceSessions)
              .values({
                schoolId: scope.schoolId,
                academicYearId: cs.academicYearId,
                sectionId: cs.sectionId,
                classSubjectId: cs.id,
                sessionDate: input.sessionDate,
                period: input.period,
                createdBy: scope.userId,
              })
              .returning({ id: schema.attendanceSessions.id });
            return row!.id;
          });
          created = true;
          await this.audit(tx, scope, meta, 'attendance_session.opened', inserted, {
            classSubjectId: cs.id,
            sessionDate: input.sessionDate,
            period: input.period,
          });
          return inserted;
        } catch (err) {
          if (!isUniqueViolation(err, 'attendance_sessions_slot_key')) throw err;
          const winner = await this.findSlot(tx, cs.sectionId, input.sessionDate, input.period);
          if (!winner) throw err;
          return this.reuseSlot(winner, cs.id);
        }
      });
    } catch (err) {
      translateConstraint(err, OPEN_CONSTRAINTS);
    }
    return { created, session: await this.detail(scope, sessionId) };
  }

  async get(scope: SchoolScope, sessionId: string): Promise<AttendanceSessionDetail> {
    const session = await this.findSession(this.db, scope, sessionId);
    await this.requireTeaches(this.db, scope, session.classSubjectId, 'read');
    return this.detail(scope, sessionId);
  }

  /** School-wide staff see every session; teachers only those of class-subjects they actively teach. */
  async list(
    scope: SchoolScope,
    query: { date?: string | undefined; sectionId?: string | undefined; classSubjectId?: string | undefined; limit: number; offset: number },
  ): Promise<{ items: AttendanceSessionView[]; limit: number; offset: number }> {
    const s = schema.attendanceSessions;
    const teacherFilter = this.schoolWide(scope)
      ? undefined
      : sql`EXISTS (SELECT 1 FROM ${schema.teacherAssignments} ta
                    WHERE ta.class_subject_id = ${s.classSubjectId}
                      AND ta.membership_id = ${scope.membershipId} AND ta.ended_at IS NULL)`;
    const rows = await this.viewQuery(this.db)
      .where(
        and(
          eq(s.schoolId, scope.schoolId),
          query.date ? eq(s.sessionDate, query.date) : undefined,
          query.sectionId ? eq(s.sectionId, query.sectionId) : undefined,
          query.classSubjectId ? eq(s.classSubjectId, query.classSubjectId) : undefined,
          teacherFilter,
        ),
      )
      .orderBy(desc(s.sessionDate), asc(s.period), asc(s.id))
      .limit(query.limit)
      .offset(query.offset);
    return { items: rows.map(toView), limit: query.limit, offset: query.offset };
  }

  // ------------------------------------------------------------------ submission

  /**
   * Saves the whole register atomically.
   *
   * - Same key, same payload after success → the session is returned again (`replayed: true`).
   * - Same key, different payload → 409 IDEMPOTENCY_KEY_REUSED; nothing changes.
   * - Any other submission to a submitted session → 409; use corrections.
   * - Students must equal the roster for the date: missing or extra ids → 422, nothing saved.
   * - Any failure rolls back everything; the session stays `open`.
   */
  async submit(
    scope: SchoolScope,
    sessionId: string,
    idempotencyKey: string,
    input: { records: Array<{ studentId: string; status: AttendanceStatus }> },
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; session: AttendanceSessionDetail }> {
    const payloadHash = hashPayload(input.records);
    let replayed = false;
    try {
      await this.db.transaction(async (tx) => {
        // Serializes concurrent submissions of the same register.
        const session = await this.findSession(tx, scope, sessionId, true);
        await this.requireTeaches(tx, scope, session.classSubjectId);

        if (session.status === 'submitted') {
          if (session.submitIdempotencyKey === idempotencyKey) {
            if (session.submitPayloadHash?.equals(payloadHash)) {
              replayed = true;
              return;
            }
            throw new DomainError(
              ErrorCode.IDEMPOTENCY_KEY_REUSED,
              'This Idempotency-Key was already used with a different register',
            );
          }
          throw new DomainError(ErrorCode.STATE_CONFLICT, 'This register has already been submitted; use corrections to change it');
        }

        await this.requireMarkableDate(tx, scope, session.academicYearId, session.sessionDate);

        const roster = await resolveRoster(tx, scope.schoolId, session.sectionId, session.sessionDate);
        const byStudent = new Map(roster.map((r) => [r.studentId, r]));
        const submitted = new Set(input.records.map((r) => r.studentId));
        const missing = roster.filter((r) => !submitted.has(r.studentId)).map((r) => r.studentId);
        const extra = input.records.filter((r) => !byStudent.has(r.studentId)).map((r) => r.studentId);
        if (missing.length > 0 || extra.length > 0) {
          throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, 'The register must list exactly the students on the roster for this date', [
            ...(missing.length ? [{ path: 'records', message: `missing: ${missing.join(',')}` }] : []),
            ...(extra.length ? [{ path: 'records', message: `not on the roster: ${extra.join(',')}` }] : []),
          ]);
        }

        await tx.insert(schema.attendanceRecords).values(
          input.records.map((r) => ({
            schoolId: scope.schoolId,
            sessionId: session.id,
            sectionId: session.sectionId,
            studentId: r.studentId,
            enrollmentId: byStudent.get(r.studentId)!.enrollmentId,
            status: r.status,
            markedBy: scope.userId,
          })),
        );

        await tx
          .update(schema.attendanceSessions)
          .set({
            status: 'submitted',
            submittedBy: scope.userId,
            submittedAt: now,
            submitIdempotencyKey: idempotencyKey,
            submitPayloadHash: payloadHash,
          })
          .where(eq(schema.attendanceSessions.id, session.id));

        const counts: Record<string, number> = { present: 0, absent: 0, late: 0, approved_leave: 0 };
        for (const r of input.records) counts[r.status] = (counts[r.status] ?? 0) + 1;
        await this.audit(tx, scope, meta, 'attendance_session.submitted', session.id, {
          records: input.records.length,
          present: counts['present']!,
          absent: counts['absent']!,
          late: counts['late']!,
          approvedLeave: counts['approved_leave']!,
        });
      });
    } catch (err) {
      translateConstraint(err, SUBMIT_CONSTRAINTS);
    }
    return { replayed, session: await this.detail(scope, sessionId) };
  }

  // ------------------------------------------------------------------ corrections

  /**
   * Changes one student's status on a submitted register, or marks a student who is on the
   * roster but was never marked (e.g. enrolled with a backdated start after submission). The old
   * value, new value, reason, actor and time are appended to attendance_corrections before the
   * record changes; the database refuses a status change without that row.
   */
  async correct(
    scope: SchoolScope,
    sessionId: string,
    input: { studentId: string; status: AttendanceStatus; reason: string },
    meta: RequestMeta,
  ): Promise<CorrectionView> {
    return this.db.transaction(async (tx) => {
      const session = await this.findSession(tx, scope, sessionId, true);
      if (session.status !== 'submitted') {
        throw new DomainError(ErrorCode.STATE_CONFLICT, 'Submit the register first; corrections apply to submitted registers');
      }
      await this.requireActiveYear(tx, scope, session.academicYearId);

      const [record] = await tx
        .select()
        .from(schema.attendanceRecords)
        .where(and(eq(schema.attendanceRecords.sessionId, session.id), eq(schema.attendanceRecords.studentId, input.studentId)))
        .for('update');

      let recordId: string;
      let revision: number;
      let oldStatus: AttendanceStatus | null;

      if (record) {
        if (record.status === input.status) {
          throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, `The student is already marked ${input.status}`);
        }
        recordId = record.id;
        revision = record.revision + 1;
        oldStatus = record.status;
      } else {
        const entry = (await resolveRoster(tx, scope.schoolId, session.sectionId, session.sessionDate)).find(
          (r) => r.studentId === input.studentId,
        );
        if (!entry) throw notVisible('student on this register');
        revision = 1;
        oldStatus = null;
        const [created] = await tx
          .insert(schema.attendanceRecords)
          .values({
            schoolId: scope.schoolId,
            sessionId: session.id,
            sectionId: session.sectionId,
            studentId: entry.studentId,
            enrollmentId: entry.enrollmentId,
            status: input.status,
            revision,
            markedBy: scope.userId,
          })
          .returning({ id: schema.attendanceRecords.id });
        recordId = created!.id;
      }

      const [correction] = await tx
        .insert(schema.attendanceCorrections)
        .values({
          schoolId: scope.schoolId,
          recordId,
          revision,
          oldStatus,
          newStatus: input.status,
          reason: input.reason,
          correctedBy: scope.userId,
        })
        .returning();

      if (record) {
        await tx
          .update(schema.attendanceRecords)
          .set({ status: input.status, revision, updatedAt: now })
          .where(eq(schema.attendanceRecords.id, recordId));
      }

      // The reason stays on the access-controlled correction row; the audit log carries ids and
      // the before/after statuses only.
      await this.audit(tx, scope, meta, 'attendance.corrected', recordId, {
        sessionId: session.id,
        studentId: input.studentId,
        from: oldStatus,
        to: input.status,
        revision,
      });

      return {
        id: correction!.id,
        studentId: input.studentId,
        revision,
        oldStatus,
        newStatus: input.status,
        reason: input.reason,
        correctedBy: scope.userId,
        correctedAt: correction!.correctedAt.toISOString(),
      };
    });
  }

  async corrections(scope: SchoolScope, sessionId: string): Promise<{ items: CorrectionView[] }> {
    const session = await this.findSession(this.db, scope, sessionId);
    await this.requireTeaches(this.db, scope, session.classSubjectId, 'read');
    const rows = await this.db
      .select({ c: schema.attendanceCorrections, studentId: schema.attendanceRecords.studentId })
      .from(schema.attendanceCorrections)
      .innerJoin(schema.attendanceRecords, eq(schema.attendanceRecords.id, schema.attendanceCorrections.recordId))
      .where(and(eq(schema.attendanceRecords.sessionId, session.id), eq(schema.attendanceCorrections.schoolId, scope.schoolId)))
      .orderBy(asc(schema.attendanceCorrections.correctedAt), asc(schema.attendanceCorrections.revision));
    return {
      items: rows.map((r) => ({
        id: r.c.id,
        studentId: r.studentId,
        revision: r.c.revision,
        oldStatus: r.c.oldStatus,
        newStatus: r.c.newStatus,
        reason: r.c.reason,
        correctedBy: r.c.correctedBy,
        correctedAt: r.c.correctedAt.toISOString(),
      })),
    };
  }

  // ------------------------------------------------------------------ per-student

  /** School-wide view of one student's attendance. The caller must hold school.students.read. */
  async forStudent(scope: SchoolScope, studentId: string, range: { from: string; to: string }) {
    const [student] = await this.db
      .select({ id: schema.students.id })
      .from(schema.students)
      .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, scope.schoolId)));
    if (!student) throw notVisible('student');
    return studentAttendance(this.db, { schoolId: scope.schoolId, studentId, ...range });
  }

  // ------------------------------------------------------------------ helpers

  private schoolWide(scope: SchoolScope): boolean {
    return roleHasPermission(ScopeType.SCHOOL, scope.role, Permission.SCHOOL_ATTENDANCE_READ_ALL);
  }

  /**
   * Teachers need an active assignment to the class-subject. The class-subject itself is visible
   * to them (academic structure), so its absence is 403, not 404 (D-19).
   */
  private async requireTeaches(executor: Executor, scope: SchoolScope, classSubjectId: string, action: 'read' | 'mark' = 'mark') {
    if (this.schoolWide(scope)) return;
    const [assignment] = await executor
      .select({ id: schema.teacherAssignments.id })
      .from(schema.teacherAssignments)
      .where(
        and(
          eq(schema.teacherAssignments.classSubjectId, classSubjectId),
          eq(schema.teacherAssignments.membershipId, scope.membershipId),
          eq(schema.teacherAssignments.schoolId, scope.schoolId),
          isNull(schema.teacherAssignments.endedAt),
        ),
      )
      .limit(1);
    if (!assignment) throw permissionDenied(action === 'read' ? 'read this register' : 'take attendance for this class');
  }

  private async requireActiveYear(tx: Executor, scope: SchoolScope, yearId: string) {
    const [year] = await tx
      .select()
      .from(schema.academicYears)
      .where(and(eq(schema.academicYears.id, yearId), eq(schema.academicYears.schoolId, scope.schoolId)))
      .for('share');
    if (!year) throw notVisible('academic year');
    if (year.status !== 'active') {
      throw new DomainError(ErrorCode.STATE_CONFLICT, `Attendance can only be recorded in the active academic year; this year is ${year.status}`);
    }
    return year;
  }

  private async requireMarkableDate(tx: Executor, scope: SchoolScope, yearId: string, date: string): Promise<void> {
    const year = await this.requireActiveYear(tx, scope, yearId);
    if (date < year.startDate || date > year.endDate) {
      throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, `The date must fall inside the academic year (${year.startDate} to ${year.endDate})`);
    }
    const { rows } = await tx.execute<{ today: string }>(
      sql`SELECT (now() AT TIME ZONE ${this.config.ATTENDANCE_TIMEZONE})::date::text AS today`,
    );
    const today = rows[0]!.today;
    if (date > today) throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, 'Attendance cannot be recorded for a future date');

    if (!this.schoolWide(scope)) {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - this.config.ATTENDANCE_TEACHER_BACKDATE_DAYS);
      const earliest = d.toISOString().slice(0, 10);
      if (date < earliest) {
        throw new DomainError(
          ErrorCode.BUSINESS_RULE_VIOLATION,
          `Teachers may record attendance up to ${this.config.ATTENDANCE_TEACHER_BACKDATE_DAYS} days back; ask a school admin`,
        );
      }
    }
  }

  private async findSession(executor: Executor, scope: SchoolScope, sessionId: string, lock = false): Promise<SessionRow> {
    const query = executor
      .select()
      .from(schema.attendanceSessions)
      .where(and(eq(schema.attendanceSessions.id, sessionId), eq(schema.attendanceSessions.schoolId, scope.schoolId)));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw notVisible('attendance session');
    return row;
  }

  private async findSlot(tx: Transaction, sectionId: string, date: string, period: number) {
    const [row] = await tx
      .select({ id: schema.attendanceSessions.id, classSubjectId: schema.attendanceSessions.classSubjectId })
      .from(schema.attendanceSessions)
      .where(
        and(
          eq(schema.attendanceSessions.sectionId, sectionId),
          eq(schema.attendanceSessions.sessionDate, date),
          eq(schema.attendanceSessions.period, period),
        ),
      );
    return row;
  }

  private reuseSlot(existing: { id: string; classSubjectId: string }, classSubjectId: string): string {
    if (existing.classSubjectId !== classSubjectId) {
      throw new DomainError(ErrorCode.STATE_CONFLICT, 'Another subject already has a register for this section, date and period');
    }
    return existing.id;
  }

  private viewQuery(executor: Executor) {
    const s = schema.attendanceSessions;
    return executor
      .select({
        session: s,
        sectionName: schema.sections.name,
        gradeNumber: schema.grades.gradeNumber,
        subjectCode: schema.subjects.code,
      })
      .from(s)
      .innerJoin(schema.sections, eq(schema.sections.id, s.sectionId))
      .innerJoin(schema.grades, eq(schema.grades.id, schema.sections.gradeId))
      .innerJoin(schema.classSubjects, eq(schema.classSubjects.id, s.classSubjectId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.classSubjects.subjectId))
      .$dynamic();
  }

  /**
   * The register: everyone on the roster for the session date, with their recorded status or
   * null (unmarked). Recorded students are always shown, even in the unlikely case they are no
   * longer on the roster, so nothing recorded is ever hidden.
   */
  private async detail(scope: SchoolScope, sessionId: string): Promise<AttendanceSessionDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(schema.attendanceSessions.id, sessionId), eq(schema.attendanceSessions.schoolId, scope.schoolId)),
    );
    if (!row) throw notVisible('attendance session');
    const view = toView(row);

    const roster = await resolveRoster(this.db, scope.schoolId, view.sectionId, view.sessionDate);
    const records = await this.db
      .select({
        studentId: schema.attendanceRecords.studentId,
        enrollmentId: schema.attendanceRecords.enrollmentId,
        status: schema.attendanceRecords.status,
        revision: schema.attendanceRecords.revision,
        studentNumber: schema.students.studentNumber,
        fullName: schema.students.fullName,
        effectiveFrom: schema.enrollments.effectiveFrom,
      })
      .from(schema.attendanceRecords)
      .innerJoin(schema.students, eq(schema.students.id, schema.attendanceRecords.studentId))
      .innerJoin(schema.enrollments, eq(schema.enrollments.id, schema.attendanceRecords.enrollmentId))
      .where(eq(schema.attendanceRecords.sessionId, sessionId));
    const recorded = new Map(records.map((r) => [r.studentId, r]));

    const register: RegisterEntry[] = roster.map((r) => {
      const rec = recorded.get(r.studentId);
      recorded.delete(r.studentId);
      return { ...r, status: rec?.status ?? null, corrected: (rec?.revision ?? 0) > 0 };
    });
    for (const rec of recorded.values()) {
      register.push({
        studentId: rec.studentId,
        studentNumber: rec.studentNumber,
        fullName: rec.fullName,
        enrollmentId: rec.enrollmentId,
        effectiveFrom: rec.effectiveFrom,
        status: rec.status,
        corrected: rec.revision > 0,
      });
    }
    const marked = register.filter((r) => r.status !== null).length;
    return { ...view, register, counts: { onRoster: roster.length, marked, unmarked: register.length - marked } };
  }

  private audit(
    tx: Executor,
    scope: SchoolScope,
    meta: RequestMeta,
    action: string,
    entityId: string,
    metadata: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    return writeAudit(tx, {
      action,
      entityType: action.startsWith('attendance_session') ? 'attendance_session' : 'attendance_record',
      entityId,
      actorUserId: scope.userId,
      schoolId: scope.schoolId,
      requestId: meta.requestId,
      metadata,
    });
  }
}

function toView(row: {
  session: SessionRow;
  sectionName: string;
  gradeNumber: number;
  subjectCode: string;
}): AttendanceSessionView {
  return {
    id: row.session.id,
    academicYearId: row.session.academicYearId,
    sectionId: row.session.sectionId,
    sectionName: row.sectionName,
    gradeNumber: row.gradeNumber,
    classSubjectId: row.session.classSubjectId,
    subjectCode: row.subjectCode,
    sessionDate: row.session.sessionDate,
    period: row.session.period,
    status: row.session.status,
    submittedAt: row.session.submittedAt?.toISOString() ?? null,
  };
}

/** SHA-256 over the register in a canonical order, so key reuse is judged on content, not key order. */
function hashPayload(records: Array<{ studentId: string; status: string }>): Buffer {
  const canonical = [...records]
    .sort((a, b) => (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0))
    .map((r) => [r.studentId, r.status]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest();
}
