import { z } from 'zod';
import { singleLineText } from './identity';

/**
 * Request schemas for Slice 2 (academic structure, students, enrolments, teacher assignments).
 *
 * No schema here accepts a `schoolId`: the school is always taken from the caller's verified
 * membership (the path segment only selects which membership). Unknown keys are stripped.
 */

/** A calendar date, `YYYY-MM-DD`, that actually exists (rejects 2026-02-30). */
export const IsoDateSchema = z.iso.date().refine((s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, 'must be a real calendar date');

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const MAX_YEAR_SPAN_DAYS = 550;

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

// ---------------------------------------------------------------------------------------
// Academic years
// ---------------------------------------------------------------------------------------

export const CreateAcademicYearSchema = z
  .object({
    name: singleLineText(60),
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
  })
  .superRefine((v, ctx) => {
    const span = daysBetween(v.startDate, v.endDate);
    if (span <= 0) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'must be after startDate' });
    else if (span > MAX_YEAR_SPAN_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: `year may span at most ${MAX_YEAR_SPAN_DAYS} days` });
    }
  });

export const UpdateAcademicYearSchema = z
  .object({
    name: singleLineText(60).optional(),
    startDate: IsoDateSchema.optional(),
    endDate: IsoDateSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'at least one field is required');

export const AcademicYearStatusQuerySchema = z.object({
  status: z.enum(['planned', 'active', 'closed', 'archived']).optional(),
});

// ---------------------------------------------------------------------------------------
// Grades, sections, subjects
// ---------------------------------------------------------------------------------------

export const CreateGradeSchema = z.object({
  gradeNumber: z.coerce.number().int().min(1).max(7),
  displayName: singleLineText(60).optional(),
});

export const CreateSectionSchema = z.object({
  gradeId: z.uuid(),
  name: singleLineText(40),
});

export const SectionListQuerySchema = z.object({ gradeId: z.uuid().optional() });

export const SubjectCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z][A-Z0-9_]{1,15}$/, 'must be 2–16 letters, digits or _, starting with a letter'));

/**
 * Optional labels per UI language. `strict` so an unsupported language is a 400, not silently
 * dropped. Adding a language: extend this object and the CHECK in the migration.
 */
export const SubjectTranslationsSchema = z
  .object({ en: singleLineText(100).optional(), kn: singleLineText(100).optional() })
  .strict();

export const CreateSubjectSchema = z.object({
  code: SubjectCodeSchema,
  name: singleLineText(100),
  nameTranslations: SubjectTranslationsSchema.default({}),
});

export const UpdateSubjectSchema = z
  .object({
    name: singleLineText(100).optional(),
    nameTranslations: SubjectTranslationsSchema.optional(),
    status: z.enum(['active', 'retired']).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'at least one field is required');

/** Associate a subject with one section, or with every section of a grade in the year. */
export const CreateClassSubjectSchema = z
  .object({
    subjectId: z.uuid(),
    sectionId: z.uuid().optional(),
    gradeId: z.uuid().optional(),
  })
  .refine((v) => (v.sectionId === undefined) !== (v.gradeId === undefined), {
    message: 'exactly one of sectionId or gradeId is required',
    path: ['sectionId'],
  });

export const ClassSubjectListQuerySchema = z.object({ sectionId: z.uuid().optional() });

/**
 * Suggested starting points for a Karnataka primary school. Offered by clients, never seeded
 * by the server: schools configure their own curriculum. Kannada labels need native-speaker
 * review before release (backlog: i18n QA).
 */
export const SUGGESTED_SUBJECTS = [
  { code: 'KAN', name: 'Kannada', nameTranslations: { en: 'Kannada', kn: 'ಕನ್ನಡ' } },
  { code: 'ENG', name: 'English', nameTranslations: { en: 'English', kn: 'ಇಂಗ್ಲಿಷ್' } },
  { code: 'HIN', name: 'Hindi', nameTranslations: { en: 'Hindi', kn: 'ಹಿಂದಿ' } },
  { code: 'MATH', name: 'Mathematics', nameTranslations: { en: 'Mathematics', kn: 'ಗಣಿತ' } },
  { code: 'EVS', name: 'Environmental Studies', nameTranslations: { en: 'Environmental Studies', kn: 'ಪರಿಸರ ಅಧ್ಯಯನ' } },
  { code: 'SCI', name: 'Science', nameTranslations: { en: 'Science', kn: 'ವಿಜ್ಞಾನ' } },
  { code: 'SS', name: 'Social Science', nameTranslations: { en: 'Social Science', kn: 'ಸಮಾಜ ವಿಜ್ಞಾನ' } },
] as const;

// ---------------------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------------------

export const StudentNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9/-]{0,31}$/, 'must be 1–32 letters, digits, / or -'));

const DateOfBirthSchema = IsoDateSchema.refine((d) => d >= '1990-01-01', 'implausible date of birth').refine(
  (d) => d <= new Date().toISOString().slice(0, 10),
  'date of birth cannot be in the future',
);

/**
 * Deliberately minimal (07 §4). `studentNumber` is optional: when omitted the server issues the
 * next number from the school's counter.
 */
export const CreateStudentSchema = z.object({
  studentNumber: StudentNumberSchema.optional(),
  fullName: singleLineText(120),
  dateOfBirth: DateOfBirthSchema.optional(),
});

export const UpdateStudentSchema = z
  .object({
    fullName: singleLineText(120).optional(),
    dateOfBirth: DateOfBirthSchema.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'at least one field is required');

export const StudentListQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(['active', 'transferred', 'withdrawn']).optional(),
});

/**
 * Leaving the school ends every current placement on `effectiveDate`. Returning (`active`)
 * changes only the student's status; the school then enrols them again explicitly.
 */
export const ChangeStudentStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('withdrawn'), effectiveDate: IsoDateSchema }),
  z.object({ status: z.literal('transferred'), effectiveDate: IsoDateSchema }),
  z.object({ status: z.literal('active') }),
]);

// ---------------------------------------------------------------------------------------
// Enrolments
// ---------------------------------------------------------------------------------------

export const CreateEnrollmentSchema = z.object({
  studentId: z.uuid(),
  sectionId: z.uuid(),
  effectiveFrom: IsoDateSchema,
});

export const TransferEnrollmentSchema = z.object({
  sectionId: z.uuid(),
  effectiveDate: IsoDateSchema,
});

export const VoidEnrollmentSchema = z.object({ reason: singleLineText(500) });

export const PromotionSchema = z
  .object({
    effectiveFrom: IsoDateSchema,
    items: z
      .array(z.object({ enrollmentId: z.uuid(), sectionId: z.uuid() }))
      .min(1)
      .max(200),
  })
  .refine((v) => new Set(v.items.map((i) => i.enrollmentId)).size === v.items.length, {
    message: 'each enrollmentId may appear once',
    path: ['items'],
  });

export const RosterQuerySchema = PaginationQuerySchema.extend({ date: IsoDateSchema });

// ---------------------------------------------------------------------------------------
// Teacher assignments
// ---------------------------------------------------------------------------------------

export const CreateTeacherAssignmentSchema = z.object({
  classSubjectId: z.uuid(),
  membershipId: z.uuid(),
});

export const TeacherAssignmentListQuerySchema = PaginationQuerySchema.extend({
  academicYearId: z.uuid().optional(),
  includeEnded: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
});
