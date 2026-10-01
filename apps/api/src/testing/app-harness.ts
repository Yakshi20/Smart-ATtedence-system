import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '@smart-school/database';
import type { AppOverrides } from '../app.module';
import { createApp } from '../bootstrap';
import { loadConfig, type AppConfig } from '../config/env';

export interface TestApp {
  app: INestApplication;
  database: TestDatabase;
  config: AppConfig;
  close: () => Promise<void>;
}

/**
 * Boots the real application against a freshly migrated, isolated database.
 *
 * Uses `createApp`, not a hand-assembled module, so the filter/pipe/middleware stack under
 * test is the one production uses.
 */
export async function createTestApp(label: string, overrides: AppOverrides = {}): Promise<TestApp> {
  const database = await createTestDatabase(label);

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: databaseUrlFor(database.name),
    JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-to-pass-validation',
  });

  const app = await createApp(config, overrides);
  await app.init();

  return {
    app,
    database,
    config,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

function databaseUrlFor(name: string): string {
  const base = process.env['TEST_DATABASE_ADMIN_URL'];
  if (!base) throw new Error('TEST_DATABASE_ADMIN_URL is not set');
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}
