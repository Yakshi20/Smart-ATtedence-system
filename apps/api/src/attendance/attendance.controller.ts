import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Permission } from '@smart-school/permissions';
import {
  AttendanceCorrectionSchema,
  AttendanceRangeQuerySchema,
  AttendanceSessionListQuerySchema,
  IdempotencyKeySchema,
  OpenAttendanceSessionSchema,
  SubmitAttendanceSchema,
} from '@smart-school/shared';
import { AccessService } from '../access/access.service';
import { Uuid } from '../academic/structure.controller';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { ReqMeta, type RequestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  AttendanceService,
  type AttendanceSessionDetail,
  type AttendanceSessionView,
  type CorrectionView,
} from './attendance.service';

/**
 * Attendance routes. The gate for registers is `school.attendance.mark` (admins and teachers);
 * the service then requires teachers to hold an active assignment to the register's
 * class-subject for every read and write. Corrections need `school.attendance.correct` (admins).
 */
const MARK = Permission.SCHOOL_ATTENDANCE_MARK;
// Nest's @Headers() takes no pipes; the same validator is applied in the handler instead.
const idempotencyKeyPipe = new ZodValidationPipe(IdempotencyKeySchema);

@Controller('schools/:schoolId')
export class AttendanceController {
  constructor(
    private readonly access: AccessService,
    private readonly attendance: AttendanceService,
  ) {}

  /** `201` when the register was created, `200` when the same register already existed. */
  @Post('attendance/sessions')
  async open(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Body(new ZodValidationPipe(OpenAttendanceSessionSchema)) body: z.infer<typeof OpenAttendanceSessionSchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AttendanceSessionDetail> {
    const scope = await this.access.forSchool(p, schoolId, MARK);
    const { created, session } = await this.attendance.open(scope, body, meta);
    res.status(created ? 201 : 200);
    return session;
  }

  @Get('attendance/sessions')
  async list(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(AttendanceSessionListQuerySchema)) q: z.infer<typeof AttendanceSessionListQuerySchema>,
  ): Promise<{ items: AttendanceSessionView[]; limit: number; offset: number }> {
    return this.attendance.list(await this.access.forSchool(p, schoolId, MARK), q);
  }

  @Get('attendance/sessions/:sessionId')
  async get(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('sessionId', Uuid) sessionId: string,
  ): Promise<AttendanceSessionDetail> {
    return this.attendance.get(await this.access.forSchool(p, schoolId, MARK), sessionId);
  }

  /** Requires an `Idempotency-Key: <uuid>` header. */
  @Put('attendance/sessions/:sessionId/records')
  @HttpCode(200)
  async submit(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('sessionId', Uuid) sessionId: string,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body(new ZodValidationPipe(SubmitAttendanceSchema)) body: z.infer<typeof SubmitAttendanceSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AttendanceSessionDetail & { replayed: boolean }> {
    const idempotencyKey = idempotencyKeyPipe.transform(rawKey);
    const scope = await this.access.forSchool(p, schoolId, MARK);
    const { replayed, session } = await this.attendance.submit(scope, sessionId, idempotencyKey, body, meta);
    return { ...session, replayed };
  }

  @Post('attendance/sessions/:sessionId/corrections')
  async correct(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('sessionId', Uuid) sessionId: string,
    @Body(new ZodValidationPipe(AttendanceCorrectionSchema)) body: z.infer<typeof AttendanceCorrectionSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CorrectionView> {
    const scope = await this.access.forSchool(p, schoolId, Permission.SCHOOL_ATTENDANCE_CORRECT);
    return this.attendance.correct(scope, sessionId, body, meta);
  }

  @Get('attendance/sessions/:sessionId/corrections')
  async corrections(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('sessionId', Uuid) sessionId: string,
  ): Promise<{ items: CorrectionView[] }> {
    return this.attendance.corrections(await this.access.forSchool(p, schoolId, MARK), sessionId);
  }

  /** One student's attendance across all subjects — school-wide student access only. */
  @Get('students/:studentId/attendance')
  async forStudent(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('studentId', Uuid) studentId: string,
    @Query(new ZodValidationPipe(AttendanceRangeQuerySchema)) q: z.infer<typeof AttendanceRangeQuerySchema>,
  ) {
    const scope = await this.access.forSchool(p, schoolId, Permission.SCHOOL_STUDENTS_READ);
    return this.attendance.forStudent(scope, studentId, q);
  }
}
