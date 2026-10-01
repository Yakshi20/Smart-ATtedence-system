import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNull, sql } from 'drizzle-orm';
import { isUniqueViolation, schema, type Database, type Transaction } from '@smart-school/database';
import { DomainError, ErrorCode, notVisible } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { writeAudit } from '../audit/audit';
import type { RequestMeta } from '../common/request-meta';
import { DATABASE } from '../database/database.module';
import { AcademicAccess } from './academic-access';
import { conflict, duplicate, now, translateConstraint } from './academic-common';

type StudentRow = typeof schema.students.$inferSelect;
type StudentStatus = StudentRow['status'];

export interface StudentView {
  id: string;
  studentNumber: string;
  fullName: string;
  /** Omitted for callers who see students only through a teaching assignment (least privilege). */
  dateOfBirth?: string | null;
  status: StudentStatus;
}

export interface StudentDetailView extends StudentView {
  currentEnrollments: Array<{
    enrollmentId: string;
    academicYearId: string;
    sectionId: string;
    effectiveFrom: string;
  }>;
}

const MAX_GENERATION_ATTEMPTS = 3;

@Injectable()
export class StudentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly academicAccess: AcademicAccess,
  ) {}

  /**
   * Admins list every student of their school. Teachers list only students currently enrolled
   * in a section they are actively assigned to; nothing else is reachable by paging.
   */
  async list(
    scope: SchoolScope,
    query: { status?: StudentStatus | undefined; limit: number; offset: number },
  ): Promise<{ items: StudentView[]; limit: number; offset: number }> {
    const full = this.academicAccess.seesAllStudents(scope);

    const visibleToTeacher = sql`EXISTS (
      SELECT 1 FROM ${schema.enrollments} e
      JOIN ${schema.classSubjects} cs ON cs.section_id = e.section_id
      JOIN ${schema.teacherAssignments} ta ON ta.class_subject_id = cs.id
      WHERE e.student_id = ${schema.students.id}
        AND e.effective_to IS NULL AND e.voided_at IS NULL
        AND ta.membership_id = ${scope.membershipId} AND ta.ended_at IS NULL
    )`;

    const rows = await this.db
      .select()
      .from(schema.students)
      .where(
        and(
          eq(schema.students.schoolId, scope.schoolId),
          query.status ? eq(schema.students.status, query.status) : undefined,
          full ? undefined : visibleToTeacher,
        ),
      )
      .orderBy(asc(schema.students.fullName), asc(schema.students.id))
      .limit(query.limit)
      .offset(query.offset);

    return { items: rows.map((r) => toView(r, full)), limit: query.limit, offset: query.offset };
  }

  async get(scope: SchoolScope, studentId: string): Promise<StudentDetailView> {
    await this.academicAccess.requireStudentVisible(scope, studentId);
    const full = this.academicAccess.seesAllStudents(scope);

    const [row] = await this.db
      .select()
      .from(schema.students)
      .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, scope.schoolId)));
    if (!row) throw notVisible('student');

    const current = await this.db
      .select({
        enrollmentId: schema.enrollments.id,
        academicYearId: schema.enrollments.academicYearId,
        sectionId: schema.enrollments.sectionId,
        effectiveFrom: schema.enrollments.effectiveFrom,
      })
      .from(schema.enrollments)
      .where(
        and(
          eq(schema.enrollments.studentId, studentId),
          eq(schema.enrollments.schoolId, scope.schoolId),
          isNull(schema.enrollments.effectiveTo),
          isNull(schema.enrollments.voidedAt),
        ),
      )
      .orderBy(asc(schema.enrollments.effectiveFrom));

    return { ...toView(row, full), currentEnrollments: current };
  }

  async create(
    scope: SchoolScope,
    input: { studentNumber?: string | undefined; fullName: string; dateOfBirth?: string | undefined },
    meta: RequestMeta,
  ): Promise<StudentView> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.db.transaction(async (tx) => {
          const studentNumber = input.studentNumber ?? (await this.nextStudentNumber(tx, scope.schoolId));
          const [row] = await tx
            .insert(schema.students)
            .values({
              schoolId: scope.schoolId,
              studentNumber,
              fullName: input.fullName,
              dateOfBirth: input.dateOfBirth ?? null,
              createdBy: scope.userId,
            })
            .returning();
          await writeAudit(tx, {
            action: 'student.created',
            entityType: 'student',
            entityId: row!.id,
            actorUserId: scope.userId,
            schoolId: scope.schoolId,
            requestId: meta.requestId,
            metadata: { numberGenerated: input.studentNumber === undefined },
          });
          return toView(row!, true);
        });
      } catch (err) {
        // A generated number can collide with one typed in manually at the same moment; retry.
        if (
          input.studentNumber === undefined &&
          isUniqueViolation(err, 'students_school_number_key') &&
          attempt < MAX_GENERATION_ATTEMPTS
        ) {
          continue;
        }
        translateConstraint(err, {
          students_school_number_key: duplicate('A student with this student number already exists in this school'),
        });
      }
    }
  }

  async update(
    scope: SchoolScope,
    studentId: string,
    input: { fullName?: string | undefined; dateOfBirth?: string | null | undefined },
    meta: RequestMeta,
  ): Promise<StudentView> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.students)
        .set({
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
          updatedAt: now,
        })
        .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, scope.schoolId)))
        .returning();
      if (!row) throw notVisible('student');
      await writeAudit(tx, {
        action: 'student.updated',
        entityType: 'student',
        entityId: studentId,
        actorUserId: scope.userId,
        schoolId: scope.schoolId,
        requestId: meta.requestId,
        // Which fields changed, never their values: names and birth dates stay out of the log.
        metadata: { fullNameChanged: input.fullName !== undefined, dateOfBirthChanged: input.dateOfBirth !== undefined },
      });
      return toView(row, true);
    });
  }

  /**
   * Leaving (`withdrawn`, `transferred`) ends every current placement on `effectiveDate` and
   * voids any placement that had not yet begun, in one transaction with the status change.
   * Placements in years that ended before `effectiveDate` are left as they are: they already
   * ended with their year. Returning (`active`) changes only the status.
   *
   * A transfer to another school on the platform creates a new student record there (D-06);
   * this record stays, read-only, as the history.
   */
  async changeStatus(
    scope: SchoolScope,
    studentId: string,
    input: { status: 'withdrawn' | 'transferred'; effectiveDate: string } | { status: 'active' },
    meta: RequestMeta,
  ): Promise<StudentView> {
    try {
      return await this.changeStatusInTransaction(scope, studentId, input, meta);
    } catch (err) {
      // 0004: a leaving date may not precede attendance already recorded for the pupil.
      translateConstraint(err, {
        enrollments_attendance_blocks_end: conflict(
          'Attendance is already recorded for this student on or after that date; choose a later leaving date',
        ),
        enrollments_attendance_blocks_void: conflict('A placement with recorded attendance cannot be voided'),
      });
    }
  }

  private changeStatusInTransaction(
    scope: SchoolScope,
    studentId: string,
    input: { status: 'withdrawn' | 'transferred'; effectiveDate: string } | { status: 'active' },
    meta: RequestMeta,
  ): Promise<StudentView> {
    return this.db.transaction(async (tx) => {
      const [student] = await tx
        .select()
        .from(schema.students)
        .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, scope.schoolId)))
        .for('update');
      if (!student) throw notVisible('student');
      if (student.status === input.status) {
        throw new DomainError(ErrorCode.STATE_CONFLICT, `Student is already ${input.status}`);
      }
      if (input.status !== 'active' && student.status !== 'active') {
        throw new DomainError(ErrorCode.STATE_CONFLICT, `A ${student.status} student must be readmitted first`);
      }

      let ended = 0;
      let voided = 0;
      if (input.status !== 'active') {
        ({ ended, voided } = await this.endPlacements(tx, scope, studentId, input.status, input.effectiveDate));
      }

      const [row] = await tx
        .update(schema.students)
        .set({ status: input.status, statusChangedAt: now, updatedAt: now })
        .where(eq(schema.students.id, studentId))
        .returning();

      await writeAudit(tx, {
        action: 'student.status_changed',
        entityType: 'student',
        entityId: studentId,
        actorUserId: scope.userId,
        schoolId: scope.schoolId,
        requestId: meta.requestId,
        metadata: {
          from: student.status,
          to: input.status,
          effectiveDate: input.status === 'active' ? null : input.effectiveDate,
          enrollmentsEnded: ended,
          enrollmentsVoided: voided,
        },
      });
      return toView(row!, true);
    });
  }

  private async endPlacements(
    tx: Transaction,
    scope: SchoolScope,
    studentId: string,
    status: 'withdrawn' | 'transferred',
    effectiveDate: string,
  ): Promise<{ ended: number; voided: number }> {
    const open = await tx
      .select({
        id: schema.enrollments.id,
        effectiveFrom: schema.enrollments.effectiveFrom,
        yearEnd: schema.academicYears.endDate,
        yearStatus: schema.academicYears.status,
      })
      .from(schema.enrollments)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.enrollments.academicYearId))
      .where(
        and(
          eq(schema.enrollments.studentId, studentId),
          eq(schema.enrollments.schoolId, scope.schoolId),
          isNull(schema.enrollments.effectiveTo),
          isNull(schema.enrollments.voidedAt),
          gte(schema.academicYears.endDate, effectiveDate),
        ),
      )
      .for('update', { of: schema.enrollments });

    let ended = 0;
    let voided = 0;
    for (const e of open) {
      if (e.effectiveFrom < effectiveDate) {
        await tx
          .update(schema.enrollments)
          .set({
            effectiveTo: effectiveDate,
            endReason: status === 'withdrawn' ? 'withdrawn' : 'transferred_out',
            updatedAt: now,
          })
          .where(eq(schema.enrollments.id, e.id));
        ended += 1;
      } else {
        // The placement had not started (e.g. pre-enrolled for next year): it never happened.
        await tx
          .update(schema.enrollments)
          .set({ voidedAt: now, voidReason: `Student ${status} before this placement began`, updatedAt: now })
          .where(eq(schema.enrollments.id, e.id));
        voided += 1;
      }
    }

    return { ended, voided };
  }

  /**
   * Next number from the school's counter, skipping any value already taken manually. The
   * counter row lock serializes generation within a school only.
   */
  private async nextStudentNumber(tx: Transaction, schoolId: string): Promise<string> {
    await tx.insert(schema.studentNumberCounters).values({ schoolId }).onConflictDoNothing();
    const [counter] = await tx
      .select()
      .from(schema.studentNumberCounters)
      .where(eq(schema.studentNumberCounters.schoolId, schoolId))
      .for('update');

    let n = counter!.nextValue;
    for (;;) {
      const candidate = String(n).padStart(6, '0');
      const [taken] = await tx
        .select({ id: schema.students.id })
        .from(schema.students)
        .where(and(eq(schema.students.schoolId, schoolId), eq(schema.students.studentNumber, candidate)));
      if (!taken) {
        await tx
          .update(schema.studentNumberCounters)
          .set({ nextValue: n + 1 })
          .where(eq(schema.studentNumberCounters.schoolId, schoolId));
        return candidate;
      }
      n += 1;
    }
  }
}

function toView(row: StudentRow, full: boolean): StudentView {
  return {
    id: row.id,
    studentNumber: row.studentNumber,
    fullName: row.fullName,
    ...(full ? { dateOfBirth: row.dateOfBirth } : {}),
    status: row.status,
  };
}
