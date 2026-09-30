import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    SessionService,
    AuthService,
    OtpService,
    // Global and default-deny: every route in every module requires authentication unless
    // it is marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
