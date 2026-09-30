import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permission } from '@smart-school/permissions';
import {
  AttendanceRangeQuerySchema,
  CreateGuardianLinkSchema,
  CreateGuardianSchema,
  GuardianLinkClaimSchema,
  GuardianLinkListQuerySchema,
  GuardianListQuerySchema,
  LinkDecisionReasonSchema,
  UpdateGuardianSchema,
} from '@smart-school/shared';
import { AccessService } from '../access/access.service';
import { Uuid } from '../academic/structure.controller';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { ReqMeta, type RequestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GuardiansService, type GuardianLinkView, type GuardianView } from './guardians.service';
import { ParentService, type ChildView, type ClaimView } from './parent.service';

const READ = Permission.SCHOOL_GUARDIANS_READ;
const MANAGE = Permission.SCHOOL_GUARDIANS_MANAGE;

/** School staff: guardian records and link review. Admins only (see permission registry). */
@Controller('schools/:schoolId')
export class GuardiansController {
  constructor(
    private readonly access: AccessService,
    private readonly guardians: GuardiansService,
  ) {}

  @Get('guardians')
  async list(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(GuardianListQuerySchema)) q: z.infer<typeof GuardianListQuerySchema>,
  ): Promise<{ items: GuardianView[]; limit: number; offset: number }> {
    return this.guardians.list(await this.access.forSchool(p, schoolId, READ), q);
  }

  @Post('guardians')
  async create(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Body(new ZodValidationPipe(CreateGuardianSchema)) body: z.infer<typeof CreateGuardianSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<GuardianView> {
    return this.guardians.create(await this.access.forSchool(p, schoolId, MANAGE), body, meta);
  }

  @Get('guardians/:guardianId')
  async get(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('guardianId', Uuid) guardianId: string,
  ): Promise<GuardianView & { links: GuardianLinkView[] }> {
    return this.guardians.get(await this.access.forSchool(p, schoolId, READ), guardianId);
  }

  @Patch('guardians/:guardianId')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('guardianId', Uuid) guardianId: string,
    @Body(new ZodValidationPipe(UpdateGuardianSchema)) body: z.infer<typeof UpdateGuardianSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<GuardianView> {
    return this.guardians.update(await this.access.forSchool(p, schoolId, MANAGE), guardianId, body, meta);
  }

  @Get('students/:studentId/guardian-links')
  async studentLinks(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('studentId', Uuid) studentId: string,
  ): Promise<{ items: GuardianLinkView[] }> {
    return this.guardians.studentLinks(await this.access.forSchool(p, schoolId, READ), studentId);
  }

  @Post('students/:studentId/guardian-links')
  async createLink(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('studentId', Uuid) studentId: string,
    @Body(new ZodValidationPipe(CreateGuardianLinkSchema)) body: z.infer<typeof CreateGuardianLinkSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<GuardianLinkView> {
    return this.guardians.createLink(await this.access.forSchool(p, schoolId, MANAGE), studentId, body, meta);
  }

  /** Review queue; defaults to `status=pending`. */
  @Get('guardian-links')
  async listLinks(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Query(new ZodValidationPipe(GuardianLinkListQuerySchema)) q: z.infer<typeof GuardianLinkListQuerySchema>,
  ): Promise<{ items: GuardianLinkView[]; limit: number; offset: number }> {
    return this.guardians.listLinks(await this.access.forSchool(p, schoolId, READ), q);
  }

  @Post('guardian-links/:linkId/verify')
  @HttpCode(200)
  async verify(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('linkId', Uuid) linkId: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<GuardianLinkView> {
    return this.guardians.verify(await this.access.forSchool(p, schoolId, MANAGE), linkId, meta);
  }

  @Post('guardian-links/:linkId/reject')
  @HttpCode(200)
  async reject(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('linkId', Uuid) linkId: string,
    @Body(new ZodValidationPipe(LinkDecisionReasonSchema)) body: z.infer<typeof LinkDecisionReasonSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<GuardianLinkView> {
    return this.guardians.reject(await this.access.forSchool(p, schoolId, MANAGE), linkId, body.reason, meta);
  }

  @Post('guardian-links/:linkId/revoke')
  @HttpCode(200)
  async revoke(
    @CurrentPrincipal() p: Principal,
    @Param('schoolId', Uuid) schoolId: string,
    @Param('linkId', Uuid) linkId: string,
    @Body(new ZodValidationPipe(LinkDecisionReasonSchema)) body: z.infer<typeof LinkDecisionReasonSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<GuardianLinkView> {
    return this.guardians.revoke(await this.access.forSchool(p, schoolId, MANAGE), linkId, body.reason, meta);
  }
}

/**
 * Parent endpoints. Authenticated like every route; the relationship chain in ParentService is
 * the authorization — there is no role that grants child access.
 */
@Controller('parents/me')
export class ParentController {
  constructor(private readonly parents: ParentService) {}

  @Get('children')
  children(@CurrentPrincipal() p: Principal): Promise<{ items: ChildView[] }> {
    return this.parents.children(p);
  }

  @Get('children/:studentId')
  child(@CurrentPrincipal() p: Principal, @Param('studentId', Uuid) studentId: string): Promise<ChildView> {
    return this.parents.child(p, studentId);
  }

  @Get('children/:studentId/attendance')
  childAttendance(
    @CurrentPrincipal() p: Principal,
    @Param('studentId', Uuid) studentId: string,
    @Query(new ZodValidationPipe(AttendanceRangeQuerySchema)) q: z.infer<typeof AttendanceRangeQuerySchema>,
  ) {
    return this.parents.childAttendance(p, studentId, q);
  }

  @Post('link-requests')
  @HttpCode(202)
  submitClaim(
    @CurrentPrincipal() p: Principal,
    @Body(new ZodValidationPipe(GuardianLinkClaimSchema)) body: z.infer<typeof GuardianLinkClaimSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ status: 'submitted' }> {
    return this.parents.submitClaim(p, body, meta);
  }

  @Get('link-requests')
  claims(@CurrentPrincipal() p: Principal): Promise<{ items: ClaimView[] }> {
    return this.parents.claims(p);
  }
}
