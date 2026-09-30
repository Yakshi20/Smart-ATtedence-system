import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema, type Database, type Transaction } from '@smart-school/database';
import { DomainError, ErrorCode, notVisible } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { writeAudit } from '../audit/audit';
import type { RequestMeta } from '../common/request-meta';
import { DATABASE } from '../database/database.module';
import { AcademicAccess } from './academic-access';
import { resolveRoster, type RosterEntry } from './roster';
import { businessRule, conflict, findYear, lockWritableYear, now, translateConstraint } from './academic-common';

type EnrollmentRow = typeof schema.enrollments.$inferSelect;

export interface EnrollmentView {
  id: string;
  studentId: string;
  academicYearId: string;
  sectionId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  endReason: EnrollmentRow['endReason'];
  voided: boolean;
  previousEnrollmentId: string | null;
}

export interface EnrollmentHistoryItem extends EnrollmentView {
  academicYearName: string;
  gradeNumber: number;
  sectionName: string;
  voidReason: string | null;
}


export type { RosterEntry };

const ENROLLMENT_CONSTRAINTS = {
  enrollments_no_overlap: conflict('The student already has an enrolment covering this period'),
  enrollments_one_open_per_student_year: conflict('The student already has a current enrolment in this academic year'),
  enrollments_within_academic_year: businessRule('Enrolment dates must fall inside the academic year'),
  // 0004: enrolment history may not contradict recorded attendance.
  enrollments_attendance_blocks_end: conflict(
    'Attendance is already recorded in this section on or after that date; choose a later date',
  ),
  enrollments_attendance_blocks_void: conflict(
    'This enrolment has recorded attendance and cannot be voided; transfer the student instead',
  ),
};

/** Day after `date` (YYYY-MM-DD), without timezone arithmetic. */
function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Enrolments are history (D-12). The API never edits a placement in place:
 *
 * - enrol: opens [effectiveFrom, ∞) in a section.
 * - transfer: ends the current row on the transfer date and opens a new one in another section
 *   of the same year, linked by `previous_enrollment_id`.
 * - promote: ends the row at its year's end and opens one in a later year, linked the same way.
 * - void: marks a mistaken row as never having happened, with a reason. The row stays.
 * - leaving the school: see StudentsService.changeStatus.
 *
 * Every operation is one transaction, locks the rows it reads, writes an audit entry with ids
 * and dates (never names), and is backed by database constraints and triggers that refuse
 * overlaps, out-of-year dates, cross-school links, deletes and rewrites.
 */
@Injectable()
export class EnrollmentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly academicAccess: AcademicAccess,
  ) {}

  async enrol(
    scope: SchoolScope,
    yearId: string,
    input: { studentId: string; sectionId: string; effectiveFrom: string },
    meta: RequestMeta,
  ): Promise<EnrollmentView> {
    try {
      return await this.db.transaction(async (tx) => {
        const year = await lockWritableYear(tx, scope, yearId);
        // Locking the student serializes concurrent enrolments of the same pupil.
        const student = await this.lockActiveStudent(tx, scope, input.studentId);
        await this.findSectionInYear(tx, scope, input.sectionId, yearId);
        this.requireWithinYear(input.effectiveFrom, year.startDate, year.endDate);

        const [row] = await tx
          .insert(schema.enrollments)
          .values({
            schoolId: scope.schoolId,
            studentId: student.id,
            academicYearId: yearId,
            sectionId: input.sectionId,
            effectiveFrom: input.effectiveFrom,
            createdBy: scope.userId,
          })
          .returning();

        await this.audit(tx, scope, meta, 'enrollment.created', row!.id, {
          studentId: student.id,
          sectionId: input.sectionId,
          effectiveFrom: input.effectiveFrom,
        });
        return toView(row!);
      });
    } catch (err) {
      translateConstraint(err, ENROLLMENT_CONSTRAINTS);
    }
  }

  async transfer(
    scope: SchoolScope,
    enrollmentId: string,
    input: { sectionId: string; effectiveDate: string },
    meta: RequestMeta,
  ): Promise<EnrollmentView> {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await this.lockEnrollment(tx, scope, enrollmentId);
        if (current.voidedAt || current.effectiveTo) {
          throw new DomainError(ErrorCode.STATE_CONFLICT, 'Only a current enrolment can be transferred');
        }
        const year = await lockWritableYear(tx, scope, current.academicYearId);
        await this.lockActiveStudent(tx, scope, current.studentId);

        const target = await this.findSectionInSchool(tx, scope, input.sectionId);
        if (target.academicYearId !== current.academicYearId) {
          throw new DomainError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'A section transfer stays within one academic year; use promotion to move between years',
          );
        }
        if (target.id === current.sectionId) {
          throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, 'The student is already in this section');
        }
        if (input.effectiveDate <= current.effectiveFrom) {
          throw new DomainError(
            ErrorCode.BUSINESS_RULE_VIOLATION,
            'A transfer must take effect after the enrolment began; void the enrolment to correct a wrong placement',
          );
        }
        this.requireWithinYear(input.effectiveDate, year.startDate, year.endDate);

        await tx
          .update(schema.enrollments)
          .set({ effectiveTo: input.effectiveDate, endReason: 'section_transfer', updatedAt: now })
          .where(eq(schema.enrollments.id, current.id));

        const [next] = await tx
          .insert(schema.enrollments)
          .values({
            schoolId: scope.schoolId,
            studentId: current.studentId,
            academicYearId: current.academicYearId,
            sectionId: target.id,
            effectiveFrom: input.effectiveDate,
            previousEnrollmentId: current.id,
            createdBy: scope.userId,
          })
          .returning();

        await this.audit(tx, scope, meta, 'enrollment.transferred', next!.id, {
          studentId: current.studentId,
          previousEnrollmentId: current.id,
          fromSectionId: current.sectionId,
          toSectionId: target.id,
          effectiveDate: input.effectiveDate,
        });
        return toView(next!);
      });
    } catch (err) {
      translateConstraint(err, ENROLLMENT_CONSTRAINTS);
    }
  }

  /**
   * Correction path for a placement entered by mistake. The row is kept with its reason; it
   * simply stops counting as a placement. Only the latest row of a chain may be voided, so a
   * chain never points back at a void.
   */
  async void(scope: SchoolScope, enrollmentId: string, input: { reason: string }, meta: RequestMeta): Promise<EnrollmentView> {
    try {
      return await this.voidInTransaction(scope, enrollmentId, input, meta);
    } catch (err) {
      translateConstraint(err, ENROLLMENT_CONSTRAINTS);
    }
  }

  private voidInTransaction(
    scope: SchoolScope,
    enrollmentId: string,
    input: { reason: string },
    meta: RequestMeta,
  ): Promise<EnrollmentView> {
    return this.db.transaction(async (tx) => {
      const row = await this.lockEnrollment(tx, scope, enrollmentId);
      if (row.voidedAt) throw new DomainError(ErrorCode.STATE_CONFLICT, 'Enrolment is already voided');
      await lockWritableYear(tx, scope, row.academicYearId);

      const [successor] = await tx
        .select({ id: schema.enrollments.id })
        .from(schema.enrollments)
        .where(and(eq(schema.enrollments.previousEnrollmentId, row.id), isNull(schema.enrollments.voidedAt)));
      if (successor) {
        throw new DomainError(ErrorCode.STATE_CONFLICT, 'A later enrolment continues from this one; void that first');
      }

      const [updated] = await tx
        .update(schema.enrollments)
        .set({ voidedAt: now, voidReason: input.reason, updatedAt: now })
        .where(eq(schema.enrollments.id, row.id))
        .returning();

      // The reason stays on the enrolment row, which is access-controlled; the audit log carries
      // only identifiers.
      await this.audit(tx, scope, meta, 'enrollment.voided', row.id, {
        studentId: row.studentId,
        sectionId: row.sectionId,
      });
      return toView(updated!);
    });
  }

  /**
   * Moves students into a later academic year, all-or-nothing. Each source enrolment must be the
   * student's current one; it is ended on the day after its year's last day. The target class
   * must not be lower than the source class (repeating a class is allowed: same grade).
   */
  async promote(
    scope: SchoolScope,
    targetYearId: string,
    input: { effectiveFrom: string; items: Array<{ enrollmentId: string; sectionId: string }> },
    meta: RequestMeta,
  ): Promise<{ items: EnrollmentView[] }> {
    try {
      return await this.db.transaction(async (tx) => {
        const target = await lockWritableYear(tx, scope, targetYearId);
        this.requireWithinYear(input.effectiveFrom, target.startDate, target.endDate);

        const created: EnrollmentView[] = [];
        for (const [index, item] of input.items.entries()) {
          const fail = (message: string, field = 'enrollmentId'): never => {
            throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, message, [
              { path: `items.${index}.${field}`, message },
            ]);
          };

          const source = await this.lockEnrollment(tx, scope, item.enrollmentId);
          if (source.voidedAt || source.effectiveTo) fail('Only a current enrolment can be promoted');
          const sourceYear = await findYear(tx, scope, source.academicYearId);
          if (sourceYear.endDate >= target.startDate) fail('The target academic year must start after the source year ends');
          await this.lockActiveStudent(tx, scope, source.studentId);

          const sourceSection = await this.findSectionInSchool(tx, scope, source.sectionId);
          const targetSection = await this.findSectionInSchool(tx, scope, item.sectionId);
          if (targetSection.academicYearId !== targetYearId) fail('Target section is not in the target year', 'sectionId');
          if (targetSection.gradeNumber < sourceSection.gradeNumber) {
            fail('Promotion cannot move a student to a lower class', 'sectionId');
          }

          await tx
            .update(schema.enrollments)
            .set({ effectiveTo: dayAfter(sourceYear.endDate), endReason: 'promoted', updatedAt: now })
            .where(eq(schema.enrollments.id, source.id));

          const [next] = await tx
            .insert(schema.enrollments)
            .values({
              schoolId: scope.schoolId,
              studentId: source.studentId,
              academicYearId: targetYearId,
              sectionId: targetSection.id,
              effectiveFrom: input.effectiveFrom,
              previousEnrollmentId: source.id,
              createdBy: scope.userId,
            })
            .returning();

          await this.audit(tx, scope, meta, 'enrollment.promoted', next!.id, {
            studentId: source.studentId,
            previousEnrollmentId: source.id,
            fromGrade: sourceSection.gradeNumber,
            toGrade: targetSection.gradeNumber,
            toSectionId: targetSection.id,
          });
          created.push(toView(next!));
        }
        return { items: created };
      });
    } catch (err) {
      translateConstraint(err, ENROLLMENT_CONSTRAINTS);
    }
  }

  /** Full placement history of one student, voided rows included and flagged. */
  async history(scope: SchoolScope, studentId: string): Promise<{ items: EnrollmentHistoryItem[] }> {
    await this.academicAccess.requireStudentVisible(scope, studentId);
    const rows = await this.db
      .select({
        e: schema.enrollments,
        academicYearName: schema.academicYears.name,
        gradeNumber: schema.grades.gradeNumber,
        sectionName: schema.sections.name,
      })
      .from(schema.enrollments)
      .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.enrollments.academicYearId))
      .innerJoin(schema.sections, eq(schema.sections.id, schema.enrollments.sectionId))
      .innerJoin(schema.grades, eq(schema.grades.id, schema.sections.gradeId))
      .where(and(eq(schema.enrollments.studentId, studentId), eq(schema.enrollments.schoolId, scope.schoolId)))
      .orderBy(asc(schema.enrollments.effectiveFrom), asc(schema.enrollments.createdAt));

    return {
      items: rows.map((r) => ({
        ...toView(r.e),
        academicYearName: r.academicYearName,
        gradeNumber: r.gradeNumber,
        sectionName: r.sectionName,
        voidReason: r.e.voidReason,
      })),
    };
  }

  /**
   * The students placed in a section on a given date: live (non-voided) enrolments whose range
   * covers the date, inside the year's bounds. Current student status is deliberately not a
   * filter — a pupil who withdrew in October still belongs on September's roster (D-12, D-13).
   */
  async roster(
    scope: SchoolScope,
    sectionId: string,
    query: { date: string; limit: number; offset: number },
  ): Promise<{ date: string; items: RosterEntry[]; limit: number; offset: number }> {
    await this.academicAccess.requireRosterAccess(scope, sectionId);

    const items = await resolveRoster(this.db, scope.schoolId, sectionId, query.date, query);
    return { date: query.date, items, limit: query.limit, offset: query.offset };
  }

  // ------------------------------------------------------------------------ helpers

  private async lockEnrollment(tx: Transaction, scope: SchoolScope, enrollmentId: string): Promise<EnrollmentRow> {
    const [row] = await tx
      .select()
      .from(schema.enrollments)
      .where(and(eq(schema.enrollments.id, enrollmentId), eq(schema.enrollments.schoolId, scope.schoolId)))
      .for('update');
    if (!row) throw notVisible('enrollment');
    return row;
  }

  private async lockActiveStudent(tx: Transaction, scope: SchoolScope, studentId: string) {
    const [student] = await tx
      .select()
      .from(schema.students)
      .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, scope.schoolId)))
      .for('update');
    if (!student) throw notVisible('student');
    if (student.status !== 'active') {
      throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, `A ${student.status} student cannot be enrolled`);
    }
    return student;
  }

  private async findSectionInSchool(tx: Transaction, scope: SchoolScope, sectionId: string) {
    const [section] = await tx
      .select({
        id: schema.sections.id,
        academicYearId: schema.sections.academicYearId,
        gradeNumber: schema.grades.gradeNumber,
      })
      .from(schema.sections)
      .innerJoin(schema.grades, eq(schema.grades.id, schema.sections.gradeId))
      .where(and(eq(schema.sections.id, sectionId), eq(schema.sections.schoolId, scope.schoolId)));
    if (!section) throw notVisible('section');
    return section;
  }

  private async findSectionInYear(tx: Transaction, scope: SchoolScope, sectionId: string, yearId: string) {
    const section = await this.findSectionInSchool(tx, scope, sectionId);
    if (section.academicYearId !== yearId) throw notVisible('section');
    return section;
  }

  private requireWithinYear(date: string, start: string, end: string): void {
    if (date < start || date > end) {
      throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, `Date must fall inside the academic year (${start} to ${end})`);
    }
  }

  private audit(
    tx: Transaction,
    scope: SchoolScope,
    meta: RequestMeta,
    action: string,
    enrollmentId: string,
    metadata: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    return writeAudit(tx, {
      action,
      entityType: 'enrollment',
      entityId: enrollmentId,
      actorUserId: scope.userId,
      schoolId: scope.schoolId,
      requestId: meta.requestId,
      metadata,
    });
  }
}

function toView(row: EnrollmentRow): EnrollmentView {
  return {
    id: row.id,
    studentId: row.studentId,
    academicYearId: row.academicYearId,
    sectionId: row.sectionId,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    endReason: row.endReason,
    voided: row.voidedAt !== null,
    previousEnrollmentId: row.previousEnrollmentId,
  };
}
