import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permission } from '@smart-school/permissions';
import {
  AcademicYearStatusQuerySchema,
  ClassSubjectListQuerySchema,
  CreateAcademicYearSchema,
  CreateClassSubjectSchema,
  CreateGradeSchema,
  CreateSectionSchema,
  CreateSubjectSchema,
  SectionListQuerySchema,
  UpdateAcademicYearSchema,
  UpdateSubjectSchema,
} from '@smart-school/shared';
import { AccessService } from '../access/access.service';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { ReqMeta, type RequestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AcademicYearsService, type AcademicYearView } from './academic-years.service';
import {
  StructureService,
  type ClassSubjectView,
  type GradeView,
  type SectionView,
  type SubjectView,
} from './structure.service';

export const Uuid = new ZodValidationPipe(z.uuid());
const READ = Permission.SCHOOL_ACADEMIC_READ;
const MANAGE = Permission.SCHOOL_ACADEMIC_MANAGE;

/**
 * Academic structure. Reads need `school.academic.read` (admins and teachers); writes need
 * `school.academic.manage` (admins). Every handler resolves a SchoolScope from the caller's
 * membership first — `:schoolId` only selects which membership.
 */
@Controller('schools/:schoolId')
export class StructureController {
  constructor(
    private readonly access: AccessService,
    private readonly years: AcademicYearsService,
    private readonly structure: StructureService,
  ) {}

  // ---------------------------------------------------------------- academic years

  @Get('academic-years')
  async listYears(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(AcademicYearStatusQuerySchema)) q: z.infer<typeof AcademicYearStatusQuerySchema>,
  ): Promise<{ items: AcademicYearView[] }> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return { items: await this.years.list(scope, q.status) };
  }

  @Post('academic-years')
  async createYear(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Body(new ZodValidationPipe(CreateAcademicYearSchema)) body: z.infer<typeof CreateAcademicYearSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AcademicYearView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.years.create(scope, body, meta);
  }

  @Get('academic-years/:yearId')
  async getYear(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
  ): Promise<AcademicYearView> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return this.years.get(scope, yearId);
  }

  @Patch('academic-years/:yearId')
  async updateYear(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @Body(new ZodValidationPipe(UpdateAcademicYearSchema)) body: z.infer<typeof UpdateAcademicYearSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AcademicYearView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.years.update(scope, yearId, body, meta);
  }

  @Post('academic-years/:yearId/open')
  @HttpCode(200)
  async openYear(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AcademicYearView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.years.transition(scope, yearId, 'open', meta);
  }

  @Post('academic-years/:yearId/close')
  @HttpCode(200)
  async closeYear(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AcademicYearView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.years.transition(scope, yearId, 'close', meta);
  }

  @Post('academic-years/:yearId/archive')
  @HttpCode(200)
  async archiveYear(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AcademicYearView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.years.transition(scope, yearId, 'archive', meta);
  }

  // ---------------------------------------------------------------- grades

  @Get('grades')
  async listGrades(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
  ): Promise<{ items: GradeView[] }> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return { items: await this.structure.listGrades(scope) };
  }

  @Post('grades')
  async createGrade(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Body(new ZodValidationPipe(CreateGradeSchema)) body: z.infer<typeof CreateGradeSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<GradeView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.structure.createGrade(scope, body, meta);
  }

  // ---------------------------------------------------------------- sections

  @Get('academic-years/:yearId/sections')
  async listSections(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @Query(new ZodValidationPipe(SectionListQuerySchema)) q: z.infer<typeof SectionListQuerySchema>,
  ): Promise<{ items: SectionView[] }> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return { items: await this.structure.listSections(scope, yearId, q.gradeId) };
  }

  @Post('academic-years/:yearId/sections')
  async createSection(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @Body(new ZodValidationPipe(CreateSectionSchema)) body: z.infer<typeof CreateSectionSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<SectionView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.structure.createSection(scope, yearId, body, meta);
  }

  // ---------------------------------------------------------------- subjects

  @Get('subjects')
  async listSubjects(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
  ): Promise<{ items: SubjectView[] }> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return { items: await this.structure.listSubjects(scope) };
  }

  @Post('subjects')
  async createSubject(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Body(new ZodValidationPipe(CreateSubjectSchema)) body: z.infer<typeof CreateSubjectSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<SubjectView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.structure.createSubject(scope, body, meta);
  }

  @Patch('subjects/:subjectId')
  async updateSubject(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('subjectId', Uuid) subjectId: string,
    @Body(new ZodValidationPipe(UpdateSubjectSchema)) body: z.infer<typeof UpdateSubjectSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<SubjectView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.structure.updateSubject(scope, subjectId, body, meta);
  }

  // ---------------------------------------------------------------- class-subjects

  @Get('academic-years/:yearId/class-subjects')
  async listClassSubjects(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @Query(new ZodValidationPipe(ClassSubjectListQuerySchema)) q: z.infer<typeof ClassSubjectListQuerySchema>,
  ): Promise<{ items: ClassSubjectView[] }> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return { items: await this.structure.listClassSubjects(scope, yearId, q.sectionId) };
  }

  @Post('academic-years/:yearId/class-subjects')
  async createClassSubjects(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @Body(new ZodValidationPipe(CreateClassSubjectSchema)) body: z.infer<typeof CreateClassSubjectSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ items: ClassSubjectView[] }> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.structure.createClassSubjects(scope, yearId, body, meta);
  }
}
