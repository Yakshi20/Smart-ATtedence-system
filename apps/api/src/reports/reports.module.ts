import { Module } from '@nestjs/common';
import { AcademicModule } from '../academic/academic.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({ imports: [AcademicModule], controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
