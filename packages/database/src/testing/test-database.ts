import { randomBytes } from 'node:crypto';
import { Client, Pool } from 'pg';
import { createDatabase, type DatabaseHandle } from '../client';
import { runMigrations } from '../migrator';

/**
 * Admin connection used only to CREATE/DROP test databases. Points at the maintenance
 * database, never at a test database.
 */
function adminUrl(): string {
  const url = process.env['TEST_DATABASE_ADMIN_URL'];
  if (!url) {
    throw new Error(
      'TEST_DATABASE_ADMIN_URL is not set. Integration tests need a real PostgreSQL ' +
        '(pnpm db:up). They are not mocked on purpose: the isolation guarantees under test ' +
        'are database constraints, which a mock cannot enforce.',
    );
  }
  return url;
}

function urlForDatabase(base: string, database: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface TestDatabase extends DatabaseHandle {
  name: string;
  /** Truncates all application tables, preserving schema and the migration ledger. */
  truncateAll: () => Promise<void>;
}

/**
 * Creates a uniquely named database, applies every migration, and returns a handle.
 *
 * One database per test file rather than one shared database with transaction rollback:
 * the features under test use explicit transactions themselves, and nesting those inside a
 * wrapping rollback transaction would change their behaviour — savepoint semantics differ
 * from real commits, which is exactly what attendance submission depends on.
 */
export async function createTestDatabase(label = 'test'): Promise<TestDatabase> {
  const base = adminUrl();
  const safeLabel = label.replace(/[^a-z0-9_]/gi, '_').slice(0, 24).toLowerCase();
  // The creation time is encoded in the name because PostgreSQL does not record when a
  // database was created, and the reaper needs to tell a stale database from a live one.
  const stamp = Date.now().toString(36);
  const name = `ss_test_${safeLabel}_${stamp}_${randomBytes(6).toString('hex')}`;

  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    await reapStaleDatabases(admin);
    // The identifier is built from a sanitized label, a base-36 timestamp and a hex suffix,
    // so it cannot contain a quote; quoting keeps it valid regardless of case.
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const handle = createDatabase(urlForDatabase(base, name), { max: 4 });
  await runMigrations(handle.pool);

  return {
    ...handle,
    name,
    truncateAll: () => truncateAll(handle.pool),
    close: async () => {
      await handle.close();
      await dropDatabase(base, name);
    },
  };
}

/** A test database older than this is assumed to be debris from a crashed run. */
export const STALE_DATABASE_AGE_MS = 60 * 60 * 1000;

const TEST_DB_NAME = /^ss_test_[a-z0-9_]+_([0-9a-z]+)_[0-9a-f]{12}$/;

/**
 * Drops test databases left behind by a run that died before its teardown — a crash, a
 * cancelled CI job, or Ctrl-C. Without this, debris accumulates until the server hits
 * max_connections or the disk fills.
 *
 * Age is read from the timestamp in the name, so a concurrently running suite's fresh
 * databases are never touched. Failures are swallowed: reaping is opportunistic
 * housekeeping and must never fail the test that triggered it.
 */
export async function reapStaleDatabases(
  admin: Client,
  maxAgeMs: number = STALE_DATABASE_AGE_MS,
): Promise<string[]> {
  const dropped: string[] = [];
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'ss\\_test\\_%'",
    );

    const cutoff = Date.now() - maxAgeMs;
    for (const { datname } of rows) {
      const match = TEST_DB_NAME.exec(datname);
      if (!match?.[1]) continue;

      const createdAt = Number.parseInt(match[1], 36);
      if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;

      try {
        await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
        dropped.push(datname);
      } catch {
        // Another runner may be reaping the same database, or it may still have sessions.
      }
    }
  } catch {
    // Reaping is best-effort.
  }
  return dropped;
}

async function truncateAll(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.table_name}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

async function dropDatabase(base: string, name: string): Promise<void> {
  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    // Lingering connections would make DROP fail and leak the database across CI runs.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}
