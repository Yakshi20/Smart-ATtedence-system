import {
  ChangeStudentStatusSchema,
  CreateAcademicYearSchema,
  CreateClassSubjectSchema,
  CreateStudentSchema,
  CreateSubjectSchema,
  IsoDateSchema,
  PromotionSchema,
  StudentNumberSchema,
  SubjectTranslationsSchema,
} from './academic';

const uuid = '11111111-1111-4111-8111-111111111111';

describe('IsoDateSchema', () => {
  test.each(['2026-06-01', '2028-02-29'])('accepts %s', (d) => {
    expect(IsoDateSchema.safeParse(d).success).toBe(true);
  });
  test.each(['2026-02-30', '2027-02-29', '01-06-2026', '2026-6-1', '2026-06-01T00:00:00Z'])('rejects %s', (d) => {
    expect(IsoDateSchema.safeParse(d).success).toBe(false);
  });
});

describe('CreateAcademicYearSchema', () => {
  test('accepts a normal year', () => {
    expect(
      CreateAcademicYearSchema.safeParse({ name: '2026-27', startDate: '2026-06-01', endDate: '2027-03-31' }).success,
    ).toBe(true);
  });

  test.each([
    ['end equal to start', '2026-06-01', '2026-06-01'],
    ['end before start', '2026-06-01', '2026-05-31'],
    ['span over 550 days', '2026-06-01', '2027-12-31'],
  ])('rejects %s, reporting endDate', (_l, startDate, endDate) => {
    const r = CreateAcademicYearSchema.safeParse({ name: 'x', startDate, endDate });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['endDate']);
  });
});

test('subject codes are normalized to upper case', () => {
  expect(CreateSubjectSchema.parse({ code: ' math ', name: 'Mathematics' })).toEqual({
    code: 'MATH',
    name: 'Mathematics',
    nameTranslations: {},
  });
});

test('translations reject unsupported languages instead of dropping them', () => {
  expect(SubjectTranslationsSchema.safeParse({ kn: 'ಗಣಿತ' }).success).toBe(true);
  expect(SubjectTranslationsSchema.safeParse({ fr: 'Maths' }).success).toBe(false);
});

test('class-subject needs exactly one of sectionId / gradeId', () => {
  expect(CreateClassSubjectSchema.safeParse({ subjectId: uuid, sectionId: uuid }).success).toBe(true);
  expect(CreateClassSubjectSchema.safeParse({ subjectId: uuid, gradeId: uuid }).success).toBe(true);
  expect(CreateClassSubjectSchema.safeParse({ subjectId: uuid }).success).toBe(false);
  expect(CreateClassSubjectSchema.safeParse({ subjectId: uuid, sectionId: uuid, gradeId: uuid }).success).toBe(false);
});

describe('students', () => {
  test('student numbers are normalized and restricted', () => {
    expect(StudentNumberSchema.parse(' 2026/ab-7 ')).toBe('2026/AB-7');
    expect(StudentNumberSchema.safeParse('has space').success).toBe(false);
    expect(StudentNumberSchema.safeParse('/leading').success).toBe(false);
  });

  test('a schoolId in the payload is stripped', () => {
    expect(CreateStudentSchema.parse({ fullName: 'Asha', schoolId: uuid })).toEqual({ fullName: 'Asha' });
  });

  test('a future date of birth is rejected', () => {
    expect(CreateStudentSchema.safeParse({ fullName: 'Asha', dateOfBirth: '2999-01-01' }).success).toBe(false);
  });

  test('leaving requires an effective date; readmission does not', () => {
    expect(ChangeStudentStatusSchema.safeParse({ status: 'withdrawn' }).success).toBe(false);
    expect(ChangeStudentStatusSchema.safeParse({ status: 'withdrawn', effectiveDate: '2026-10-01' }).success).toBe(true);
    expect(ChangeStudentStatusSchema.safeParse({ status: 'active' }).success).toBe(true);
  });
});

test('a promotion batch may not list an enrolment twice', () => {
  const item = { enrollmentId: uuid, sectionId: uuid };
  expect(PromotionSchema.safeParse({ effectiveFrom: '2027-06-01', items: [item, item] }).success).toBe(false);
});
