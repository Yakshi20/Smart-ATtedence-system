import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, Pool } from 'pg';
import { appliedMigrations, MIGRATIONS_DIR, runMigrations } from './migrator';

/**
 * The real migration files, applied the way a deployed database experiences them: an earlier
 * schema holding data, then the newer migrations on top (05 §7: "test upgrades against
 * realistic data"). The generic runner guarantees — per-migration transactions, checksums,
 * advisory lock — are covered in migrator.test.ts.
 */
const admin = () => new Client({ connectionString: process.env['TEST_DATABASE_ADMIN_URL'] });
let name: string;
let pool: Pool;
let dir: string;

beforeAll(async () => {
  // Same naming scheme as the harness, so a crashed run is reaped like any other test database.
  name = `ss_test_upgrade_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
  const c = admin();
  await c.connect();
  await c.query(`CREATE DATABASE "${name}"`);
  await c.end();

  const url = new URL(process.env['TEST_DATABASE_ADMIN_URL']!);
  url.pathname = `/${name}`;
  pool = new Pool({ connectionString: url.toString(), max: 2 });
  dir = await mkdtemp(path.join(tmpdir(), 'ss-upgrade-'));
}, 30_000);

afterAll(async () => {
  await pool?.end();
  await rm(dir, { recursive: true, force: true });
  const c = admin();
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await c.end();
});

test('0002 upgrades a database that already holds Slice 1 data, then is idempotent', async () => {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  expect(files.slice(0, 2)).toEqual(['0001_tenancy_identity.sql', '0002_academic_structure.sql']);

  // Stage 1: only 0001, plus data.
  await copyFile(path.join(MIGRATIONS_DIR, files[0]!), path.join(dir, files[0]!));
  expect(await runMigrations(pool, { dir })).toEqual(['0001_tenancy_identity.sql']);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO schools (school_code, name, sector, district_name) VALUES ('ABCD2345', 'Existing', 'government', 'Mysuru') RETURNING id`,
  );
  await pool.query(`INSERT INTO audit_logs (action, entity_type) VALUES ('test.before_upgrade', 'test')`);

  // Stage 2: the full set. Only the new migration applies; existing data is untouched and usable.
  const applied = await runMigrations(pool);
  expect(applied).toEqual(files.slice(1));
  const school = await pool.query(`SELECT name FROM schools WHERE id = $1`, [rows[0]!.id]);
  expect(school.rows).toEqual([{ name: 'Existing' }]);
  await pool.query(
    `INSERT INTO academic_years (school_id, name, start_date, end_date) VALUES ($1, '2026-27', '2026-06-01', '2027-03-31')`,
    [rows[0]!.id],
  );

  // Stage 3: re-running is a no-op, and the ledger checksums still verify.
  expect(await runMigrations(pool)).toEqual([]);
  expect((await appliedMigrations(pool)).map((m) => m.name)).toEqual(files);
});
