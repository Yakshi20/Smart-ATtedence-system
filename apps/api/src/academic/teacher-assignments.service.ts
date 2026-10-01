import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@smart-school/database';
import { Permission, roleHasPermission, ScopeType, TEACHING_ROLES } from '@smart-school/permissions';
import { DomainError, ErrorCode, notVisible } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { writeAudit } from '../audit/audit';
import type { RequestMeta } from '../common/request-meta';
import { DATABASE } from '../database/database.module';
import { conflict, lockWritableYear, translateConstraint } from './academic-common';

export interface TeacherAssignmentView {
  id: string;
  academicYearId: string;
  classSubjectId: string;
  sectionId: string;
  sectionName: string;
  gradeNumber: number;
  subjectId: string;
  subjectCode: string;
  membershipId: string;
  teacherUserId: string;
  teacherName: string;
  assignedAt: string;
  endedAt: string | null;
}

/**
 * Teacher → class-subject assignments (Q1: per-subject). An assignment is what lets a teacher
 * see a section's roster and its students; ending it removes that access on the next request.
 * Assignments are ended, never deleted, so "who taught 5A maths in 2026" stays answerable.
 */
@Injectable()
export class TeacherAssignmentsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Admins see every assignment; teachers only their own. */
  async list(
    scope: SchoolScope,
    query: { academicYearId?: string | undefined; includeEnded: boolean; limit: number; offset: number },
  ): Promise<{ items: TeacherAssignmentView[]; limit: number; offset: number }> {
    const all = roleHasPermission(ScopeType.SCHOOL, scope.role, Permission.SCHOOL_TEACHER_ASSIGNMENTS_MANAGE);
    const ta = schema.teacherAssignments;

    const rows = await this.db
      .select({
        id: ta.id,
        academicYearId: ta.academicYearId,
        classSubjectId: ta.classSubjectId,
        sectionId: schema.sections.id,
        sectionName: schema.sections.name,
        gradeNumber: schema.grades.gradeNumber,
        subjectId: schema.subjects.id,
        subjectCode: schema.subjects.code,
        membershipId: ta.membershipId,
        teacherUserId: schema.users.id,
        teacherName: schema.users.displayName,
        assignedAt: ta.assignedAt,
        endedAt: ta.endedAt,
      })
      .from(ta)
      .innerJoin(schema.classSubjects, eq(schema.classSubjects.id, ta.classSubjectId))
      .innerJoin(schema.sections, eq(schema.sections.id, schema.classSubjects.sectionId))
      .innerJoin(schema.grades, eq(schema.grades.id, schema.sections.gradeId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.classSubjects.subjectId))
      .innerJoin(schema.schoolMemberships, eq(schema.schoolMemberships.id, ta.membershipId))
      .innerJoin(schema.users, eq(schema.users.id, schema.schoolMemberships.userId))
      .where(
        and(
          eq(ta.schoolId, scope.schoolId),
          all ? undefined : eq(ta.membershipId, scope.membershipId),
          query.academicYearId ? eq(ta.academicYearId, query.academicYearId) : undefined,
          query.includeEnded ? undefined : isNull(ta.endedAt),
        ),
      )
      .orderBy(asc(schema.grades.gradeNumber), asc(schema.sections.name), asc(schema.subjects.code), asc(ta.id))
      .limit(query.limit)
      .offset(query.offset);

    return {
      items: rows.map((r) => ({ ...r, assignedAt: r.assignedAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null })),
      limit: query.limit,
      offset: query.offset,
    };
  }

  async create(
    scope: SchoolScope,
    yearId: string,
    input: { classSubjectId: string; membershipId: string },
    meta: RequestMeta,
  ): Promise<{ id: string; classSubjectId: string; membershipId: string; academicYearId: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        await lockWritableYear(tx, scope, yearId);

        const [classSubject] = await tx
          .select({ id: schema.classSubjects.id })
          .from(schema.classSubjects)
          .where(
            and(
              eq(schema.classSubjects.id, input.classSubjectId),
              eq(schema.classSubjects.schoolId, scope.schoolId),
              eq(schema.classSubjects.academicYearId, yearId),
            ),
          );
        if (!classSubject) throw notVisible('class subject');

        // Lock the membership so it cannot be revoked between this check and the insert.
        const [membership] = await tx
          .select()
          .from(schema.schoolMemberships)
          .where(
            and(
              eq(schema.schoolMemberships.id, input.membershipId),
              eq(schema.schoolMemberships.schoolId, scope.schoolId),
            ),
          )
          .for('share');
        if (!membership) throw notVisible('staff membership');
        if (membership.status !== 'active') {
          throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, 'Only an active staff member can be assigned');
        }
        if (!TEACHING_ROLES.includes(membership.role)) {
          throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, `A ${membership.role} cannot hold a teaching assignment`);
        }

        const [row] = await tx
          .insert(schema.teacherAssignments)
          .values({
            schoolId: scope.schoolId,
            academicYearId: yearId,
            classSubjectId: classSubject.id,
            membershipId: membership.id,
            assignedBy: scope.userId,
          })
          .returning();

        await writeAudit(tx, {
          action: 'teacher_assignment.created',
          entityType: 'teacher_assignment',
          entityId: row!.id,
          actorUserId: scope.userId,
          schoolId: scope.schoolId,
          requestId: meta.requestId,
          metadata: { classSubjectId: classSubject.id, membershipId: membership.id },
        });
        return { id: row!.id, classSubjectId: row!.classSubjectId, membershipId: row!.membershipId, academicYearId: yearId };
      });
    } catch (err) {
      translateConstraint(err, {
        teacher_assignments_one_active: conflict('This teacher is already assigned to this class subject'),
      });
    }
  }

  async end(scope: SchoolScope, assignmentId: string, meta: RequestMeta): Promise<{ id: string; endedAt: string }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.teacherAssignments)
        .where(
          and(eq(schema.teacherAssignments.id, assignmentId), eq(schema.teacherAssignments.schoolId, scope.schoolId)),
        )
        .for('update');
      if (!row) throw notVisible('teacher assignment');
      if (row.endedAt) throw new DomainError(ErrorCode.STATE_CONFLICT, 'Assignment has already ended');
      await lockWritableYear(tx, scope, row.academicYearId);

      const [ended] = await tx
        .update(schema.teacherAssignments)
        .set({ endedAt: new Date(), endedBy: scope.userId })
        .where(eq(schema.teacherAssignments.id, assignmentId))
        .returning();

      await writeAudit(tx, {
        action: 'teacher_assignment.ended',
        entityType: 'teacher_assignment',
        entityId: assignmentId,
        actorUserId: scope.userId,
        schoolId: scope.schoolId,
        requestId: meta.requestId,
        metadata: { classSubjectId: row.classSubjectId, membershipId: row.membershipId },
      });
      return { id: assignmentId, endedAt: ended!.endedAt!.toISOString() };
    });
  }
}
