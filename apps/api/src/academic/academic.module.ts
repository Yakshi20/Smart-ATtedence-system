import { Module } from '@nestjs/common';
import { AcademicAccess } from './academic-access';
import { AcademicYearsService } from './academic-years.service';
import { EnrollmentsService } from './enrollments.service';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';
import { TeacherAssignmentsController } from './teacher-assignments.controller';
import { TeacherAssignmentsService } from './teacher-assignments.service';

@Module({
  controllers: [StructureController, StudentsController, TeacherAssignmentsController],
  providers: [AcademicAccess, AcademicYearsService, StructureService, StudentsService, EnrollmentsService, TeacherAssignmentsService],
  exports: [AcademicAccess],
})
export class AcademicModule {}
