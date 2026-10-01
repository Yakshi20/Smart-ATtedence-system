import { createTestApp, type TestApp } from '../testing/app-harness';
import {
  CapturingNotifier,
  createPlatformAdmin,
  GENEROUS_RATE_LIMITS,
  http,
  onboardSchool,
  PASSWORD,
  registrationPayload,
  withoutRequestId,
  type OnboardedSchool,
} from '../testing/identity-fixtures';

/**
 * Rate limits through the real HTTP stack, with low limits so the tests stay fast. The
 * limiter's window arithmetic is unit-tested in rate-limiter.test.ts.
 */
let t: TestApp;
const notifier = new CapturingNotifier();
let school: OnboardedSchool;

const WINDOW = { windowMs: 60_000 };

beforeAll(async () => {
  t = await createTestApp('ratelimit', {
    accountNotifier: notifier,
    rateLimitRules: {
      ...GENEROUS_RATE_LIMITS,
      registrationPerIp: { limit: 1_000, ...WINDOW },
      registrationPerEmail: { limit: 2, ...WINDOW },
      loginFailuresPerIdentifier: { limit: 3, ...WINDOW },
    },
  });
  const platform = await createPlatformAdmin(t);
  school = await onboardSchool(t, notifier, platform);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

test('registration is limited per contact email, with Retry-After', async () => {
  const payload = registrationPayload({ contactEmail: 'spam@school.test' });
  await http(t).post('/api/v1/schools/registration-requests').send(payload).expect(202);
  await http(t).post('/api/v1/schools/registration-requests').send(payload).expect(202);

  // Case variation does not open a new bucket: the email is normalized before the limiter.
  const res = await http(t)
    .post('/api/v1/schools/registration-requests')
    .send({ ...payload, contactEmail: 'SPAM@School.test' });

  expect(res.status).toBe(429);
  expect(res.body.error.code).toBe('RATE_LIMITED');
  expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
});

test('repeated failed logins lock the identifier, even for the right password', async () => {
  const attempt = (password: string) =>
    http(t).post('/api/v1/auth/login').send({ method: 'staff_password', email: school.adminEmail, password });

  for (let i = 0; i < 3; i += 1) await attempt('wrong password!').expect(401);

  const locked = await attempt(PASSWORD);
  expect(locked.status).toBe(429);
});

test('the lockout response is the same for an unknown email, so it reveals no account', async () => {
  const attempt = (email: string) =>
    http(t).post('/api/v1/auth/login').send({ method: 'staff_password', email, password: 'wrong password!' });

  for (let i = 0; i < 3; i += 1) await attempt('ghost@nowhere.test').expect(401);
  const ghost = await attempt('ghost@nowhere.test');
  const real = await attempt(school.adminEmail);

  expect(ghost.status).toBe(429);
  expect(real.status).toBe(429);
  expect(withoutRequestId(ghost.body)).toEqual(withoutRequestId(real.body));
});
