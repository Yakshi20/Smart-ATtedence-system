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
  onboardSchool,
  registrationPayload,
  submitRegistration,
} from '../testing/identity-fixtures';

let t: TestApp;
const notifier = new CapturingNotifier();
let platform: IssuedTokens;

beforeAll(async () => {
  t = await createTestApp('registration', {
    accountNotifier: notifier,
    rateLimitRules: GENEROUS_RATE_LIMITS,
  });
  platform = await createPlatformAdmin(t);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const REGISTER = '/api/v1/schools/registration-requests';
const REVIEW = '/api/v1/platform/school-registration-requests';

describe('public registration', () => {
  test('is reachable without authentication and stays pending', async () => {
    const before = {
      schools: await count(t, 'schools'),
      users: await count(t, 'users'),
      memberships: await count(t, 'school_memberships'),
    };

    const payload = registrationPayload();
    const res = await http(t).post(REGISTER).send(payload);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'pending_review' });

    const { rows } = await t.database.pool.query(
      `SELECT status, reviewed_by, school_id, contact_email, contact_phone
       FROM school_registration_requests WHERE contact_email = $1`,
      [String(payload['contactEmail'])],
    );
    expect(rows).toEqual([
      {
        status: 'pending',
        reviewed_by: null,
        school_id: null,
        contact_email: payload['contactEmail'],
        contact_phone: '+919845012345',
      },
    ]);

    // D-18: nothing outside the quarantine table is created by a public request.
    expect(await count(t, 'schools')).toBe(before.schools);
    expect(await count(t, 'users')).toBe(before.users);
    expect(await count(t, 'school_memberships')).toBe(before.memberships);
    expect(await count(t, 'audit_logs', `action = 'school_registration.submitted'`)).toBeGreaterThan(0);
  });

  test('cannot self-approve or grant itself a role by adding fields', async () => {
    const platformMembers = await count(t, 'platform_memberships');
    const schoolsBefore = await count(t, 'schools');
    const payload = registrationPayload({
      status: 'approved',
      role: 'platform_admin',
      schoolId: randomUUID(),
      reviewedBy: randomUUID(),
      isPlatformAdmin: true,
    });

    const res = await http(t).post(REGISTER).send(payload);
    expect(res.status).toBe(202);

    const { rows } = await t.database.pool.query(
      `SELECT status, reviewed_by, school_id FROM school_registration_requests WHERE contact_email = $1`,
      [payload['contactEmail']],
    );
    expect(rows).toEqual([{ status: 'pending', reviewed_by: null, school_id: null }]);
    expect(await count(t, 'platform_memberships')).toBe(platformMembers);
    expect(await count(t, 'schools')).toBe(schoolsBefore);
  });

  test('invalid input is rejected with field paths and writes nothing', async () => {
    const before = await count(t, 'school_registration_requests');
    const res = await http(t)
      .post(REGISTER)
      .send(registrationPayload({ pincode: 'abc', contactEmail: 'nope', sector: 'other' }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields.map((f: { path: string }) => f.path).sort()).toEqual([
      'contactEmail',
      'pincode',
      'sector',
    ]);
    expect(await count(t, 'school_registration_requests')).toBe(before);
  });

  test('a duplicate submission gets the identical response', async () => {
    const payload = registrationPayload();
    const first = await http(t).post(REGISTER).send(payload);
    const second = await http(t).post(REGISTER).send(payload);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
  });
});

describe('approval boundary', () => {
  test('anonymous callers cannot reach the review endpoints', async () => {
    const { requestId } = await submitRegistration(t);
    await http(t).get(REVIEW).expect(401);
    await http(t).post(`${REVIEW}/${requestId}/approve`).send({}).expect(401);
  });

  test('a school admin or teacher cannot list, read, approve or reject', async () => {
    const school = await onboardSchool(t, notifier, platform);
    const teacher = await inviteAndActivate(t, notifier, school.admin, school.schoolId, {
      email: `teacher.${Date.now()}@school.test`,
      role: 'teacher',
    });
    const { requestId } = await submitRegistration(t);

    for (const caller of [school.admin, teacher]) {
      await http(t).get(REVIEW).set(bearer(caller)).expect(403);
      await http(t).get(`${REVIEW}/${requestId}`).set(bearer(caller)).expect(403);
      await http(t).post(`${REVIEW}/${requestId}/approve`).set(bearer(caller)).send({}).expect(403);
      await http(t)
        .post(`${REVIEW}/${requestId}/reject`)
        .set(bearer(caller))
        .send({ reason: 'no' })
        .expect(403);
    }

    const { rows } = await t.database.pool.query(
      `SELECT status FROM school_registration_requests WHERE id = $1`,
      [requestId],
    );
    expect(rows[0].status).toBe('pending');
  });

  test('a non-platform caller gets the same 403 for existing and non-existent requests', async () => {
    const school = await onboardSchool(t, notifier, platform);
    const { requestId } = await submitRegistration(t);

    const existing = await http(t).post(`${REVIEW}/${requestId}/approve`).set(bearer(school.admin)).send({});
    const missing = await http(t).post(`${REVIEW}/${randomUUID()}/approve`).set(bearer(school.admin)).send({});

    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(existing.body.error.code).toBe(missing.body.error.code);
    expect(existing.body.error.message).toBe(missing.body.error.message);
  });

  test('platform admin lists pending requests in submission order', async () => {
    const a = await submitRegistration(t);
    const b = await submitRegistration(t);

    const res = await http(t).get(REVIEW).query({ status: 'pending', limit: 100 }).set(bearer(platform));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids.indexOf(a.requestId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(a.requestId)).toBeLessThan(ids.indexOf(b.requestId));
    expect(res.body.items.every((i: { status: string }) => i.status === 'pending')).toBe(true);
  });

  test('approval creates school, unique code, admin membership and audit, in one step', async () => {
    const { requestId, contactEmail } = await submitRegistration(t);

    const res = await http(t).post(`${REVIEW}/${requestId}/approve`).set(bearer(platform)).send({ note: 'UDISE verified' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.school.schoolCode).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(res.body.school.status).toBe('active');

    // The activation token goes to the contact only, never to the approving reviewer.
    const token = notifier.tokenFor(contactEmail);
    expect(JSON.stringify(res.body)).not.toContain(token);

    const schoolId = res.body.school.id;
    const { rows: memberships } = await t.database.pool.query(
      `SELECT m.role, m.status, u.email FROM school_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.school_id = $1`,
      [schoolId],
    );
    expect(memberships).toEqual([{ role: 'school_admin', status: 'active', email: contactEmail }]);

    const { rows: requestRows } = await t.database.pool.query(
      `SELECT status, school_id, reviewed_by IS NOT NULL AS reviewed, review_note
       FROM school_registration_requests WHERE id = $1`,
      [requestId],
    );
    expect(requestRows[0]).toEqual({ status: 'approved', school_id: schoolId, reviewed: true, review_note: 'UDISE verified' });

    expect(
      await count(t, 'audit_logs', `action = 'school_registration.approved' AND entity_id = $1`, [requestId]),
    ).toBe(1);

    // The new admin has no password until activation.
    expect(await count(t, 'auth_identities a JOIN users u ON u.id = a.user_id', 'u.email = $1', [contactEmail])).toBe(0);
  });

  test('a decided request cannot be decided again', async () => {
    const { requestId } = await submitRegistration(t);
    await http(t).post(`${REVIEW}/${requestId}/approve`).set(bearer(platform)).send({}).expect(200);

    const again = await http(t).post(`${REVIEW}/${requestId}/approve`).set(bearer(platform)).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('STATE_CONFLICT');

    await http(t).post(`${REVIEW}/${requestId}/reject`).set(bearer(platform)).send({ reason: 'x' }).expect(409);
  });

  test('concurrent approvals of one request create exactly one school', async () => {
    const { requestId } = await submitRegistration(t);
    const schoolsBefore = await count(t, 'schools');

    const results = await Promise.all(
      [1, 2, 3].map(() => http(t).post(`${REVIEW}/${requestId}/approve`).set(bearer(platform)).send({})),
    );

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await count(t, 'schools')).toBe(schoolsBefore + 1);
  });

  test('rejection requires a reason and creates no school', async () => {
    const { requestId } = await submitRegistration(t);
    const schoolsBefore = await count(t, 'schools');

    await http(t).post(`${REVIEW}/${requestId}/reject`).set(bearer(platform)).send({}).expect(400);

    const res = await http(t)
      .post(`${REVIEW}/${requestId}/reject`)
      .set(bearer(platform))
      .send({ reason: 'Could not verify UDISE code' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrationRequestId: requestId, status: 'rejected' });
    expect(await count(t, 'schools')).toBe(schoolsBefore);
  });

  test('approving an unknown request is 404 for a platform admin', async () => {
    const res = await http(t).post(`${REVIEW}/${randomUUID()}/approve`).set(bearer(platform)).send({});
    expect(res.status).toBe(404);
  });

  test('school codes are unique across many approvals', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const { requestId } = await submitRegistration(t);
      const res = await http(t).post(`${REVIEW}/${requestId}/approve`).set(bearer(platform)).send({});
      codes.add(res.body.school.schoolCode);
    }
    expect(codes.size).toBe(12);
    const { rows } = await t.database.pool.query(
      `SELECT count(*)::int AS n, count(DISTINCT school_code)::int AS d FROM schools`,
    );
    expect(rows[0].n).toBe(rows[0].d);
  });

  test('a second school with the same UDISE code is refused at approval', async () => {
    const udiseCode = '29' + String(Date.now()).slice(-9);
    const first = await submitRegistration(t, { udiseCode });
    const second = await submitRegistration(t, { udiseCode });

    await http(t).post(`${REVIEW}/${first.requestId}/approve`).set(bearer(platform)).send({}).expect(200);
    const res = await http(t).post(`${REVIEW}/${second.requestId}/approve`).set(bearer(platform)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');

    // The failed approval rolled back entirely.
    const { rows } = await t.database.pool.query(
      `SELECT status FROM school_registration_requests WHERE id = $1`,
      [second.requestId],
    );
    expect(rows[0].status).toBe('pending');
  });

  test('an existing activated user as contact joins without a new activation token', async () => {
    const first = await onboardSchool(t, notifier, platform);
    const sentBefore = notifier.countFor(first.adminEmail);

    const second = await onboardSchool(t, notifier, platform, { contactEmail: first.adminEmail });

    expect(notifier.countFor(first.adminEmail)).toBe(sentBefore);
    const mine = await http(t).get('/api/v1/me/schools').set(bearer(second.admin));
    expect(mine.body.items.map((s: { schoolId: string }) => s.schoolId).sort()).toEqual(
      [first.schoolId, second.schoolId].sort(),
    );
  });
});

describe('platform admin has no academic access (Q2)', () => {
  test('approving a school does not let the platform admin read it', async () => {
    const school = await onboardSchool(t, notifier, platform);

    const profile = await http(t).get(`/api/v1/schools/${school.schoolId}`).set(bearer(platform));
    const staff = await http(t).get(`/api/v1/schools/${school.schoolId}/staff`).set(bearer(platform));
    const invite = await http(t)
      .post(`/api/v1/schools/${school.schoolId}/staff`)
      .set(bearer(platform))
      .send({ email: 'x@y.test', displayName: 'X', role: 'teacher' });

    expect([profile.status, staff.status, invite.status]).toEqual([404, 404, 404]);

    const me = await http(t).get('/api/v1/me/schools').set(bearer(platform));
    expect(me.body.items).toEqual([]);
  });
});
