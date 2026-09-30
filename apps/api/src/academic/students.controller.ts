import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permission } from '@smart-school/permissions';
import {
  ChangeStudentStatusSchema,
  CreateEnrollmentSchema,
  CreateStudentSchema,
  PromotionSchema,
  RosterQuerySchema,
  StudentListQuerySchema,
  TransferEnrollmentSchema,
  UpdateStudentSchema,
  VoidEnrollmentSchema,
} from '@smart-school/shared';
import { AccessService } from '../access/access.service';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { ReqMeta, type RequestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  EnrollmentsService,
  type EnrollmentHistoryItem,
  type EnrollmentView,
  type RosterEntry,
} from './enrollments.service';
import { StudentsService, type StudentDetailView, type StudentView } from './students.service';
import { Uuid } from './structure.controller';

/**
 * Student data. Read routes need `school.students.read_assigned`, which admins and teachers
 * both hold; the service then applies the relationship check — admins see the whole school,
 * teachers only their assigned sections. Writes need `school.students.manage` (admins).
 */
const READ = Permission.SCHOOL_STUDENTS_READ_ASSIGNED;
const MANAGE = Permission.SCHOOL_STUDENTS_MANAGE;

@Controller('schools/:schoolId')
export class StudentsController {
  constructor(
    private readonly access: AccessService,
    private readonly students: StudentsService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  // ---------------------------------------------------------------- students

  @Get('students')
  async list(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(StudentListQuerySchema)) q: z.infer<typeof StudentListQuerySchema>,
  ): Promise<{ items: StudentView[]; limit: number; offset: number }> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return this.students.list(scope, q);
  }

  @Post('students')
  async create(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Body(new ZodValidationPipe(CreateStudentSchema)) body: z.infer<typeof CreateStudentSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StudentView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.students.create(scope, body, meta);
  }

  @Get('students/:studentId')
  async get(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('studentId', Uuid) studentId: string,
  ): Promise<StudentDetailView> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return this.students.get(scope, studentId);
  }

  @Patch('students/:studentId')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('studentId', Uuid) studentId: string,
    @Body(new ZodValidationPipe(UpdateStudentSchema)) body: z.infer<typeof UpdateStudentSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StudentView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.students.update(scope, studentId, body, meta);
  }

  @Post('students/:studentId/status')
  @HttpCode(200)
  async changeStatus(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('studentId', Uuid) studentId: string,
    @Body(new ZodValidationPipe(ChangeStudentStatusSchema)) body: z.infer<typeof ChangeStudentStatusSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StudentView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.students.changeStatus(scope, studentId, body, meta);
  }

  @Get('students/:studentId/enrollments')
  async history(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('studentId', Uuid) studentId: string,
  ): Promise<{ items: EnrollmentHistoryItem[] }> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return this.enrollments.history(scope, studentId);
  }

  // ---------------------------------------------------------------- enrolments

  @Post('academic-years/:yearId/enrollments')
  async enrol(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @Body(new ZodValidationPipe(CreateEnrollmentSchema)) body: z.infer<typeof CreateEnrollmentSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EnrollmentView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.enrollments.enrol(scope, yearId, body, meta);
  }

  @Post('enrollments/:enrollmentId/transfer')
  async transfer(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('enrollmentId', Uuid) enrollmentId: string,
    @Body(new ZodValidationPipe(TransferEnrollmentSchema)) body: z.infer<typeof TransferEnrollmentSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EnrollmentView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.enrollments.transfer(scope, enrollmentId, body, meta);
  }

  @Post('enrollments/:enrollmentId/void')
  @HttpCode(200)
  async voidEnrollment(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('enrollmentId', Uuid) enrollmentId: string,
    @Body(new ZodValidationPipe(VoidEnrollmentSchema)) body: z.infer<typeof VoidEnrollmentSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<EnrollmentView> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.enrollments.void(scope, enrollmentId, body, meta);
  }

  @Post('academic-years/:yearId/promotions')
  async promote(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @Body(new ZodValidationPipe(PromotionSchema)) body: z.infer<typeof PromotionSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ items: EnrollmentView[] }> {
    const scope = await this.access.forSchool(p, schoolId, MANAGE);
    return this.enrollments.promote(scope, yearId, body, meta);
  }

  @Get('sections/:sectionId/roster')
  async roster(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('sectionId', Uuid) sectionId: string,
    @Query(new ZodValidationPipe(RosterQuerySchema)) q: z.infer<typeof RosterQuerySchema>,
  ): Promise<{ date: string; items: RosterEntry[]; limit: number; offset: number }> {
    const scope = await this.access.forSchool(p, schoolId, READ);
    return this.enrollments.roster(scope, sectionId, q);
  }
}
