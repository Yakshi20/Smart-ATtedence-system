import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
}

/**
 * Creates a pooled connection. Callers own the handle and must close it; nothing here
 * registers process-level shutdown hooks, so tests can open and close freely.
 */
export function createDatabase(connectionString: string, overrides: PoolConfig = {}): DatabaseHandle {
  const pool = new Pool({
    connectionString,
    // Fail fast rather than hanging a request behind an exhausted pool.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    ...overrides,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
