import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrations, appliedMigrations } from './migrator';
import { createTestDatabase, type TestDatabase } from './testing/test-database';

let database: TestDatabase;
let dir: string;

beforeAll(async () => {
  database = await createTestDatabase('migrator');
}, 30_000);

afterAll(async () => {
  await database?.close();
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ss-mig-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await database.pool.query('DROP TABLE IF EXISTS widgets');
  await database.pool.query('DELETE FROM schema_migrations');
});

test('applies pending migrations in filename order', async () => {
  await writeFile(path.join(dir, '0001_widgets.sql'), 'CREATE TABLE widgets (id int PRIMARY KEY);');
  await writeFile(path.join(dir, '0002_label.sql'), 'ALTER TABLE widgets ADD COLUMN label text;');

  const applied = await runMigrations(database.pool, { dir });

  expect(applied).toEqual(['0001_widgets.sql', '0002_label.sql']);

  const { rows } = await database.pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'widgets' ORDER BY column_name`,
  );
  expect(rows.map((r) => r.column_name)).toEqual(['id', 'label']);
});

test('is idempotent — a second run applies nothing', async () => {
  await writeFile(path.join(dir, '0001_widgets.sql'), 'CREATE TABLE widgets (id int PRIMARY KEY);');

  expect(await runMigrations(database.pool, { dir })).toHaveLength(1);
  expect(await runMigrations(database.pool, { dir })).toEqual([]);
  expect(await appliedMigrations(database.pool)).toHaveLength(1);
});

test('rejects a migration edited after it was applied', async () => {
  const file = path.join(dir, '0001_widgets.sql');
  await writeFile(file, 'CREATE TABLE widgets (id int PRIMARY KEY);');
  await runMigrations(database.pool, { dir });

  await writeFile(file, 'CREATE TABLE widgets (id int PRIMARY KEY, sneaky text);');

  await expect(runMigrations(database.pool, { dir })).rejects.toThrow(
    /was modified after it was applied/,
  );
});

test('a failing migration leaves no partial state and no ledger row', async () => {
  await writeFile(path.join(dir, '0001_widgets.sql'), 'CREATE TABLE widgets (id int PRIMARY KEY);');
  await writeFile(
    path.join(dir, '0002_bad.sql'),
    'ALTER TABLE widgets ADD COLUMN ok text; ALTER TABLE widgets ADD COLUMN ok text;',
  );

  await expect(runMigrations(database.pool, { dir })).rejects.toThrow(/0002_bad\.sql failed/);

  // 0001 committed and stays; 0002 rolled back entirely, including its column.
  expect((await appliedMigrations(database.pool)).map((m) => m.name)).toEqual(['0001_widgets.sql']);
  const { rows } = await database.pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'widgets' AND column_name = 'ok'`,
  );
  expect(rows).toHaveLength(0);
});

test('concurrent runners do not double-apply', async () => {
  await writeFile(path.join(dir, '0001_widgets.sql'), 'CREATE TABLE widgets (id int PRIMARY KEY);');

  const results = await Promise.all([
    runMigrations(database.pool, { dir }),
    runMigrations(database.pool, { dir }),
    runMigrations(database.pool, { dir }),
  ]);

  // Exactly one runner applies it; the advisory lock makes the others no-ops.
  expect(results.flat()).toEqual(['0001_widgets.sql']);
  expect(await appliedMigrations(database.pool)).toHaveLength(1);
});
