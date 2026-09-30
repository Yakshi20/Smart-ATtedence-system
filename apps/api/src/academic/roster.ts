import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { schema, type Executor } from '@smart-school/database';

export interface RosterEntry {
  studentId: string;
  studentNumber: string;
  fullName: string;
  enrollmentId: string;
  effectiveFrom: string;
}

/**
 * The single definition of "who is in this section on this date" (D-12, D-13).
 *
 * A student is on the roster when a live (non-voided) enrolment in the section covers the date:
 * `effective_from <= date < effective_to` (open-ended when `effective_to` is null), and the date
 * is not past the end of that enrolment's academic year. The student's *current* status is not a
 * filter: a pupil who withdrew in December is still on November's roster.
 *
 * Used by the section roster endpoint and by attendance, so both always agree. The caller is
 * responsible for authorization; `schoolId` must come from a resolved SchoolScope.
 */
export function resolveRoster(
  executor: Executor,
  schoolId: string,
  sectionId: string,
  date: string,
  page?: { limit: number; offset: number },
): Promise<RosterEntry[]> {
  const query = executor
    .select({
      studentId: schema.students.id,
      studentNumber: schema.students.studentNumber,
      fullName: schema.students.fullName,
      enrollmentId: schema.enrollments.id,
      effectiveFrom: schema.enrollments.effectiveFrom,
    })
    .from(schema.enrollments)
    .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
    .innerJoin(schema.academicYears, eq(schema.academicYears.id, schema.enrollments.academicYearId))
    .where(
      and(
        eq(schema.enrollments.schoolId, schoolId),
        eq(schema.enrollments.sectionId, sectionId),
        isNull(schema.enrollments.voidedAt),
        lte(schema.enrollments.effectiveFrom, date),
        or(isNull(schema.enrollments.effectiveTo), gt(schema.enrollments.effectiveTo, date)),
        sql`${schema.academicYears.endDate} >= ${date}::date`,
      ),
    )
    .orderBy(asc(schema.students.fullName), asc(schema.students.id));
  return page ? query.limit(page.limit).offset(page.offset) : query;
}
