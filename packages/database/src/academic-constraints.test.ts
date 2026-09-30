import { createTestDatabase, type TestDatabase } from './testing/test-database';

/**
 * Database-level guarantees of migration 0002, exercised with raw SQL so that no application
 * code stands between the test and the constraint. If one of these passes only because the API
 * happens to check first, the test is in the wrong place.
 */
let db: TestDatabase;

interface SchoolFixture {
  schoolId: string;
  yearId: string;
  gradeId: string;
  sectionId: string;
  subjectId: string;
  classSubjectId: string;
  studentId: string;
  membershipId: string;
}

let a: SchoolFixture;
let b: SchoolFixture;

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.pool.query(sql, params);
  return rows[0] as T;
}

async function id(sql: string, params: unknown[] = []): Promise<string> {
  return (await one<{ id: string }>(sql, params)).id;
}

async function schoolFixture(code: string): Promise<SchoolFixture> {
  const schoolId = await id(
    `INSERT INTO schools (school_code, name, sector, district_name) VALUES ($1, $1, 'government', 'Mysuru') RETURNING id`,
    [code],
  );
  const yearId = await id(
    `INSERT INTO academic_years (school_id, name, start_date, end_date, status)
     VALUES ($1, '2026-27', '2026-06-01', '2027-03-31', 'active') RETURNING id`,
    [schoolId],
  );
  const gradeId = await id(
    `INSERT INTO grades (school_id, grade_number, display_name) VALUES ($1, 5, 'Class 5') RETURNING id`,
    [schoolId],
  );
  const sectionId = await id(
    `INSERT INTO sections (school_id, academic_year_id, grade_id, name) VALUES ($1, $2, $3, 'A') RETURNING id`,
    [schoolId, yearId, gradeId],
  );
  const subjectId = await id(
    `INSERT INTO subjects (school_id, code, name) VALUES ($1, 'MATH', 'Mathematics') RETURNING id`,
    [schoolId],
  );
  const classSubjectId = await id(
    `INSERT INTO class_subjects (school_id, academic_year_id, section_id, subject_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [schoolId, yearId, sectionId, subjectId],
  );
  const studentId = await id(
    `INSERT INTO students (school_id, student_number, full_name) VALUES ($1, '0001', 'Pupil') RETURNING id`,
    [schoolId],
  );
  const userId = await id(
    `INSERT INTO users (email, display_name) VALUES ($1, 'Teacher') RETURNING id`,
    [`teacher.${code.toLowerCase()}@example.test`],
  );
  const membershipId = await id(
    `INSERT INTO school_memberships (school_id, user_id, role) VALUES ($1, $2, 'teacher') RETURNING id`,
    [schoolId, userId],
  );
  return { schoolId, yearId, gradeId, sectionId, subjectId, classSubjectId, studentId, membershipId };
}

beforeAll(async () => {
  db = await createTestDatabase('academic');
  a = await schoolFixture('AAAAAAAA');
  b = await schoolFixture('BBBBBBBB');
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('cross-school links are unrepresentable', () => {
  test('a section cannot combine one school with another school’s year or grade', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO sections (school_id, academic_year_id, grade_id, name) VALUES ($1, $2, $3, 'X')`,
        [a.schoolId, b.yearId, a.gradeId],
      ),
    ).rejects.toThrow(/sections_year_same_school_fk/);
    await expect(
      db.pool.query(
        `INSERT INTO sections (school_id, academic_year_id, grade_id, name) VALUES ($1, $2, $3, 'X')`,
        [a.schoolId, a.yearId, b.gradeId],
      ),
    ).rejects.toThrow(/sections_grade_same_school_fk/);
  });

  test('a class-subject cannot pair school A’s section with school B’s subject', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO class_subjects (school_id, academic_year_id, section_id, subject_id) VALUES ($1, $2, $3, $4)`,
        [a.schoolId, a.yearId, a.sectionId, b.subjectId],
      ),
    ).rejects.toThrow(/class_subjects_subject_same_school_fk/);
  });

  test('a student of school B cannot be enrolled in a section of school A', async () => {
    for (const schoolId of [a.schoolId, b.schoolId]) {
      await expect(
        db.pool.query(
          `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, effective_from)
           VALUES ($1, $2, $3, $4, '2026-06-01')`,
          [schoolId, b.studentId, a.yearId, a.sectionId],
        ),
      ).rejects.toThrow(/enrollments_(student|section)_same_school/);
    }
  });

  test('a teacher of school B cannot be assigned to a class-subject of school A', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO teacher_assignments (school_id, academic_year_id, class_subject_id, membership_id)
         VALUES ($1, $2, $3, $4)`,
        [a.schoolId, a.yearId, a.classSubjectId, b.membershipId],
      ),
    ).rejects.toThrow(/teacher_assignments_membership_same_school_fk/);
  });
});

describe('cross-year links are unrepresentable', () => {
  let nextYearId: string;

  beforeAll(async () => {
    nextYearId = await id(
      `INSERT INTO academic_years (school_id, name, start_date, end_date) VALUES ($1, '2027-28', '2027-06-01', '2028-03-31') RETURNING id`,
      [a.schoolId],
    );
  });

  test('an enrolment’s academic year must be its section’s year', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, effective_from)
         VALUES ($1, $2, $3, $4, '2027-06-01')`,
        [a.schoolId, a.studentId, nextYearId, a.sectionId],
      ),
    ).rejects.toThrow(/enrollments_section_same_school_year_fk/);
  });

  test('a teacher assignment’s academic year must be its class-subject’s year', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO teacher_assignments (school_id, academic_year_id, class_subject_id, membership_id)
         VALUES ($1, $2, $3, $4)`,
        [a.schoolId, nextYearId, a.classSubjectId, a.membershipId],
      ),
    ).rejects.toThrow(/teacher_assignments_class_subject_same_school_year_fk/);
  });
});

describe('academic years', () => {
  test('end must follow start', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO academic_years (school_id, name, start_date, end_date) VALUES ($1, 'bad', '2030-06-01', '2030-06-01')`,
        [a.schoolId],
      ),
    ).rejects.toThrow(/academic_years_dates_ordered/);
  });

  test('two years of one school cannot overlap; another school’s may', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO academic_years (school_id, name, start_date, end_date) VALUES ($1, 'overlap', '2027-03-31', '2027-05-31')`,
        [a.schoolId],
      ),
    ).rejects.toThrow(/academic_years_no_overlap/);

    await db.pool.query(
      `INSERT INTO academic_years (school_id, name, start_date, end_date) VALUES ($1, 'bridge', '2027-04-01', '2027-05-31')`,
      [b.schoolId],
    );
  });

  test('only one active year per school', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO academic_years (school_id, name, start_date, end_date, status)
         VALUES ($1, '2031-32', '2031-06-01', '2032-03-31', 'active')`,
        [a.schoolId],
      ),
    ).rejects.toThrow(/academic_years_one_active_per_school/);
  });
});

describe('structure uniqueness', () => {
  test('grades are limited to Classes 1–7 and unique per school', async () => {
    await expect(
      db.pool.query(`INSERT INTO grades (school_id, grade_number, display_name) VALUES ($1, 8, 'Class 8')`, [
        a.schoolId,
      ]),
    ).rejects.toThrow(/grades_number_in_scope/);
    await expect(
      db.pool.query(`INSERT INTO grades (school_id, grade_number, display_name) VALUES ($1, 5, 'Again')`, [
        a.schoolId,
      ]),
    ).rejects.toThrow(/grades_school_number_key/);
  });

  test('section names are unique per year and grade, ignoring case', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO sections (school_id, academic_year_id, grade_id, name) VALUES ($1, $2, $3, 'a')`,
        [a.schoolId, a.yearId, a.gradeId],
      ),
    ).rejects.toThrow(/sections_year_grade_name_key/);
  });

  test('subject codes are unique per school and labels only in known languages', async () => {
    await expect(
      db.pool.query(`INSERT INTO subjects (school_id, code, name) VALUES ($1, 'MATH', 'Maths again')`, [a.schoolId]),
    ).rejects.toThrow(/subjects_school_code_key/);
    await expect(
      db.pool.query(
        `INSERT INTO subjects (school_id, code, name, name_translations) VALUES ($1, 'SCI', 'Science', '{"fr":"Sciences"}')`,
        [a.schoolId],
      ),
    ).rejects.toThrow(/subjects_translations_known_languages/);
  });

  test('a subject is associated with a section at most once', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO class_subjects (school_id, academic_year_id, section_id, subject_id) VALUES ($1, $2, $3, $4)`,
        [a.schoolId, a.yearId, a.sectionId, a.subjectId],
      ),
    ).rejects.toThrow(/class_subjects_section_subject_key/);
  });

  test('student numbers are unique within a school but may repeat across schools', async () => {
    await expect(
      db.pool.query(`INSERT INTO students (school_id, student_number, full_name) VALUES ($1, '0001', 'Dup')`, [
        a.schoolId,
      ]),
    ).rejects.toThrow(/students_school_number_key/);
    // '0001' already exists in school B too — the fixture created both.
    expect(
      (await one<{ n: number }>(`SELECT count(*)::int AS n FROM students WHERE student_number = '0001'`)).n,
    ).toBe(2);
  });
});

describe('enrolment history', () => {
  let studentId: string;
  let otherSectionId: string;

  beforeAll(async () => {
    studentId = await id(
      `INSERT INTO students (school_id, student_number, full_name) VALUES ($1, '0100', 'History Pupil') RETURNING id`,
      [a.schoolId],
    );
    otherSectionId = await id(
      `INSERT INTO sections (school_id, academic_year_id, grade_id, name) VALUES ($1, $2, $3, 'B') RETURNING id`,
      [a.schoolId, a.yearId, a.gradeId],
    );
  });

  const enrol = (sectionId: string, from: string, to: string | null = null, reason: string | null = null) =>
    db.pool.query<{ id: string }>(
      `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, effective_from, effective_to, end_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [a.schoolId, studentId, a.yearId, sectionId, from, to, reason],
    );

  test('overlapping placements in one year are rejected', async () => {
    const first = await enrol(a.sectionId, '2026-06-01');
    await expect(enrol(otherSectionId, '2026-09-01')).rejects.toThrow(/enrollments_no_overlap/);

    // Ending the first placement lets the next start on the same day (half-open ranges).
    await db.pool.query(
      `UPDATE enrollments SET effective_to = '2026-09-01', end_reason = 'section_transfer' WHERE id = $1`,
      [first.rows[0]!.id],
    );
    await enrol(otherSectionId, '2026-09-01');
  });

  test('dates must fall inside the academic year', async () => {
    const outsider = await id(
      `INSERT INTO students (school_id, student_number, full_name) VALUES ($1, '0101', 'Outside') RETURNING id`,
      [a.schoolId],
    );
    await expect(
      db.pool.query(
        `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, effective_from)
         VALUES ($1, $2, $3, $4, '2027-04-15')`,
        [a.schoolId, outsider, a.yearId, a.sectionId],
      ),
    ).rejects.toThrow(/outside the academic year/);
  });

  test('rows cannot be deleted', async () => {
    await expect(db.pool.query(`DELETE FROM enrollments WHERE student_id = $1`, [studentId])).rejects.toThrow(
      /never deleted/,
    );
  });

  test('a placement cannot be rewritten, and an ended row cannot be re-ended', async () => {
    const { rows } = await db.pool.query<{ id: string; section_id: string }>(
      `SELECT id FROM enrollments WHERE student_id = $1 AND effective_to IS NOT NULL`,
      [studentId],
    );
    const ended = rows[0]!.id;
    await expect(
      db.pool.query(`UPDATE enrollments SET section_id = $2 WHERE id = $1`, [ended, otherSectionId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query(`UPDATE enrollments SET effective_from = '2026-06-02' WHERE id = $1`, [ended]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query(`UPDATE enrollments SET effective_to = '2026-10-01' WHERE id = $1`, [ended]),
    ).rejects.toThrow(/immutable/);
  });

  test('a voided row no longer blocks a corrected placement, and cannot be un-voided', async () => {
    const pupil = await id(
      `INSERT INTO students (school_id, student_number, full_name) VALUES ($1, '0102', 'Mistake') RETURNING id`,
      [a.schoolId],
    );
    const wrong = await id(
      `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, effective_from)
       VALUES ($1, $2, $3, $4, '2026-06-01') RETURNING id`,
      [a.schoolId, pupil, a.yearId, a.sectionId],
    );
    await db.pool.query(`UPDATE enrollments SET voided_at = now(), void_reason = 'wrong section' WHERE id = $1`, [
      wrong,
    ]);
    await db.pool.query(
      `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, effective_from)
       VALUES ($1, $2, $3, $4, '2026-06-01')`,
      [a.schoolId, pupil, a.yearId, otherSectionId],
    );
    await expect(
      db.pool.query(`UPDATE enrollments SET voided_at = NULL, void_reason = NULL WHERE id = $1`, [wrong]),
    ).rejects.toThrow(/immutable/);
  });
});
