import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  ApproveRegistrationSchema,
  ListRegistrationRequestsQuerySchema,
  RejectRegistrationSchema,
  SchoolRegistrationRequestSchema,
} from '@smart-school/shared';
import { CurrentPrincipal, Public, type Principal } from '../auth/principal';
import { ReqMeta, type RequestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  RegistrationService,
  type ApprovalResult,
  type RegistrationRequestView,
} from './registration.service';

const IdParam = new ZodValidationPipe(z.uuid());

/** Public school registration (D-18). */
@Controller('schools/registration-requests')
export class PublicRegistrationController {
  constructor(private readonly registrations: RegistrationService) {}

  @Public()
  @Post()
  @HttpCode(202)
  async submit(
    @Body(new ZodValidationPipe(SchoolRegistrationRequestSchema))
    body: z.infer<typeof SchoolRegistrationRequestSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ status: 'pending_review' }> {
    await this.registrations.submit(body, meta);
    // No id is returned: nothing the submitter holds should address the request later.
    return { status: 'pending_review' };
  }
}

/** Platform review of registration requests (Q2: platform staff only). */
@Controller('platform/school-registration-requests')
export class PlatformRegistrationController {
  constructor(private readonly registrations: RegistrationService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(ListRegistrationRequestsQuerySchema))
    query: z.infer<typeof ListRegistrationRequestsQuerySchema>,
  ): Promise<{ items: RegistrationRequestView[]; limit: number; offset: number }> {
    return this.registrations.list(principal, query);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', IdParam) id: string,
  ): Promise<RegistrationRequestView> {
    return this.registrations.get(principal, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @CurrentPrincipal() principal: Principal,
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(ApproveRegistrationSchema)) body: z.infer<typeof ApproveRegistrationSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<ApprovalResult> {
    return this.registrations.approve(principal, id, body, meta);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @CurrentPrincipal() principal: Principal,
    @Param('id', IdParam) id: string,
    @Body(new ZodValidationPipe(RejectRegistrationSchema)) body: z.infer<typeof RejectRegistrationSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ registrationRequestId: string; status: 'rejected' }> {
    return this.registrations.reject(principal, id, body, meta);
  }
}
