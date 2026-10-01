import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permission } from '@smart-school/permissions';
import { CreateTeacherAssignmentSchema, TeacherAssignmentListQuerySchema } from '@smart-school/shared';
import { AccessService } from '../access/access.service';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { ReqMeta, type RequestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Uuid } from './structure.controller';
import { TeacherAssignmentsService, type TeacherAssignmentView } from './teacher-assignments.service';

@Controller('schools/:schoolId')
export class TeacherAssignmentsController {
  constructor(
    private readonly access: AccessService,
    private readonly assignments: TeacherAssignmentsService,
  ) {}

  /** Admins: every assignment. Teachers: their own only (`read_own`, filtered in the service). */
  @Get('teacher-assignments')
  async list(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(TeacherAssignmentListQuerySchema)) q: z.infer<typeof TeacherAssignmentListQuerySchema>,
  ): Promise<{ items: TeacherAssignmentView[]; limit: number; offset: number }> {
    const scope = await this.access.forSchool(p, schoolId, Permission.SCHOOL_TEACHER_ASSIGNMENTS_READ_OWN);
    return this.assignments.list(scope, q);
  }

  @Post('academic-years/:yearId/teacher-assignments')
  async create(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('yearId', Uuid) yearId: string,
    @Body(new ZodValidationPipe(CreateTeacherAssignmentSchema)) body: z.infer<typeof CreateTeacherAssignmentSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ id: string; classSubjectId: string; membershipId: string; academicYearId: string }> {
    const scope = await this.access.forSchool(p, schoolId, Permission.SCHOOL_TEACHER_ASSIGNMENTS_MANAGE);
    return this.assignments.create(scope, yearId, body, meta);
  }

  @Post('teacher-assignments/:assignmentId/end')
  @HttpCode(200)
  async end(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('assignmentId', Uuid) assignmentId: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ id: string; endedAt: string }> {
    const scope = await this.access.forSchool(p, schoolId, Permission.SCHOOL_TEACHER_ASSIGNMENTS_MANAGE);
    return this.assignments.end(scope, assignmentId, meta);
  }
}
