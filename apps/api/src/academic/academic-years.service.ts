import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@smart-school/database';
import { DomainError, ErrorCode, notVisible } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { writeAudit } from '../audit/audit';
import type { RequestMeta } from '../common/request-meta';
import { DATABASE } from '../database/database.module';
import { conflict, duplicate, findYear, now, translateConstraint, type AcademicYearRow } from './academic-common';

type YearStatus = AcademicYearRow['status'];

export interface AcademicYearView {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: YearStatus;
}

/**
 * Lifecycle: planned → active → closed → archived. One direction only.
 *
 * - planned: being prepared. Name and dates editable (dates only while nothing is enrolled).
 * - active: the year in day-to-day use. At most one per school (partial unique index).
 * - closed: finished. Structure, enrolments and assignments become read-only.
 * - archived: closed and hidden from default listings.
 *
 * Reopening a closed year is intentionally not offered: it would let finished history change.
 * A mistake is corrected by a platform-supported, audited process (backlog).
 */
const TRANSITIONS: Record<'open' | 'close' | 'archive', { from: YearStatus; to: YearStatus }> = {
  open: { from: 'planned', to: 'active' },
  close: { from: 'active', to: 'closed' },
  archive: { from: 'closed', to: 'archived' },
};

const YEAR_CONSTRAINTS = {
  academic_years_school_name_key: duplicate('An academic year with this name already exists'),
  academic_years_no_overlap: conflict('Academic year dates overlap another academic year'),
  academic_years_one_active_per_school: conflict('Another academic year is already active'),
  academic_years_dates_ordered: () => new DomainError(ErrorCode.VALIDATION_FAILED, 'endDate must be after startDate'),
  academic_years_span_reasonable: () => new DomainError(ErrorCode.VALIDATION_FAILED, 'year span is too long'),
};

@Injectable()
export class AcademicYearsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(scope: SchoolScope, status?: YearStatus): Promise<AcademicYearView[]> {
    const rows = await this.db
      .select()
      .from(schema.academicYears)
      .where(
        and(
          eq(schema.academicYears.schoolId, scope.schoolId),
          // Archived years are hidden unless asked for explicitly.
          status ? eq(schema.academicYears.status, status) : ne(schema.academicYears.status, 'archived'),
        ),
      )
      .orderBy(asc(schema.academicYears.startDate));
    return rows.map(toView);
  }

  async get(scope: SchoolScope, yearId: string): Promise<AcademicYearView> {
    return toView(await findYear(this.db, scope, yearId));
  }

  async create(
    scope: SchoolScope,
    input: { name: string; startDate: string; endDate: string },
    meta: RequestMeta,
  ): Promise<AcademicYearView> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.academicYears)
          .values({ ...input, schoolId: scope.schoolId, createdBy: scope.userId })
          .returning();
        await writeAudit(tx, {
          action: 'academic_year.created',
          entityType: 'academic_year',
          entityId: row!.id,
          actorUserId: scope.userId,
          schoolId: scope.schoolId,
          requestId: meta.requestId,
          metadata: { startDate: input.startDate, endDate: input.endDate },
        });
        return toView(row!);
      });
    } catch (err) {
      translateConstraint(err, YEAR_CONSTRAINTS);
    }
  }

  async update(
    scope: SchoolScope,
    yearId: string,
    input: { name?: string | undefined; startDate?: string | undefined; endDate?: string | undefined },
    meta: RequestMeta,
  ): Promise<AcademicYearView> {
    try {
      return await this.db.transaction(async (tx) => {
        const [year] = await tx
          .select()
          .from(schema.academicYears)
          .where(and(eq(schema.academicYears.id, yearId), eq(schema.academicYears.schoolId, scope.schoolId)))
          .for('update');
        if (!year) throw notVisible('academic year');
        if (year.status !== 'planned') {
          throw new DomainError(ErrorCode.STATE_CONFLICT, 'Only a planned academic year can be edited');
        }

        const startDate = input.startDate ?? year.startDate;
        const endDate = input.endDate ?? year.endDate;
        if (endDate <= startDate) {
          throw new DomainError(ErrorCode.VALIDATION_FAILED, 'endDate must be after startDate', [
            { path: 'endDate', message: 'must be after startDate' },
          ]);
        }

        const datesChanged = startDate !== year.startDate || endDate !== year.endDate;
        if (datesChanged) {
          // Moving the bounds under existing enrolments would silently strand them outside the year.
          const [{ n } = { n: 0 }] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.enrollments)
            .where(eq(schema.enrollments.academicYearId, yearId));
          if (n > 0) {
            throw new DomainError(ErrorCode.STATE_CONFLICT, 'Dates cannot change once students are enrolled');
          }
        }

        const [row] = await tx
          .update(schema.academicYears)
          .set({ name: input.name ?? year.name, startDate, endDate, updatedAt: now })
          .where(eq(schema.academicYears.id, yearId))
          .returning();

        await writeAudit(tx, {
          action: 'academic_year.updated',
          entityType: 'academic_year',
          entityId: yearId,
          actorUserId: scope.userId,
          schoolId: scope.schoolId,
          requestId: meta.requestId,
          metadata: {
            fromStartDate: year.startDate,
            fromEndDate: year.endDate,
            toStartDate: startDate,
            toEndDate: endDate,
            renamed: row!.name !== year.name,
          },
        });
        return toView(row!);
      });
    } catch (err) {
      translateConstraint(err, YEAR_CONSTRAINTS);
    }
  }

  async transition(
    scope: SchoolScope,
    yearId: string,
    action: keyof typeof TRANSITIONS,
    meta: RequestMeta,
  ): Promise<AcademicYearView> {
    const { from, to } = TRANSITIONS[action];
    try {
      return await this.db.transaction(async (tx) => {
        // FOR UPDATE conflicts with the FOR SHARE taken by structural writes, so a year cannot
        // close underneath an enrolment that is being written.
        const [year] = await tx
          .select()
          .from(schema.academicYears)
          .where(and(eq(schema.academicYears.id, yearId), eq(schema.academicYears.schoolId, scope.schoolId)))
          .for('update');
        if (!year) throw notVisible('academic year');
        if (year.status !== from) {
          throw new DomainError(ErrorCode.STATE_CONFLICT, `Cannot ${action} an academic year that is ${year.status}`);
        }

        const [row] = await tx
          .update(schema.academicYears)
          .set({ status: to, updatedAt: now })
          .where(eq(schema.academicYears.id, yearId))
          .returning();

        await writeAudit(tx, {
          action: `academic_year.${action === 'open' ? 'opened' : action === 'close' ? 'closed' : 'archived'}`,
          entityType: 'academic_year',
          entityId: yearId,
          actorUserId: scope.userId,
          schoolId: scope.schoolId,
          requestId: meta.requestId,
          metadata: { from, to },
        });
        return toView(row!);
      });
    } catch (err) {
      translateConstraint(err, YEAR_CONSTRAINTS);
    }
  }
}

function toView(row: AcademicYearRow): AcademicYearView {
  return { id: row.id, name: row.name, startDate: row.startDate, endDate: row.endDate, status: row.status };
}
