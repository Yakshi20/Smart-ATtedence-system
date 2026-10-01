import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { createTestDatabase, type TestDatabase } from './testing/test-database';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase('schema');
}, 30_000);

afterAll(async () => {
  await database?.close();
});

const tables = Object.values(schema).filter((v): v is PgTable => v instanceof PgTable);

async function columnsOf(table: string): Promise<Map<string, boolean>> {
  const { rows } = await database.pool.query<{ column_name: string; is_nullable: 'YES' | 'NO' }>(
    `SELECT column_name, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Map(rows.map((r) => [r.column_name, r.is_nullable === 'YES']));
}

test('the Drizzle schema declares exactly the migrated application tables', () => {
  expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual(
    [
      // 0004
      'attendance_corrections',
      'attendance_records',
      'attendance_sessions',
      // 0003
      'guardian_link_claims',
      'guardians',
      'otp_challenges',
      'student_guardians',
      // 0002
      'academic_years',
      'class_subjects',
      'enrollments',
      'grades',
      'sections',
      'student_number_counters',
      'students',
      'subjects',
      'teacher_assignments',
      // 0001
      'account_activation_tokens',
      'audit_logs',
      'auth_identities',
      'platform_memberships',
      'refresh_tokens',
      'school_memberships',
      'school_registration_requests',
      'schools',
      'user_sessions',
      'users',
    ].sort(),
  );
});

test('every table in the migrated database is declared in the Drizzle schema', async () => {
  const { rows } = await database.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`,
  );
  const declared = new Set(tables.map((t) => getTableConfig(t).name));
  expect(rows.map((r) => r.table_name).filter((n) => !declared.has(n))).toEqual([]);
});

describe.each(tables.map((t) => [getTableConfig(t).name, t] as const))(
  'Drizzle table %s matches the migrated database',
  (name, table) => {
    test('every declared column exists with the same nullability', async () => {
      const actual = await columnsOf(name);
      expect(actual.size).toBeGreaterThan(0);

      for (const column of getTableConfig(table).columns) {
        expect({ column: column.name, exists: actual.has(column.name) }).toEqual({
          column: column.name,
          exists: true,
        });
        expect({ column: column.name, nullable: actual.get(column.name) }).toEqual({
          column: column.name,
          nullable: !column.notNull,
        });
      }
    });

    test('the database has no column the Drizzle schema omits', async () => {
      const declared = new Set(getTableConfig(table).columns.map((c) => c.name));
      const undeclared = [...(await columnsOf(name)).keys()].filter((c) => !declared.has(c));
      expect(undeclared).toEqual([]);
    });
  },
);

describe('database-level invariants', () => {
  async function insertUser(email: string): Promise<string> {
    const { rows } = await database.pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, 'Test') RETURNING id`,
      [email],
    );
    return rows[0]!.id;
  }

  test('audit_logs rejects UPDATE and DELETE', async () => {
    await database.pool.query(
      `INSERT INTO audit_logs (action, entity_type) VALUES ('test.appended', 'test')`,
    );
    await expect(database.pool.query(`UPDATE audit_logs SET action = 'test.rewritten'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(database.pool.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });

  test('a plaintext secret cannot be stored as a credential', async () => {
    const userId = await insertUser('plain@example.test');
    await expect(
      database.pool.query(
        `INSERT INTO auth_identities (user_id, provider, provider_subject, secret_hash)
         VALUES ($1, 'staff_password', 'plain@example.test', 'hunter2hunter2')`,
        [userId],
      ),
    ).rejects.toThrow(/auth_identities_secret_is_argon2id/);
  });

  test('a registration request cannot be approved without a reviewer and a school', async () => {
    const { rows } = await database.pool.query<{ id: string }>(
      `INSERT INTO school_registration_requests
         (school_name, sector, district_name, address_line, pincode,
          contact_name, contact_email, contact_phone)
       VALUES ('S', 'government', 'Mysuru', 'Road 1', '570001', 'C', 'c@example.test', '+919876543210')
       RETURNING id`,
    );
    await expect(
      database.pool.query(`UPDATE school_registration_requests SET status = 'approved' WHERE id = $1`, [
        rows[0]!.id,
      ]),
    ).rejects.toThrow(/srr_decision_consistent/);
  });

  test('school codes are unique and restricted to the unambiguous alphabet', async () => {
    const insert = (code: string) =>
      database.pool.query(
        `INSERT INTO schools (school_code, name, sector, district_name)
         VALUES ($1, 'S', 'private', 'Mysuru')`,
        [code],
      );
    await insert('ABCD2345');
    await expect(insert('ABCD2345')).rejects.toThrow(/schools_school_code_key/);
    await expect(insert('ABCD0O1I')).rejects.toThrow(/schools_school_code_format/);
  });

  test('email addresses must be stored normalized', async () => {
    await expect(insertUser('Mixed@Example.test')).rejects.toThrow(/users_email_normalized/);
  });

  test('a refresh token hash must be exactly 32 bytes (SHA-256), never raw token text', async () => {
    const userId = await insertUser('rt@example.test');
    const { rows } = await database.pool.query<{ id: string }>(
      `INSERT INTO user_sessions (user_id, expires_at) VALUES ($1, now() + interval '1 day') RETURNING id`,
      [userId],
    );
    await expect(
      database.pool.query(
        `INSERT INTO refresh_tokens (session_id, token_hash, expires_at)
         VALUES ($1, convert_to('a-plaintext-refresh-token-value-longer-than-32', 'UTF8'), now() + interval '1 day')`,
        [rows[0]!.id],
      ),
    ).rejects.toThrow(/refresh_tokens_hash_is_sha256/);
  });
});
