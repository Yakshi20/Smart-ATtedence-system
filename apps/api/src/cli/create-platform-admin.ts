#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createDatabase } from '@smart-school/database';
import { ZodError } from 'zod';
import { bootstrapPlatformAdmin } from '../identity/platform-admin';

/**
 * Operator tool: creates (or promotes) a platform administrator.
 *
 *   PLATFORM_ADMIN_PASSWORD='…' pnpm --filter @smart-school/api platform-admin:create \
 *     --email ops@example.org --name "Ops Person"
 *
 * The password comes from the environment, never argv, because arguments are visible to
 * every user on the host via `ps`. Use `read -rs PLATFORM_ADMIN_PASSWORD` to avoid shell
 * history too.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
    strict: true,
  });

  const url = process.env['DATABASE_URL'];
  const password = process.env['PLATFORM_ADMIN_PASSWORD'];
  if (!url || !values.email || !values.name || !password) {
    console.error(
      'Usage: PLATFORM_ADMIN_PASSWORD=… DATABASE_URL=… create-platform-admin --email <email> --name <display name>',
    );
    process.exit(2);
  }

  const handle = createDatabase(url, { max: 1 });
  try {
    const result = await bootstrapPlatformAdmin(handle.db, {
      email: values.email,
      displayName: values.name,
      password,
    });
    console.log(
      `platform_admin granted to user ${result.userId}` +
        (result.passwordSet ? ' (password set)' : ' (existing password kept)'),
    );
  } catch (err) {
    if (err instanceof ZodError) {
      console.error(`Invalid input:\n${err.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
      process.exit(2);
    }
    console.error(`Failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await handle.close();
  }
}

void main();
