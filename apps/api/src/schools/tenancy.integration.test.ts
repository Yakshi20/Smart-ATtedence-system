import { randomUUID } from 'node:crypto';
import type { IssuedTokens } from '../auth/session.service';
import { createTestApp, type TestApp } from '../testing/app-harness';
import {
  bearer,
  CapturingNotifier,
  count,
  createPlatformAdmin,
  GENEROUS_RATE_LIMITS,
  http,
  inviteAndActivate,
  login,
  onboardSchool,
  withoutRequestId,
  type OnboardedSchool,
} from '../testing/identity-fixtures';

/**
 * Cross-school isolation (02 §4, 07 §2 "Principal attempts access to another school").
 *
 * Fixture: two approved schools A and B, each with an activated admin, plus a teacher in A.
 */
let t: TestApp;
const notifier = new CapturingNotifier();
let platform: IssuedTokens;
let a: OnboardedSchool;
let b: OnboardedSchool;
let teacherA: IssuedTokens;
let teacherAEmail: string;

beforeAll(async () => {
  t = await createTestApp('tenancy', { accountNotifier: notifier, rateLimitRules: GENEROUS_RATE_LIMITS });
  platform = await createPlatformAdmin(t);
  a = await onboardSchool(t, notifier, platform, { schoolName: 'School A' });
  b = await onboardSchool(t, notifier, platform, { schoolName: 'School B' });
  teacherAEmail = `teacher.a.${Date.now()}@school.test`;
  teacherA = await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: teacherAEmail, role: 'teacher' });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const school = (id: string) => `/api/v1/schools/${id}`;
const staff = (id: string) => `/api/v1/schools/${id}/staff`;

describe('an admin of school A', () => {
  test('can read its own school', async () => {
    const res = await http(t).get(school(a.schoolId)).set(bearer(a.admin));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: a.schoolId, schoolCode: a.schoolCode, name: 'School A' });
  });

  test('gets 404 for school B — indistinguishable from a school that does not exist', async () => {
    const other = await http(t).get(school(b.schoolId)).set(bearer(a.admin));
    const missing = await http(t).get(school(randomUUID())).set(bearer(a.admin));

    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(withoutRequestId(other.body)).toEqual(withoutRequestId(missing.body));
    expect(JSON.stringify(other.body)).not.toContain('School B');
  });

  test("cannot list school B's staff", async () => {
    const res = await http(t).get(staff(b.schoolId)).set(bearer(a.admin));
    expect(res.status).toBe(404);
  });

  test('cannot add staff to school B', async () => {
    const before = await count(t, 'school_memberships', 'school_id = $1', [b.schoolId]);
    const res = await http(t)
      .post(staff(b.schoolId))
      .set(bearer(a.admin))
      .send({ email: `intruder.${Date.now()}@school.test`, displayName: 'Intruder', role: 'school_admin' });

    expect(res.status).toBe(404);
    expect(await count(t, 'school_memberships', 'school_id = $1', [b.schoolId])).toBe(before);
  });

  test('sees only its own school in /me/schools', async () => {
    const res = await http(t).get('/api/v1/me/schools').set(bearer(a.admin));
    expect(res.body.items.map((s: { schoolId: string }) => s.schoolId)).toEqual([a.schoolId]);
  });

  test("school A's staff list contains no one from school B", async () => {
    const res = await http(t).get(staff(a.schoolId)).set(bearer(a.admin));
    expect(res.status).toBe(200);
    const emails = res.body.items.map((m: { email: string }) => m.email).sort();
    expect(emails).toEqual([a.adminEmail, teacherAEmail].sort());
    expect(emails).not.toContain(b.adminEmail);
  });

  test('a schoolId smuggled in the body is ignored; the path membership decides', async () => {
    const email = `smuggled.${Date.now()}@school.test`;
    const res = await http(t)
      .post(staff(a.schoolId))
      .set(bearer(a.admin))
      .send({ email, displayName: 'Smuggled', role: 'teacher', schoolId: b.schoolId });

    expect(res.status).toBe(201);
    const { rows } = await t.database.pool.query(
      `SELECT m.school_id FROM school_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );
    expect(rows).toEqual([{ school_id: a.schoolId }]);
  });
});

describe('role permissions within a school', () => {
  test('a teacher can read the school profile', async () => {
    await http(t).get(school(a.schoolId)).set(bearer(teacherA)).expect(200);
  });

  test('a teacher gets 403 (not 404) for staff management — the school is visible, the action is not', async () => {
    const list = await http(t).get(staff(a.schoolId)).set(bearer(teacherA));
    const invite = await http(t)
      .post(staff(a.schoolId))
      .set(bearer(teacherA))
      .send({ email: `x.${Date.now()}@school.test`, displayName: 'X', role: 'teacher' });

    expect(list.status).toBe(403);
    expect(invite.status).toBe(403);
    expect(list.body.error.code).toBe('PERMISSION_DENIED');
  });

  test("a teacher of A gets 404 for school B", async () => {
    await http(t).get(school(b.schoolId)).set(bearer(teacherA)).expect(404);
  });

  test('a teacher cannot review school registrations', async () => {
    await http(t).get('/api/v1/platform/school-registration-requests').set(bearer(teacherA)).expect(403);
  });

  test('an admin cannot assign a platform role through staff invitation', async () => {
    const res = await http(t)
      .post(staff(a.schoolId))
      .set(bearer(a.admin))
      .send({ email: `esc.${Date.now()}@school.test`, displayName: 'Esc', role: 'platform_admin' });
    expect(res.status).toBe(400);
    expect(await count(t, 'platform_memberships')).toBe(1);
  });
});

describe('membership and school state are re-checked on every request', () => {
  test('revoking a membership blocks the very next request with the same token', async () => {
    const email = `revoked.${Date.now()}@school.test`;
    const tokens = await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email, role: 'teacher' });
    await http(t).get(school(a.schoolId)).set(bearer(tokens)).expect(200);

    await t.database.pool.query(
      `UPDATE school_memberships SET status = 'revoked'
       WHERE school_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)`,
      [a.schoolId, email],
    );

    await http(t).get(school(a.schoolId)).set(bearer(tokens)).expect(404);
  });

  test('a suspended school is unusable by its own admin', async () => {
    const c = await onboardSchool(t, notifier, platform, { schoolName: 'School C' });
    await http(t).get(school(c.schoolId)).set(bearer(c.admin)).expect(200);

    await t.database.pool.query(`UPDATE schools SET status = 'suspended' WHERE id = $1`, [c.schoolId]);

    await http(t).get(school(c.schoolId)).set(bearer(c.admin)).expect(404);
    await http(t).get(staff(c.schoolId)).set(bearer(c.admin)).expect(404);
    const mine = await http(t).get('/api/v1/me/schools').set(bearer(c.admin));
    expect(mine.body.items).toEqual([
      expect.objectContaining({ schoolId: c.schoolId, schoolStatus: 'suspended', permissions: [] }),
    ]);
  });

  test('a registration that was never approved yields no school and no access', async () => {
    // Public submission creates no user, so there is no one who could even log in.
    const email = `pending.${Date.now()}@school.test`;
    await http(t)
      .post('/api/v1/schools/registration-requests')
      .send({
        schoolName: 'Pending School',
        sector: 'private',
        districtName: 'Udupi',
        addressLine: 'Car Street',
        pincode: '576101',
        contactName: 'Pending Head',
        contactEmail: email,
        contactPhone: '9876543210',
      })
      .expect(202);

    expect(await count(t, 'schools', `name = 'Pending School'`)).toBe(0);
    expect(await count(t, 'users', 'email = $1', [email])).toBe(0);
    await expect(login(t, email)).rejects.toThrow(/login .* failed: 401/);
  });
});

describe('staff invitation', () => {
  test("inviting someone who already has an account elsewhere reveals nothing about them", async () => {
    const fresh = await http(t)
      .post(staff(a.schoolId))
      .set(bearer(a.admin))
      .send({ email: `fresh.${Date.now()}@school.test`, displayName: 'Fresh', role: 'teacher' });
    const existing = await http(t)
      .post(staff(a.schoolId))
      .set(bearer(a.admin))
      .send({ email: b.adminEmail, displayName: 'Renamed By A', role: 'teacher' });

    expect(fresh.status).toBe(201);
    expect(existing.status).toBe(201);
    expect(Object.keys(existing.body).sort()).toEqual(Object.keys(fresh.body).sort());

    // School A cannot rename a person known to school B.
    const { rows } = await t.database.pool.query(`SELECT display_name FROM users WHERE email = $1`, [
      b.adminEmail,
    ]);
    expect(rows[0].display_name).not.toBe('Renamed By A');
  });

  test('membership in A grants the B admin nothing extra in B, and nothing in A beyond its role', async () => {
    // b.admin was added to A as a teacher in the previous test.
    const tokens = await login(t, b.adminEmail);
    await http(t).get(school(a.schoolId)).set(bearer(tokens)).expect(200);
    await http(t).get(staff(a.schoolId)).set(bearer(tokens)).expect(403);
    await http(t).get(staff(b.schoolId)).set(bearer(tokens)).expect(200);
  });

  test('a duplicate membership is a 409 within your own school', async () => {
    const res = await http(t)
      .post(staff(a.schoolId))
      .set(bearer(a.admin))
      .send({ email: teacherAEmail, displayName: 'Again', role: 'teacher' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
  });

  test('a malformed school id is a 400, before any lookup', async () => {
    await http(t).get(school('not-a-uuid')).set(bearer(a.admin)).expect(400);
  });
});
