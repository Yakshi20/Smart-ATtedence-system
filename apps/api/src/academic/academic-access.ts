import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@smart-school/database';
import { Permission, roleHasPermission, ScopeType } from '@smart-school/permissions';
import { notVisible, permissionDenied } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { DATABASE } from '../database/database.module';

/**
 * Relationship checks for student data (02 §2: never authorize on role alone).
 *
 * A caller holding `school.students.read` sees every student of their school. A caller holding
 * only `school.students.read_assigned` (teachers) sees a student or roster only through an
 * **active** teacher assignment to a class-subject of that student's **current** section.
 * Assignments and enrolments are re-read on every request, so ending either one removes access
 * on the next request.
 */
@Injectable()
export class AcademicAccess {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  seesAllStudents(scope: SchoolScope): boolean {
    return roleHasPermission(ScopeType.SCHOOL, scope.role, Permission.SCHOOL_STUDENTS_READ);
  }

  /**
   * Roster of a section. The section's existence is not secret from anyone who can read the
   * school's structure, so an unassigned teacher gets 403 (visible object, forbidden action);
   * a section outside the school is 404 (D-19).
   */
  async requireRosterAccess(scope: SchoolScope, sectionId: string): Promise<void> {
    const [section] = await this.db
      .select({ id: schema.sections.id })
      .from(schema.sections)
      .where(and(eq(schema.sections.id, sectionId), eq(schema.sections.schoolId, scope.schoolId)));
    if (!section) throw notVisible('section');
    if (this.seesAllStudents(scope)) return;
    if (!(await this.teachesSection(scope, sectionId))) throw permissionDenied('read this roster');
  }

  /**
   * A single student. Outside the caller's visibility → 404, identical to a non-existent id, so
   * student ids cannot be probed (02 §5).
   */
  async requireStudentVisible(scope: SchoolScope, studentId: string): Promise<void> {
    if (this.seesAllStudents(scope)) {
      const [row] = await this.db
        .select({ id: schema.students.id })
        .from(schema.students)
        .where(and(eq(schema.students.id, studentId), eq(schema.students.schoolId, scope.schoolId)));
      if (!row) throw notVisible('student');
      return;
    }

    const [row] = await this.db
      .select({ id: schema.enrollments.id })
      .from(schema.enrollments)
      .innerJoin(schema.classSubjects, eq(schema.classSubjects.sectionId, schema.enrollments.sectionId))
      .innerJoin(schema.teacherAssignments, eq(schema.teacherAssignments.classSubjectId, schema.classSubjects.id))
      .where(
        and(
          eq(schema.enrollments.studentId, studentId),
          eq(schema.enrollments.schoolId, scope.schoolId),
          isNull(schema.enrollments.effectiveTo),
          isNull(schema.enrollments.voidedAt),
          eq(schema.teacherAssignments.membershipId, scope.membershipId),
          isNull(schema.teacherAssignments.endedAt),
        ),
      )
      .limit(1);
    if (!row) throw notVisible('student');
  }

  async teachesSection(scope: SchoolScope, sectionId: string): Promise<boolean> {
    const { rows } = await this.db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM ${schema.teacherAssignments} ta
        JOIN ${schema.classSubjects} cs ON cs.id = ta.class_subject_id
        WHERE cs.section_id = ${sectionId}
          AND ta.school_id = ${scope.schoolId}
          AND ta.membership_id = ${scope.membershipId}
          AND ta.ended_at IS NULL
      ) AS ok`);
    return rows[0]?.ok === true;
  }
}
