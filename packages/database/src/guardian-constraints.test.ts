import { createTestDatabase, type TestDatabase } from './testing/test-database';

/**
 * Database-level guarantees of migration 0003, with raw SQL and no application code in between.
 */
let db: TestDatabase;
let schoolA: string;
let schoolB: string;
let studentA: string;
let studentB: string;
let guardianA: string;
let guardianB: string;
let staff: string;

async function id(sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(sql, params);
  return rows[0]!.id;
}

const school = (code: string) =>
  id(`INSERT INTO schools (school_code, name, sector, district_name) VALUES ($1, $1, 'government', 'Mysuru') RETURNING id`, [code]);
const student = (schoolId: string, number: string) =>
  id(`INSERT INTO students (school_id, student_number, full_name) VALUES ($1, $2, 'Child') RETURNING id`, [schoolId, number]);
const guardian = (schoolId: string, phone: string) =>
  id(`INSERT INTO guardians (school_id, full_name, phone) VALUES ($1, 'Parent', $2) RETURNING id`, [schoolId, phone]);
const link = (schoolId: string, studentId: string, guardianId: string) =>
  id(
    `INSERT INTO student_guardians (school_id, student_id, guardian_id, relationship_type, initiated_via)
     VALUES ($1, $2, $3, 'mother', 'school') RETURNING id`,
    [schoolId, studentId, guardianId],
  );

beforeAll(async () => {
  db = await createTestDatabase('guardians');
  schoolA = await school('AAAAAAAA');
  schoolB = await school('BBBBBBBB');
  studentA = await student(schoolA, '0001');
  studentB = await student(schoolB, '0001');
  guardianA = await guardian(schoolA, '+919845012345');
  // The same phone may be a guardian record in another school.
  guardianB = await guardian(schoolB, '+919845012345');
  staff = await id(`INSERT INTO users (email, display_name) VALUES ('staff@example.test', 'Staff') RETURNING id`);
}, 30_000);

afterAll(async () => {
  await db?.close();
});

describe('phone identities', () => {
  let userId: string;
  beforeAll(async () => {
    userId = await id(`INSERT INTO users (phone, display_name) VALUES ('+919845012345', 'Guardian') RETURNING id`);
  });

  test('a phone identity has no secret and an E.164 subject', async () => {
    await db.pool.query(
      `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'phone_otp', '+919845012345')`,
      [userId],
    );
    const other = await id(`INSERT INTO users (display_name) VALUES ('X') RETURNING id`);
    await expect(
      db.pool.query(
        `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'phone_otp', '9845012345')`,
        [other],
      ),
    ).rejects.toThrow(/auth_identities_secret_matches_provider/);
    await expect(
      db.pool.query(
        `INSERT INTO auth_identities (user_id, provider, provider_subject, secret_hash)
         VALUES ($1, 'phone_otp', '+919900000000', '$argon2id$v=19$x')`,
        [other],
      ),
    ).rejects.toThrow(/auth_identities_secret_matches_provider/);
  });

  test('one phone identity per phone number', async () => {
    const other = await id(`INSERT INTO users (display_name) VALUES ('Y') RETURNING id`);
    await expect(
      db.pool.query(
        `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'phone_otp', '+919845012345')`,
        [other],
      ),
    ).rejects.toThrow(/auth_identities_subject_unique/);
  });

  test('a password identity still requires an argon2id hash', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO auth_identities (user_id, provider, provider_subject) VALUES ($1, 'staff_password', 'staff@example.test')`,
        [staff],
      ),
    ).rejects.toThrow(/auth_identities_secret_matches_provider/);
  });
});

describe('OTP challenges', () => {
  const insert = (phone: string) =>
    db.pool.query(
      `INSERT INTO otp_challenges (phone, purpose, code_hmac, expires_at, max_attempts)
       VALUES ($1, 'guardian_login', decode(repeat('ab', 32), 'hex'), now() + interval '5 minutes', 5) RETURNING id`,
      [phone],
    );

  test('only one open challenge per phone', async () => {
    const first = (await insert('+919811111111')).rows[0].id;
    await expect(insert('+919811111111')).rejects.toThrow(/otp_challenges_one_open_per_phone/);
    await db.pool.query(`UPDATE otp_challenges SET invalidated_at = now() WHERE id = $1`, [first]);
    await insert('+919811111111');
  });

  test('a code is stored only as a 32-byte MAC, never as digits', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO otp_challenges (phone, purpose, code_hmac, expires_at, max_attempts)
         VALUES ('+919822222222', 'guardian_login', convert_to('123456', 'UTF8'), now() + interval '5 minutes', 5)`,
      ),
    ).rejects.toThrow(/otp_challenges_hmac_is_sha256/);
  });

  test('attempts cannot exceed the maximum', async () => {
    const c = (await insert('+919833333333')).rows[0].id;
    await expect(db.pool.query(`UPDATE otp_challenges SET attempts = 6 WHERE id = $1`, [c])).rejects.toThrow(
      /otp_challenges_attempts_bounded/,
    );
  });
});

describe('guardian links', () => {
  test('a guardian of school B cannot be linked to a student of school A, whichever school_id is claimed', async () => {
    for (const schoolId of [schoolA, schoolB]) {
      await expect(
        db.pool.query(
          `INSERT INTO student_guardians (school_id, student_id, guardian_id, relationship_type, initiated_via)
           VALUES ($1, $2, $3, 'father', 'school')`,
          [schoolId, studentA, guardianB],
        ),
      ).rejects.toThrow(/student_guardians_(student|guardian)_same_school_fk/);
    }
  });

  test('one guardian record per phone per school', async () => {
    await expect(guardian(schoolA, '+919845012345')).rejects.toThrow(/guardians_school_phone_key/);
  });

  test('one live link per student and guardian; a new one may follow a rejection', async () => {
    const s = await student(schoolA, '0002');
    const first = await link(schoolA, s, guardianA);
    await expect(link(schoolA, s, guardianA)).rejects.toThrow(/student_guardians_one_live/);

    await db.pool.query(
      `UPDATE student_guardians SET status = 'rejected', rejected_by = $2, rejected_at = now(), status_reason = 'not the parent'
       WHERE id = $1`,
      [first, staff],
    );
    await link(schoolA, s, guardianA);
  });

  test('verification must record who and when', async () => {
    const l = await link(schoolA, await student(schoolA, '0003'), guardianA);
    await expect(
      db.pool.query(`UPDATE student_guardians SET status = 'verified' WHERE id = $1`, [l]),
    ).rejects.toThrow(/student_guardians_status_consistent/);
  });

  test('revocation needs a reason and a revoker, and is final', async () => {
    const l = await link(schoolA, await student(schoolA, '0004'), guardianA);
    await db.pool.query(
      `UPDATE student_guardians SET status = 'verified', verified_by = $2, verified_at = now() WHERE id = $1`,
      [l, staff],
    );
    await expect(
      db.pool.query(`UPDATE student_guardians SET status = 'revoked', revoked_by = $2, revoked_at = now() WHERE id = $1`, [l, staff]),
    ).rejects.toThrow(/student_guardians_status_consistent/);

    await db.pool.query(
      `UPDATE student_guardians SET status = 'revoked', revoked_by = $2, revoked_at = now(), status_reason = 'court order'
       WHERE id = $1`,
      [l, staff],
    );
    await expect(
      db.pool.query(
        `UPDATE student_guardians SET status = 'verified', revoked_at = NULL, revoked_by = NULL, status_reason = NULL WHERE id = $1`,
        [l],
      ),
    ).rejects.toThrow(/cannot move from revoked to verified/);
  });

  test('illegal transitions and rewrites are refused', async () => {
    const l = await link(schoolA, await student(schoolA, '0005'), guardianA);
    // pending → revoked skips verification.
    await expect(
      db.pool.query(
        `UPDATE student_guardians SET status = 'revoked', revoked_by = $2, revoked_at = now(), verified_by = $2,
           verified_at = now(), status_reason = 'x' WHERE id = $1`,
        [l, staff],
      ),
    ).rejects.toThrow(/cannot move from pending to revoked/);
    await expect(
      db.pool.query(`UPDATE student_guardians SET relationship_type = 'father' WHERE id = $1`, [l]),
    ).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`UPDATE student_guardians SET student_id = $2 WHERE id = $1`, [l, studentA])).rejects.toThrow(
      /immutable/,
    );
    await expect(db.pool.query(`DELETE FROM student_guardians WHERE id = $1`, [l])).rejects.toThrow(/never deleted/);
  });

  test('the same phone can be a verified guardian in two schools, each link in its own school', async () => {
    await link(schoolA, studentA, guardianA);
    await link(schoolB, studentB, guardianB);
  });
});
