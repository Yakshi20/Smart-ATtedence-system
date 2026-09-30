import { createTestDatabase, type TestDatabase } from './testing/test-database';

/**
 * Database-level guarantees of migration 0004, with raw SQL and no application code in between.
 */
let db: TestDatabase;

interface Fixture {
  schoolId: string;
  yearId: string;
  sectionA: string;
  sectionB: string;
  mathA: string;
  mathB: string;
  student: string;
  enrolA: string;
  staff: string;
}
let f: Fixture;
let other: { schoolId: string; yearId: string; section: string; classSubject: string; student: string; enrol: string };

async function id(sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(sql, params);
  return rows[0]!.id;
}

async function school(code: string) {
  const schoolId = await id(
    `INSERT INTO schools (school_code, name, sector, district_name) VALUES ($1, $1, 'government', 'Mysuru') RETURNING id`,
    [code],
  );
  const yearId = await id(
    `INSERT INTO academic_years (school_id, name, start_date, end_date, status)
     VALUES ($1, '2026-27', '2026-06-01', '2027-03-31', 'active') RETURNING id`,
    [schoolId],
  );
  const grade = await id(`INSERT INTO grades (school_id, grade_number, display_name) VALUES ($1, 5, 'Class 5') RETURNING id`, [schoolId]);
  const section = (name: string) =>
    id(`INSERT INTO sections (school_id, academic_year_id, grade_id, name) VALUES ($1, $2, $3, $4) RETURNING id`, [
      schoolId,
      yearId,
      grade,
      name,
    ]);
  const subject = await id(`INSERT INTO subjects (school_id, code, name) VALUES ($1, 'MATH', 'Maths') RETURNING id`, [schoolId]);
  const cs = (sectionId: string) =>
    id(`INSERT INTO class_subjects (school_id, academic_year_id, section_id, subject_id) VALUES ($1, $2, $3, $4) RETURNING id`, [
      schoolId,
      yearId,
      sectionId,
      subject,
    ]);
  return { schoolId, yearId, section, cs };
}

const session = (s: { schoolId: string; yearId: string }, sectionId: string, csId: string, date: string, period = 1) =>
  id(
    `INSERT INTO attendance_sessions (school_id, academic_year_id, section_id, class_subject_id, session_date, period)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [s.schoolId, s.yearId, sectionId, csId, date, period],
  );

const record = (schoolId: string, sessionId: string, sectionId: string, studentId: string, enrollmentId: string, status = 'present') =>
  id(
    `INSERT INTO attendance_records (school_id, session_id, section_id, student_id, enrollment_id, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [schoolId, sessionId, sectionId, studentId, enrollmentId, status],
  );

async function student(schoolId: string, number: string) {
  return id(`INSERT INTO students (school_id, student_number, full_name) VALUES ($1, $2, 'Pupil') RETURNING id`, [schoolId, number]);
}

async function enrol(s: { schoolId: string; yearId: string }, studentId: string, sectionId: string, from = '2026-06-01') {
  return id(
    `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, effective_from)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [s.schoolId, studentId, s.yearId, sectionId, from],
  );
}

beforeAll(async () => {
  db = await createTestDatabase('attendance');
  const s = await school('AAAAAAAA');
  const sectionA = await s.section('A');
  const sectionB = await s.section('B');
  const mathA = await s.cs(sectionA);
  const mathB = await s.cs(sectionB);
  const st = await student(s.schoolId, '0001');
  const enrolA = await enrol(s, st, sectionA);
  const staff = await id(`INSERT INTO users (email, display_name) VALUES ('staff@example.test', 'Staff') RETURNING id`);
  f = { schoolId: s.schoolId, yearId: s.yearId, sectionA, sectionB, mathA, mathB, student: st, enrolA, staff };

  const o = await school('BBBBBBBB');
  const oSection = await o.section('A');
  const oCs = await o.cs(oSection);
  const oStudent = await student(o.schoolId, '0001');
  other = {
    schoolId: o.schoolId,
    yearId: o.yearId,
    section: oSection,
    classSubject: oCs,
    student: oStudent,
    enrol: await enrol(o, oStudent, oSection),
  };
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('sessions', () => {
  test('a session’s section, year and school must be those of its class-subject', async () => {
    await expect(session(f, f.sectionB, f.mathA, '2026-07-01')).rejects.toThrow(/attendance_sessions_class_subject_fk/);
    await expect(session({ schoolId: f.schoolId, yearId: f.yearId }, f.sectionA, other.classSubject, '2026-07-01')).rejects.toThrow(
      /attendance_sessions_class_subject_fk/,
    );
  });

  test('one session per section, date and period', async () => {
    await session(f, f.sectionA, f.mathA, '2026-07-02', 3);
    await expect(session(f, f.sectionA, f.mathA, '2026-07-02', 3)).rejects.toThrow(/attendance_sessions_slot_key/);
    // Another period the same day is a different session (D-10).
    await session(f, f.sectionA, f.mathA, '2026-07-02', 4);
  });

  test('the date must fall inside the academic year, and periods are 1–12', async () => {
    await expect(session(f, f.sectionA, f.mathA, '2027-04-01')).rejects.toThrow(/outside the academic year/);
    await expect(session(f, f.sectionA, f.mathA, '2026-07-03', 13)).rejects.toThrow(/attendance_sessions_period_range/);
  });

  test('a submitted session must carry its submitter, time and idempotency data', async () => {
    const s = await session(f, f.sectionA, f.mathA, '2026-07-04');
    await expect(db.pool.query(`UPDATE attendance_sessions SET status = 'submitted' WHERE id = $1`, [s])).rejects.toThrow(
      /attendance_sessions_submission_complete/,
    );
  });

  test('sessions cannot be moved or deleted', async () => {
    const s = await session(f, f.sectionA, f.mathA, '2026-07-05');
    await expect(db.pool.query(`UPDATE attendance_sessions SET session_date = '2026-07-06' WHERE id = $1`, [s])).rejects.toThrow(
      /immutable/,
    );
    await expect(db.pool.query(`DELETE FROM attendance_sessions WHERE id = $1`, [s])).rejects.toThrow(/never deleted/);
  });
});

describe('records', () => {
  let s: string;
  beforeAll(async () => {
    s = await session(f, f.sectionA, f.mathA, '2026-07-10');
  });

  test('status is one of present, absent, late, approved_leave', async () => {
    const pupil = await student(f.schoolId, '0100');
    const e = await enrol(f, pupil, f.sectionA);
    await expect(record(f.schoolId, s, f.sectionA, pupil, e, 'sick')).rejects.toThrow(/attendance_records_status_valid/);
  });

  test('one record per student per session', async () => {
    await record(f.schoolId, s, f.sectionA, f.student, f.enrolA);
    await expect(record(f.schoolId, s, f.sectionA, f.student, f.enrolA, 'absent')).rejects.toThrow(
      /attendance_records_session_student_key/,
    );
  });

  test('the enrolment must be in the session’s section, school and cover the date', async () => {
    // Another school's pupil.
    await expect(record(f.schoolId, s, f.sectionA, other.student, other.enrol)).rejects.toThrow(/attendance_records_enrollment_fk/);
    // A pupil of section B in section A's session.
    const pupil = await student(f.schoolId, '0101');
    const inB = await enrol(f, pupil, f.sectionB);
    await expect(record(f.schoolId, s, f.sectionA, pupil, inB)).rejects.toThrow(/attendance_records_enrollment_fk/);
    // Enrolled only from August: not on the 10 July roster.
    const late = await student(f.schoolId, '0102');
    const fromAugust = await enrol(f, late, f.sectionA, '2026-08-01');
    await expect(record(f.schoolId, s, f.sectionA, late, fromAugust)).rejects.toThrow(/does not cover the session date/);
  });

  test('a status cannot change without a correction row, and records cannot be deleted', async () => {
    const pupil = await student(f.schoolId, '0103');
    const e = await enrol(f, pupil, f.sectionA);
    const r = await record(f.schoolId, s, f.sectionA, pupil, e, 'absent');

    await expect(db.pool.query(`UPDATE attendance_records SET status = 'present' WHERE id = $1`, [r])).rejects.toThrow(
      /only through a recorded correction/,
    );
    await expect(
      db.pool.query(`UPDATE attendance_records SET status = 'present', revision = 1 WHERE id = $1`, [r]),
    ).rejects.toThrow(/only through a recorded correction/);
    await expect(db.pool.query(`DELETE FROM attendance_records WHERE id = $1`, [r])).rejects.toThrow(/never deleted/);

    // With the correction row first, the change is accepted.
    await db.pool.query(
      `INSERT INTO attendance_corrections (school_id, record_id, revision, old_status, new_status, reason, corrected_by)
       VALUES ($1, $2, 1, 'absent', 'present', 'Arrived after roll call', $3)`,
      [f.schoolId, r, f.staff],
    );
    await db.pool.query(`UPDATE attendance_records SET status = 'present', revision = 1 WHERE id = $1`, [r]);
  });

  test('corrections need a reason, must change something, and are append-only', async () => {
    const pupil = await student(f.schoolId, '0104');
    const e = await enrol(f, pupil, f.sectionA);
    const r = await record(f.schoolId, s, f.sectionA, pupil, e, 'late');
    const correct = (reason: string, oldS: string, newS: string, rev = 1) =>
      db.pool.query(
        `INSERT INTO attendance_corrections (school_id, record_id, revision, old_status, new_status, reason, corrected_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [f.schoolId, r, rev, oldS, newS, reason, f.staff],
      );
    await expect(correct('   ', 'late', 'present')).rejects.toThrow(/attendance_corrections_reason_present/);
    await expect(correct('no change', 'late', 'late')).rejects.toThrow(/attendance_corrections_changes_something/);
    const { rows } = await correct('Bus delayed; excused', 'late', 'approved_leave');
    await expect(db.pool.query(`UPDATE attendance_corrections SET reason = 'x' WHERE id = $1`, [rows[0].id])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.pool.query(`DELETE FROM attendance_corrections WHERE id = $1`, [rows[0].id])).rejects.toThrow(/append-only/);
  });
});

describe('enrolment history cannot strand recorded attendance', () => {
  test('an enrolment with attendance cannot be voided', async () => {
    const pupil = await student(f.schoolId, '0200');
    const e = await enrol(f, pupil, f.sectionA);
    const s = await session(f, f.sectionA, f.mathA, '2026-09-01');
    await record(f.schoolId, s, f.sectionA, pupil, e);
    await expect(
      db.pool.query(`UPDATE enrollments SET voided_at = now(), void_reason = 'mistake' WHERE id = $1`, [e]),
    ).rejects.toThrow(/cannot be voided/);
  });

  test('an enrolment cannot end on or before a date it has attendance for; after is fine', async () => {
    const pupil = await student(f.schoolId, '0201');
    const e = await enrol(f, pupil, f.sectionA);
    const s = await session(f, f.sectionA, f.mathA, '2026-09-15');
    await record(f.schoolId, s, f.sectionA, pupil, e);

    for (const to of ['2026-09-15', '2026-09-10']) {
      await expect(
        db.pool.query(`UPDATE enrollments SET effective_to = $2, end_reason = 'withdrawn' WHERE id = $1`, [e, to]),
      ).rejects.toThrow(/cannot end earlier/);
    }
    await db.pool.query(`UPDATE enrollments SET effective_to = '2026-09-16', end_reason = 'withdrawn' WHERE id = $1`, [e]);
  });

  test('an enrolment without attendance can still be voided', async () => {
    const pupil = await student(f.schoolId, '0202');
    const e = await enrol(f, pupil, f.sectionA);
    await db.pool.query(`UPDATE enrollments SET voided_at = now(), void_reason = 'mistake' WHERE id = $1`, [e]);
  });
});
