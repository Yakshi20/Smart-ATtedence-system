import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permission } from '@smart-school/permissions';
import { InviteStaffSchema } from '@smart-school/shared';
import { AccessService } from '../access/access.service';
import { CurrentPrincipal, type Principal } from '../auth/principal';
import { ReqMeta, type RequestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SchoolsService, type SchoolView, type StaffMemberView } from './schools.service';

const SchoolIdParam = new ZodValidationPipe(z.uuid());

/**
 * School-scoped routes. `:schoolId` selects which of the caller's memberships to use; it is
 * never trusted on its own. Each handler converts it into a SchoolScope via AccessService
 * before any school data is read.
 */
@Controller('schools/:schoolId')
export class SchoolsController {
  constructor(
    private readonly access: AccessService,
    private readonly schools: SchoolsService,
  ) {}

  @Get()
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('schoolId', SchoolIdParam) schoolId: string,
  ): Promise<SchoolView> {
    const scope = await this.access.forSchool(principal, schoolId, Permission.SCHOOL_PROFILE_READ);
    return this.schools.profile(scope);
  }

  @Get('staff')
  async listStaff(
    @CurrentPrincipal() principal: Principal,
    @Param('schoolId', SchoolIdParam) schoolId: string,
  ): Promise<{ items: StaffMemberView[] }> {
    const scope = await this.access.forSchool(principal, schoolId, Permission.SCHOOL_STAFF_READ);
    return { items: await this.schools.listStaff(scope) };
  }

  @Post('staff')
  async inviteStaff(
    @CurrentPrincipal() principal: Principal,
    @Param('schoolId', SchoolIdParam) schoolId: string,
    @Body(new ZodValidationPipe(InviteStaffSchema)) body: z.infer<typeof InviteStaffSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ membershipId: string; userId: string; role: string }> {
    const scope = await this.access.forSchool(principal, schoolId, Permission.SCHOOL_STAFF_MANAGE);
    return this.schools.inviteStaff(scope, body, meta);
  }
}
