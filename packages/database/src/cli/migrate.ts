#!/usr/bin/env node
import { Pool } from 'pg';
import { runMigrations, appliedMigrations } from '../migrator';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const applied = await runMigrations(pool, { logger: (m) => console.log(`  ${m}`) });
    if (applied.length === 0) {
      console.log('No pending migrations.');
    } else {
      console.log(`Applied ${applied.length} migration(s).`);
    }
    const all = await appliedMigrations(pool);
    console.log(`Schema is at ${all.length} migration(s).`);
  } catch (err) {
    console.error(`Migration failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void main();
