import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Pool } from 'pg';

export const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: Date;
}

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  // Lexicographic order is the apply order, so filenames must be zero-padded.
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Applies pending migrations in filename order.
 *
 * Each migration runs inside its own transaction together with its ledger insert, so a
 * failure can never leave a migration half-applied but recorded. An advisory lock
 * serializes concurrent runners (parallel CI jobs, or two API instances booting at once).
 *
 * Already-applied migrations are verified against their recorded checksum: editing a
 * migration that has shipped is a mistake we want to fail loudly, not absorb silently.
 */
export async function runMigrations(
  pool: Pool,
  options: { dir?: string; logger?: (msg: string) => void } = {},
): Promise<string[]> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.logger ?? (() => {});

  const lockClient = await pool.connect();
  const applied: string[] = [];

  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await lockClient.query(LEDGER_DDL);

    const { rows } = await lockClient.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const recorded = new Map(rows.map((r) => [r.name, r.checksum]));
    const files = await listMigrationFiles(dir);

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = checksumOf(sql);
      const previous = recorded.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} was modified after it was applied ` +
              `(recorded ${previous.slice(0, 12)}, found ${checksum.slice(0, 12)}). ` +
              'Add a new migration instead of editing an applied one.',
          );
        }
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
        applied.push(file);
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      } finally {
        client.release();
      }
    }

    return applied;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

/** Arbitrary but fixed: every runner must use the same key for the lock to mean anything. */
const MIGRATION_LOCK_KEY = 4_812_003_771;

export async function appliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  const { rows } = await pool.query<{ name: string; checksum: string; applied_at: Date }>(
    'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
  );
  return rows.map((r) => ({ name: r.name, checksum: r.checksum, appliedAt: r.applied_at }));
}
