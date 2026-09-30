import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Permission } from '@smart-school/permissions';
import { SchoolSummaryQuerySchema, SectionReportQuerySchema, StudentReportQuerySchema } from '@smart-school/shared';
import { AccessService } from '../access/access.service';
import { Uuid } from '../academic/structure.controller';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { ReqMeta, type RequestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ReportsService } from './reports.service';

/**
 * Attendance reports. Section and student reports are gated by `school.attendance.mark` (admins
 * and teachers), then scoped in the service: admins see the school, teachers only their actively
 * assigned class-subjects. The school summary needs `school.attendance.read_all` (admins).
 * CSV routes run the same authorization and filters as their JSON counterparts.
 */
const MARK = Permission.SCHOOL_ATTENDANCE_MARK;
const READ_ALL = Permission.SCHOOL_ATTENDANCE_READ_ALL;

function sendCsv(res: Response, name: string, q: { from: string; to: string }, body: string): string {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // Only fixed words and validated ISO dates reach the filename.
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${name}-${q.from}-to-${q.to}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return body;
}

@Controller('schools/:schoolId/attendance/reports')
export class ReportsController {
  constructor(
    private readonly access: AccessService,
    private readonly reports: ReportsService,
  ) {}

  @Get('sections')
  async sections(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(SectionReportQuerySchema)) q: z.infer<typeof SectionReportQuerySchema>,
  ) {
    return this.reports.sectionReport(await this.access.forSchool(p, schoolId, MARK), q);
  }

  @Get('sections.csv')
  async sectionsCsv(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(SectionReportQuerySchema)) q: z.infer<typeof SectionReportQuerySchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.reports.sectionReportCsv(await this.access.forSchool(p, schoolId, MARK), q, meta);
    return sendCsv(res, 'sections', q, csv);
  }

  @Get('summary')
  async summary(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(SchoolSummaryQuerySchema)) q: z.infer<typeof SchoolSummaryQuerySchema>,
  ) {
    return this.reports.schoolSummary(await this.access.forSchool(p, schoolId, READ_ALL), q);
  }

  @Get('summary.csv')
  async summaryCsv(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(SchoolSummaryQuerySchema)) q: z.infer<typeof SchoolSummaryQuerySchema>,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const csv = await this.reports.schoolSummaryCsv(await this.access.forSchool(p, schoolId, READ_ALL), q, meta);
    return sendCsv(res, 'summary', q, csv);
  }

  @Get('students/:studentId')
  async student(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('studentId', Uuid) studentId: string,
    @Query(new ZodValidationPipe(StudentReportQuerySchema)) q: z.infer<typeof StudentReportQuerySchema>,
  ) {
    return this.reports.studentReport(await this.access.forSchool(p, schoolId, MARK), studentId, q);
  }
}
