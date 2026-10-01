import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@smart-school/database';
import { DomainError, ErrorCode, notVisible } from '@smart-school/shared';
import type { SchoolScope } from '../access/access.service';
import { writeAudit } from '../audit/audit';
import type { RequestMeta } from '../common/request-meta';
import { DATABASE } from '../database/database.module';
import { duplicate, findYear, lockWritableYear, now, translateConstraint } from './academic-common';

export interface GradeView {
  id: string;
  gradeNumber: number;
  displayName: string;
}

export interface SectionView {
  id: string;
  academicYearId: string;
  gradeId: string;
  gradeNumber: number;
  name: string;
}

export interface SubjectView {
  id: string;
  code: string;
  name: string;
  nameTranslations: Partial<Record<'en' | 'kn', string>>;
  status: 'active' | 'retired';
}

export interface ClassSubjectView {
  id: string;
  academicYearId: string;
  sectionId: string;
  subjectId: string;
  subjectCode: string;
}

const STRUCTURE_CONSTRAINTS = {
  grades_school_number_key: duplicate('This class already exists'),
  sections_year_grade_name_key: duplicate('A section with this name already exists for this class and year'),
  subjects_school_code_key: duplicate('A subject with this code already exists'),
  class_subjects_section_subject_key: duplicate('This subject is already assigned to this section'),
};

/**
 * Grades, sections, subjects and class-subjects. Every query filters on `scope.schoolId`, and
 * every id taken from the request is re-resolved inside the caller's school before use, so an
 * id belonging to another school behaves exactly like one that does not exist (404). The
 * composite foreign keys in 0002 would reject the write anyway; checking first yields a clean
 * 404 instead of a constraint error.
 */
@Injectable()
export class StructureService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // -------------------------------------------------------------------- grades

  async listGrades(scope: SchoolScope): Promise<GradeView[]> {
    return this.db
      .select({ id: schema.grades.id, gradeNumber: schema.grades.gradeNumber, displayName: schema.grades.displayName })
      .from(schema.grades)
      .where(eq(schema.grades.schoolId, scope.schoolId))
      .orderBy(asc(schema.grades.gradeNumber));
  }

  async createGrade(
    scope: SchoolScope,
    input: { gradeNumber: number; displayName?: string | undefined },
    meta: RequestMeta,
  ): Promise<GradeView> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.grades)
          .values({
            schoolId: scope.schoolId,
            gradeNumber: input.gradeNumber,
            displayName: input.displayName ?? `Class ${input.gradeNumber}`,
          })
          .returning();
        await this.audit(tx, scope, meta, 'grade.created', 'grade', row!.id, { gradeNumber: input.gradeNumber });
        return { id: row!.id, gradeNumber: row!.gradeNumber, displayName: row!.displayName };
      });
    } catch (err) {
      translateConstraint(err, STRUCTURE_CONSTRAINTS);
    }
  }

  // -------------------------------------------------------------------- sections

  async listSections(scope: SchoolScope, yearId: string, gradeId?: string): Promise<SectionView[]> {
    await findYear(this.db, scope, yearId);
    return this.db
      .select({
        id: schema.sections.id,
        academicYearId: schema.sections.academicYearId,
        gradeId: schema.sections.gradeId,
        gradeNumber: schema.grades.gradeNumber,
        name: schema.sections.name,
      })
      .from(schema.sections)
      .innerJoin(schema.grades, eq(schema.grades.id, schema.sections.gradeId))
      .where(
        and(
          eq(schema.sections.schoolId, scope.schoolId),
          eq(schema.sections.academicYearId, yearId),
          gradeId ? eq(schema.sections.gradeId, gradeId) : undefined,
        ),
      )
      .orderBy(asc(schema.grades.gradeNumber), asc(schema.sections.name));
  }

  async createSection(
    scope: SchoolScope,
    yearId: string,
    input: { gradeId: string; name: string },
    meta: RequestMeta,
  ): Promise<SectionView> {
    try {
      return await this.db.transaction(async (tx) => {
        await lockWritableYear(tx, scope, yearId);
        const [grade] = await tx
          .select()
          .from(schema.grades)
          .where(and(eq(schema.grades.id, input.gradeId), eq(schema.grades.schoolId, scope.schoolId)));
        if (!grade) throw notVisible('grade');

        const [row] = await tx
          .insert(schema.sections)
          .values({
            schoolId: scope.schoolId,
            academicYearId: yearId,
            gradeId: grade.id,
            name: input.name,
            createdBy: scope.userId,
          })
          .returning();
        await this.audit(tx, scope, meta, 'section.created', 'section', row!.id, {
          academicYearId: yearId,
          gradeNumber: grade.gradeNumber,
        });
        return {
          id: row!.id,
          academicYearId: yearId,
          gradeId: grade.id,
          gradeNumber: grade.gradeNumber,
          name: row!.name,
        };
      });
    } catch (err) {
      translateConstraint(err, STRUCTURE_CONSTRAINTS);
    }
  }

  // -------------------------------------------------------------------- subjects

  async listSubjects(scope: SchoolScope): Promise<SubjectView[]> {
    const rows = await this.db
      .select()
      .from(schema.subjects)
      .where(eq(schema.subjects.schoolId, scope.schoolId))
      .orderBy(asc(schema.subjects.code));
    return rows.map(toSubjectView);
  }

  async createSubject(
    scope: SchoolScope,
    input: { code: string; name: string; nameTranslations: Partial<Record<'en' | 'kn', string>> },
    meta: RequestMeta,
  ): Promise<SubjectView> {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.subjects)
          .values({ ...input, schoolId: scope.schoolId, createdBy: scope.userId })
          .returning();
        await this.audit(tx, scope, meta, 'subject.created', 'subject', row!.id, { code: input.code });
        return toSubjectView(row!);
      });
    } catch (err) {
      translateConstraint(err, STRUCTURE_CONSTRAINTS);
    }
  }

  /**
   * Codes are immutable (they key reports and imports). Retiring a subject keeps its history
   * and existing class-subjects; it only stops new associations.
   */
  async updateSubject(
    scope: SchoolScope,
    subjectId: string,
    input: {
      name?: string | undefined;
      nameTranslations?: Partial<Record<'en' | 'kn', string>> | undefined;
      status?: 'active' | 'retired' | undefined;
    },
    meta: RequestMeta,
  ): Promise<SubjectView> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.subjects)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.nameTranslations !== undefined ? { nameTranslations: input.nameTranslations } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: now,
        })
        .where(and(eq(schema.subjects.id, subjectId), eq(schema.subjects.schoolId, scope.schoolId)))
        .returning();
      if (!row) throw notVisible('subject');
      await this.audit(tx, scope, meta, 'subject.updated', 'subject', subjectId, {
        status: row.status,
        renamed: input.name !== undefined,
      });
      return toSubjectView(row);
    });
  }

  // -------------------------------------------------------------------- class-subjects

  async listClassSubjects(scope: SchoolScope, yearId: string, sectionId?: string): Promise<ClassSubjectView[]> {
    await findYear(this.db, scope, yearId);
    return this.db
      .select({
        id: schema.classSubjects.id,
        academicYearId: schema.classSubjects.academicYearId,
        sectionId: schema.classSubjects.sectionId,
        subjectId: schema.classSubjects.subjectId,
        subjectCode: schema.subjects.code,
      })
      .from(schema.classSubjects)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.classSubjects.subjectId))
      .where(
        and(
          eq(schema.classSubjects.schoolId, scope.schoolId),
          eq(schema.classSubjects.academicYearId, yearId),
          sectionId ? eq(schema.classSubjects.sectionId, sectionId) : undefined,
        ),
      )
      .orderBy(asc(schema.classSubjects.sectionId), asc(schema.subjects.code));
  }

  /**
   * Associates a subject with one section, or with every section of a grade in the year. The
   * grade form is all-or-nothing: if the subject is already on any of those sections, nothing
   * is created and the caller gets 409.
   */
  async createClassSubjects(
    scope: SchoolScope,
    yearId: string,
    input: { subjectId: string; sectionId?: string | undefined; gradeId?: string | undefined },
    meta: RequestMeta,
  ): Promise<{ items: ClassSubjectView[] }> {
    try {
      return await this.db.transaction(async (tx) => {
        await lockWritableYear(tx, scope, yearId);

        const [subject] = await tx
          .select()
          .from(schema.subjects)
          .where(and(eq(schema.subjects.id, input.subjectId), eq(schema.subjects.schoolId, scope.schoolId)));
        if (!subject) throw notVisible('subject');
        if (subject.status !== 'active') {
          throw new DomainError(ErrorCode.BUSINESS_RULE_VIOLATION, 'A retired subject cannot be assigned');
        }

        const sections = await tx
          .select({ id: schema.sections.id })
          .from(schema.sections)
          .where(
            and(
              eq(schema.sections.schoolId, scope.schoolId),
              eq(schema.sections.academicYearId, yearId),
              input.sectionId ? eq(schema.sections.id, input.sectionId) : eq(schema.sections.gradeId, input.gradeId!),
            ),
          );
        if (sections.length === 0) throw notVisible(input.sectionId ? 'section' : 'grade sections');

        const rows = await tx
          .insert(schema.classSubjects)
          .values(
            sections.map((s) => ({
              schoolId: scope.schoolId,
              academicYearId: yearId,
              sectionId: s.id,
              subjectId: subject.id,
              createdBy: scope.userId,
            })),
          )
          .returning();

        for (const row of rows) {
          await this.audit(tx, scope, meta, 'class_subject.created', 'class_subject', row.id, {
            sectionId: row.sectionId,
            subjectCode: subject.code,
          });
        }
        return {
          items: rows.map((r) => ({
            id: r.id,
            academicYearId: r.academicYearId,
            sectionId: r.sectionId,
            subjectId: r.subjectId,
            subjectCode: subject.code,
          })),
        };
      });
    } catch (err) {
      translateConstraint(err, STRUCTURE_CONSTRAINTS);
    }
  }

  private audit(
    tx: Parameters<typeof writeAudit>[0],
    scope: SchoolScope,
    meta: RequestMeta,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    return writeAudit(tx, {
      action,
      entityType,
      entityId,
      actorUserId: scope.userId,
      schoolId: scope.schoolId,
      requestId: meta.requestId,
      metadata,
    });
  }
}

function toSubjectView(row: typeof schema.subjects.$inferSelect): SubjectView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    nameTranslations: row.nameTranslations,
    status: row.status,
  };
}
