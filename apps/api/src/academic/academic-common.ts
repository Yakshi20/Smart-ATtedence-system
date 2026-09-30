import { and, eq, sql } from 'drizzle-orm';
import { schema, violatedConstraint, type Executor } from '@smart-school/database';
import { DomainError, ErrorCode, notVisible } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';

export type AcademicYearRow = typeof schema.academicYears.$inferSelect;

/**
 * Loads an academic year of the caller's school that still accepts structural writes, and
 * takes a SHARE lock on it so a concurrent close cannot slip in between the check and the write.
 *
 * - Not in the caller's school (or does not exist) → 404.
 * - Closed or archived → 409: history of a finished year is read-only.
 */
export async function lockWritableYear(tx: Executor, scope: SchoolScope, yearId: string): Promise<AcademicYearRow> {
  const [year] = await tx
    .select()
    .from(schema.academicYears)
    .where(and(eq(schema.academicYears.id, yearId), eq(schema.academicYears.schoolId, scope.schoolId)))
    .for('share');
  if (!year) throw notVisible('academic year');
  if (year.status !== 'planned' && year.status !== 'active') {
    throw new DomainError(ErrorCode.STATE_CONFLICT, `Academic year is ${year.status} and can no longer be changed`);
  }
  return year;
}

export async function findYear(tx: Executor, scope: SchoolScope, yearId: string): Promise<AcademicYearRow> {
  const [year] = await tx
    .select()
    .from(schema.academicYears)
    .where(and(eq(schema.academicYears.id, yearId), eq(schema.academicYears.schoolId, scope.schoolId)));
  if (!year) throw notVisible('academic year');
  return year;
}

/**
 * Translates a named database constraint into the API error for it. Unknown errors are
 * rethrown untouched and become a generic 500: a constraint name is never sent to the client.
 */
export function translateConstraint(err: unknown, map: Record<string, () => DomainError>): never {
  const name = violatedConstraint(err);
  const make = name ? map[name] : undefined;
  if (make) throw make();
  throw err;
}

export const conflict = (message: string) => () => new DomainError(ErrorCode.STATE_CONFLICT, message);
export const duplicate = (message: string) => () => new DomainError(ErrorCode.DUPLICATE_RESOURCE, message);
export const businessRule = (message: string) => () => new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, message);

/** `now()` as an SQL expression, for updated_at columns. */
export const now = sql`now()`;
