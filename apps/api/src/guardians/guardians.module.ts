import { Module } from '@nestjs/common';
import { GuardiansController, ParentController } from './guardians.controller';
import { GuardiansService } from './guardians.service';
import { ParentService } from './parent.service';

@Module({
  controllers: [GuardiansController, ParentController],
  providers: [GuardiansService, ParentService],
})
export class GuardiansModule {}
