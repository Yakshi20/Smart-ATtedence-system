import { Module } from '@nestjs/common';
import { PlatformRegistrationController, PublicRegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';

@Module({
  controllers: [PublicRegistrationController, PlatformRegistrationController],
  providers: [RegistrationService],
})
export class RegistrationModule {}
