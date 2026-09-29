import { Client } from 'pg';
import { createTestDatabase, reapStaleDatabases } from './test-database';

test('each call yields a distinct, connectable database', async () => {
  const a = await createTestDatabase('iso_a');
  const b = await createTestDatabase('iso_b');

  try {
    expect(a.name).not.toEqual(b.name);
    expect(a.name).toMatch(/^ss_test_iso_a_[0-9a-z]+_[0-9a-f]{12}$/);

    const { rows } = await a.pool.query<{ current_database: string }>('SELECT current_database()');
    expect(rows[0]?.current_database).toEqual(a.name);
  } finally {
    await a.close();
    await b.close();
  }
}, 30_000);

test('close drops the database so runs do not leak', async () => {
  const db = await createTestDatabase('dropme');
  const name = db.name;
  await db.close();

  const admin = new Client({ connectionString: process.env['TEST_DATABASE_ADMIN_URL'] });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    expect(rows).toHaveLength(0);
  } finally {
    await admin.end();
  }
}, 30_000);

test('the migration ledger exists in a fresh database', async () => {
  const db = await createTestDatabase('ledger');
  try {
    const { rows } = await db.pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
    );
    expect(rows).toHaveLength(1);
  } finally {
    await db.close();
  }
}, 30_000);

describe('reaping debris from crashed runs', () => {
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env['TEST_DATABASE_ADMIN_URL'] });
    await admin.connect();
  });

  afterAll(async () => {
    await admin.end();
  });

  async function exists(name: string): Promise<boolean> {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return rows.length === 1;
  }

  test('drops a stale database and spares a fresh one', async () => {
    const stale = `ss_test_crashed_${(Date.now() - 2 * 60 * 60 * 1000).toString(36)}_aaaaaaaaaaaa`;
    const fresh = `ss_test_running_${Date.now().toString(36)}_bbbbbbbbbbbb`;
    await admin.query(`CREATE DATABASE "${stale}"`);
    await admin.query(`CREATE DATABASE "${fresh}"`);

    try {
      const dropped = await reapStaleDatabases(admin);

      expect(dropped).toContain(stale);
      expect(dropped).not.toContain(fresh);
      expect(await exists(stale)).toBe(false);
      expect(await exists(fresh)).toBe(true);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${stale}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS "${fresh}" WITH (FORCE)`);
    }
  }, 30_000);

  test('ignores databases that are not ours', async () => {
    // A name that does not match the harness pattern must never be dropped, however old.
    const bystander = 'ss_test_not_our_format';
    await admin.query(`CREATE DATABASE "${bystander}"`);
    try {
      const dropped = await reapStaleDatabases(admin, 0);
      expect(dropped).not.toContain(bystander);
      expect(await exists(bystander)).toBe(true);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${bystander}" WITH (FORCE)`);
    }
  }, 30_000);
});
