import { createTestApp, type TestApp } from '../testing/app-harness';
import { bearer, count, http, login, PASSWORD } from '../testing/identity-fixtures';
import { bootstrapPlatformAdmin } from './platform-admin';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp('platformadmin');
}, 60_000);

afterAll(async () => {
  await t?.close();
});

test('creates a user with a password and the platform_admin role', async () => {
  const result = await bootstrapPlatformAdmin(t.database.db, {
    email: ' Ops@Platform.test ',
    displayName: 'Ops',
    password: PASSWORD,
  });
  expect(result.passwordSet).toBe(true);

  const tokens = await login(t, 'ops@platform.test');
  const me = await http(t).get('/api/v1/me').set(bearer(tokens));
  expect(me.body.platform).toEqual({
    roles: ['platform_admin'],
    permissions: ['platform.school_registrations.review'],
  });
  expect(await count(t, 'audit_logs', `action = 'platform_membership.granted'`)).toBe(1);
});

test('re-running is idempotent and never replaces an existing password', async () => {
  const result = await bootstrapPlatformAdmin(t.database.db, {
    email: 'ops@platform.test',
    displayName: 'Ops',
    password: 'a completely different passphrase',
  });
  expect(result.passwordSet).toBe(false);
  expect(await count(t, 'platform_memberships')).toBe(1);

  await login(t, 'ops@platform.test', PASSWORD);
});

test('rejects a weak password before touching the database', async () => {
  const users = await count(t, 'users');
  await expect(
    bootstrapPlatformAdmin(t.database.db, { email: 'weak@platform.test', displayName: 'Weak', password: 'short' }),
  ).rejects.toThrow();
  expect(await count(t, 'users')).toBe(users);
});
