import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { ActivateAccountSchema, LoginSchema, OtpRequestSchema, OtpVerifySchema, RefreshSchema } from '@smart-school/shared';
import { ReqMeta, type RequestMeta } from '../common/request-meta';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { CurrentPrincipal, Public, type Principal } from './principal';
import { SessionService, type IssuedTokens } from './session.service';

/**
 * Tokens travel in JSON bodies, which suits the mobile app. When the web portal arrives,
 * its refresh token belongs in an HttpOnly SameSite cookie with CSRF protection (07 §1) —
 * a separate route, not a change to these.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly otp: OtpService,
  ) {}

  /**
   * Parent phone login, step 1. `202 accepted` is returned for every valid mobile number and
   * means only that the request was accepted — not that a message reached a phone.
   */
  @Public()
  @Post('otp/request')
  @HttpCode(202)
  requestOtp(
    @Body(new ZodValidationPipe(OtpRequestSchema)) body: z.infer<typeof OtpRequestSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<{ status: 'accepted'; expiresInSeconds: number }> {
    return this.otp.request(body, meta);
  }

  /** Parent phone login, step 2: exchanges a valid code for a session. */
  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(
    @Body(new ZodValidationPipe(OtpVerifySchema)) body: z.infer<typeof OtpVerifySchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<IssuedTokens> {
    return this.otp.verify(body, meta);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<IssuedTokens> {
    return this.auth.login(body, meta);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body(new ZodValidationPipe(RefreshSchema)) body: z.infer<typeof RefreshSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<IssuedTokens> {
    return this.auth.refresh(body.refreshToken, meta);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentPrincipal() principal: Principal, @ReqMeta() meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(principal, 'logout', meta.requestId);
  }

  @Public()
  @Post('staff/activate')
  @HttpCode(204)
  async activate(
    @Body(new ZodValidationPipe(ActivateAccountSchema)) body: z.infer<typeof ActivateAccountSchema>,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.auth.activate(body, meta);
  }
}
