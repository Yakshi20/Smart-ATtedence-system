import { randomUUID } from 'node:crypto';
import type { IssuedTokens } from '../auth/session.service';
import { createTestApp, type TestApp } from '../testing/app-harness';
import { api, createStudent, enrol, standardStructure, type SchoolApi } from '../testing/academic-fixtures';
import { newPhone, otpLogin, TestSms } from '../testing/guardian-fixtures';
import {
  bearer,
  CapturingNotifier,
  count,
  createPlatformAdmin,
  GENEROUS_RATE_LIMITS,
  http,
  inviteAndActivate,
  onboardSchool,
  withoutRequestId,
  type OnboardedSchool,
} from '../testing/identity-fixtures';

/**
 * Guardian linking end to end (08 §4, 07 §2 "Parent changes a student ID", "Revoked guardian
 * retains access through a stale session").
 */
let t: TestApp;
const notifier = new CapturingNotifier();
const sms = new TestSms();
let platform: IssuedTokens;
let a: OnboardedSchool;
let b: OnboardedSchool;
let adminA: SchoolApi;
let adminB: SchoolApi;
let teacherA: SchoolApi;
let sA: Awaited<ReturnType<typeof standardStructure>>;
let kid1: { id: string; studentNumber: string };
let kid2: { id: string; studentNumber: string };
let kidB: { id: string; studentNumber: string };

beforeAll(async () => {
  t = await createTestApp('guardians', { accountNotifier: notifier, smsProvider: sms, rateLimitRules: GENEROUS_RATE_LIMITS });
  platform = await createPlatformAdmin(t);
  a = await onboardSchool(t, notifier, platform, { schoolName: 'School A' });
  b = await onboardSchool(t, notifier, platform, { schoolName: 'School B' });
  adminA = api(t, a.admin, a.schoolId);
  adminB = api(t, b.admin, b.schoolId);
  teacherA = api(
    t,
    await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: `t.${Date.now()}@school.test`, role: 'teacher' }),
    a.schoolId,
  );
  sA = await standardStructure(adminA);
  kid1 = await createStudent(adminA, { fullName: 'Kavya' });
  kid2 = await createStudent(adminA, { fullName: 'Kiran' });
  kidB = await createStudent(adminB, { fullName: 'Bhavana' });
  await enrol(adminA, sA.yearId, kid1.id, sA.s5a);
  await enrol(adminA, sA.yearId, kid2.id, sA.s5b);
}, 90_000);

afterAll(async () => {
  await t?.close();
});

async function guardian(admin: SchoolApi, phone: string, fullName = 'Parent'): Promise<string> {
  const res = await admin.post('/guardians', { fullName, phone });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.id;
}

async function link(admin: SchoolApi, studentId: string, guardianId: string, relationshipType = 'mother'): Promise<string> {
  const res = await admin.post(`/students/${studentId}/guardian-links`, { guardianId, relationshipType });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  expect(res.body.status).toBe('pending');
  return res.body.id;
}

async function verified(admin: SchoolApi, studentId: string, guardianId: string, rel = 'mother'): Promise<string> {
  const id = await link(admin, studentId, guardianId, rel);
  const res = await admin.post(`/guardian-links/${id}/verify`);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return id;
}

const children = (tokens: IssuedTokens) =>
  http(t)
    .get('/api/v1/parents/me/children')
    .set(bearer(tokens))
    .then((r) => r.body.items.map((c: { studentId: string }) => c.studentId).sort());

const child = (tokens: IssuedTokens, studentId: string) =>
  http(t).get(`/api/v1/parents/me/children/${studentId}`).set(bearer(tokens));

describe('guardian records', () => {
  test('store only name and normalized phone; unique per school', async () => {
    const phone = newPhone();
    const res = await adminA.post('/guardians', { fullName: 'Geetha', phone: phone.slice(3), aadhaar: '1234 5678 9012' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), fullName: 'Geetha', phone });
    expect((await adminA.post('/guardians', { fullName: 'Again', phone })).status).toBe(409);
    // The same phone in another school is that school's own record.
    await guardian(adminB, phone);
  });

  test('only school admins manage guardians; other schools and the platform see nothing', async () => {
    const id = await guardian(adminA, newPhone());
    expect((await teacherA.get('/guardians')).status).toBe(403);
    expect((await teacherA.post('/guardians', { fullName: 'X', phone: newPhone() })).status).toBe(403);
    expect((await adminB.get(`/guardians/${id}`)).status).toBe(404);
    expect((await api(t, b.admin, a.schoolId).get('/guardians')).status).toBe(404);
    expect((await api(t, platform, a.schoolId).get('/guardians')).status).toBe(404);
  });

  test('a phone number cannot change under a live link', async () => {
    const g = await guardian(adminA, newPhone());
    await link(adminA, kid1.id, g);
    expect((await adminA.patch(`/guardians/${g}`, { phone: newPhone() })).status).toBe(409);
    expect((await adminA.patch(`/guardians/${g}`, { fullName: 'Renamed' })).status).toBe(200);
  });
});

describe('linking and parent access', () => {
  test('a pending link exposes nothing; verification does; revocation removes it on the next request', async () => {
    const phone = newPhone();
    const parent = await otpLogin(t, sms, phone);
    const g = await guardian(adminA, phone, 'Lakshmi');

    const pendingId = await link(adminA, kid1.id, g);
    expect(await children(parent)).toEqual([]);
    expect((await child(parent, kid1.id)).status).toBe(404);

    await adminA.post(`/guardian-links/${pendingId}/verify`).expect(200);
    expect(await children(parent)).toEqual([kid1.id]);
    const detail = await child(parent, kid1.id);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      studentId: kid1.id,
      fullName: 'Kavya',
      schoolName: 'School A',
      relationshipType: 'mother',
      studentStatus: 'active',
      currentPlacement: { academicYearName: '2026-27', gradeNumber: 5, sectionName: 'A' },
    });
    expect(detail.body).not.toHaveProperty('dateOfBirth');

    // Same access token, next request after revocation.
    const revoked = await adminA.post(`/guardian-links/${pendingId}/revoke`, { reason: 'Court order received' });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', statusReason: 'Court order received' });
    expect(await children(parent)).toEqual([]);
    expect((await child(parent, kid1.id)).status).toBe(404);

    expect(await count(t, 'audit_logs', `entity_id = $1 AND action LIKE 'guardian_link.%'`, [pendingId])).toBe(3);
  });

  test('one guardian, several children; one child, several guardians', async () => {
    const motherPhone = newPhone();
    const fatherPhone = newPhone();
    const mother = await otpLogin(t, sms, motherPhone);
    const father = await otpLogin(t, sms, fatherPhone);
    const gm = await guardian(adminA, motherPhone, 'Mother');
    const gf = await guardian(adminA, fatherPhone, 'Father');

    await verified(adminA, kid1.id, gm, 'mother');
    await verified(adminA, kid2.id, gm, 'mother');
    await verified(adminA, kid1.id, gf, 'father');

    expect(await children(mother)).toEqual([kid1.id, kid2.id].sort());
    expect(await children(father)).toEqual([kid1.id]);

    // The father changing the id in the URL gets the same 404 as for a random id.
    const other = await child(father, kid2.id);
    const random = await child(father, randomUUID());
    expect(other.status).toBe(404);
    expect(withoutRequestId(other.body)).toEqual(withoutRequestId(random.body));
  });

  test('one phone, children in two schools, each verified by its own school', async () => {
    const phone = newPhone();
    const parent = await otpLogin(t, sms, phone);
    await verified(adminA, kid2.id, await guardian(adminA, phone), 'father');
    await verified(adminB, kidB.id, await guardian(adminB, phone), 'father');
    expect(await children(parent)).toEqual([kid2.id, kidB.id].sort());

    // A suspended school drops out of the parent's view on the next request.
    await t.database.pool.query(`UPDATE schools SET status = 'suspended' WHERE id = $1`, [b.schoolId]);
    try {
      expect(await children(parent)).toEqual([kid2.id]);
    } finally {
      await t.database.pool.query(`UPDATE schools SET status = 'active' WHERE id = $1`, [b.schoolId]);
    }
  });

  test('a link cannot cross schools', async () => {
    const gB = await guardian(adminB, newPhone());
    const gA = await guardian(adminA, newPhone());
    const before = await count(t, 'student_guardians');
    expect((await adminA.post(`/students/${kidB.id}/guardian-links`, { guardianId: gA, relationshipType: 'mother' })).status).toBe(404);
    expect((await adminA.post(`/students/${kid1.id}/guardian-links`, { guardianId: gB, relationshipType: 'mother' })).status).toBe(404);
    expect(await count(t, 'student_guardians')).toBe(before);
  });

  test('rejection needs a reason and never exposes the child', async () => {
    const phone = newPhone();
    const parent = await otpLogin(t, sms, phone);
    const l = await link(adminA, kid2.id, await guardian(adminA, phone));
    expect((await adminA.post(`/guardian-links/${l}/reject`, {})).status).toBe(400);
    const res = await adminA.post(`/guardian-links/${l}/reject`, { reason: 'Could not confirm relationship' });
    expect(res.body.status).toBe('rejected');
    expect(await children(parent)).toEqual([]);
    expect((await adminA.post(`/guardian-links/${l}/verify`)).status).toBe(409);
  });

  test('transitions follow the workflow', async () => {
    const l = await link(adminA, kid1.id, await guardian(adminA, newPhone()));
    expect((await adminA.post(`/guardian-links/${l}/revoke`, { reason: 'x' })).status).toBe(409);
    await adminA.post(`/guardian-links/${l}/verify`).expect(200);
    expect((await adminA.post(`/guardian-links/${l}/verify`)).status).toBe(409);
    expect((await adminA.post(`/guardian-links/${l}/reject`, { reason: 'x' })).status).toBe(409);
    await adminA.post(`/guardian-links/${l}/revoke`, { reason: 'x' }).expect(200);
    expect((await adminA.post(`/guardian-links/${l}/revoke`, { reason: 'x' })).status).toBe(409);
  });

  test('concurrent verification of one link: exactly one succeeds', async () => {
    const l = await link(adminA, kid2.id, await guardian(adminA, newPhone()));
    const results = await Promise.all([1, 2, 3].map(() => adminA.post(`/guardian-links/${l}/verify`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await count(t, 'audit_logs', `action = 'guardian_link.verified' AND entity_id = $1`, [l])).toBe(1);
  });

  test('a reviewer cannot verify a link to their own phone', async () => {
    const phone = newPhone();
    await t.database.pool.query(`UPDATE users SET phone = $2 WHERE email = $1`, [a.adminEmail, phone]);
    try {
      const l = await link(adminA, kid1.id, await guardian(adminA, phone));
      const res = await adminA.post(`/guardian-links/${l}/verify`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    } finally {
      await t.database.pool.query(`UPDATE users SET phone = NULL WHERE email = $1`, [a.adminEmail]);
    }
  });

  test('teachers, parents and other schools cannot decide links', async () => {
    const phone = newPhone();
    const parent = await otpLogin(t, sms, phone);
    const l = await link(adminA, kid2.id, await guardian(adminA, phone));
    expect((await teacherA.post(`/guardian-links/${l}/verify`)).status).toBe(403);
    // The parent is not a member of the school: 404, as for anyone outside it.
    expect((await api(t, parent, a.schoolId).post(`/guardian-links/${l}/verify`)).status).toBe(404);
    expect((await api(t, b.admin, a.schoolId).post(`/guardian-links/${l}/verify`)).status).toBe(404);
    expect((await adminB.post(`/guardian-links/${l}/verify`)).status).toBe(404);
    expect(await children(parent)).toEqual([]);
  });
});

describe('students who leave', () => {
  test('no new links for a withdrawn student; an existing verified link stays until revoked', async () => {
    const leaver = await createStudent(adminA, { fullName: 'Leaver' });
    await enrol(adminA, sA.yearId, leaver.id, sA.s5a);
    const phone = newPhone();
    const parent = await otpLogin(t, sms, phone);
    const g = await guardian(adminA, phone);
    const l = await verified(adminA, leaver.id, g);

    await adminA.post(`/students/${leaver.id}/status`, { status: 'withdrawn', effectiveDate: '2026-11-01' }).expect(200);

    const view = await child(parent, leaver.id);
    expect(view.body).toMatchObject({ studentStatus: 'withdrawn', currentPlacement: null });
    const second = await guardian(adminA, newPhone());
    expect((await adminA.post(`/students/${leaver.id}/guardian-links`, { guardianId: second, relationshipType: 'father' })).status).toBe(422);

    await adminA.post(`/guardian-links/${l}/revoke`, { reason: 'Student left the school' }).expect(200);
    expect((await child(parent, leaver.id)).status).toBe(404);
  });
});

describe('parent link requests', () => {
  const claim = (tokens: IssuedTokens, body: Record<string, unknown>) =>
    http(t).post('/api/v1/parents/me/link-requests').set(bearer(tokens)).send(body);
  const claims = (tokens: IssuedTokens) =>
    http(t).get('/api/v1/parents/me/link-requests').set(bearer(tokens)).then((r) => r.body.items);

  test('a matching request creates a pending link for review — never access', async () => {
    const phone = newPhone();
    const parent = await otpLogin(t, sms, phone);
    const res = await claim(parent, {
      schoolCode: a.schoolCode.toLowerCase(),
      studentNumber: kid1.studentNumber,
      relationshipType: 'mother',
      guardianName: 'Claiming Mother',
      status: 'verified',
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'submitted' });
    expect(await children(parent)).toEqual([]);
    expect((await claims(parent))[0]).toMatchObject({ status: 'pending', relationshipType: 'mother' });

    const queue = (await adminA.get('/guardian-links', { status: 'pending', limit: 100 })).body.items;
    const pending = queue.find((l: { guardianPhone: string }) => l.guardianPhone === phone);
    expect(pending).toMatchObject({ studentId: kid1.id, initiatedVia: 'guardian_claim', guardianName: 'Claiming Mother' });
    expect(pending.otherLiveLinksForStudent).toBeGreaterThan(0);

    await adminA.post(`/guardian-links/${pending.id}/verify`).expect(200);
    expect(await children(parent)).toEqual([kid1.id]);
    expect((await claims(parent))[0].status).toBe('approved');
  });

  test('a request for a non-existent student looks exactly the same to the parent', async () => {
    const parent = await otpLogin(t, sms, newPhone());
    const before = await count(t, 'student_guardians');
    const real = await claim(parent, { schoolCode: a.schoolCode, studentNumber: kid2.studentNumber, relationshipType: 'father', guardianName: 'F' });
    const fake = await claim(parent, { schoolCode: a.schoolCode, studentNumber: 'NOPE-999', relationshipType: 'father', guardianName: 'F' });
    const noSchool = await claim(parent, { schoolCode: 'ZZZZZZZZ', studentNumber: '1', relationshipType: 'father', guardianName: 'F' });

    for (const r of [fake, noSchool]) {
      expect(r.status).toBe(real.status);
      expect(r.body).toEqual(real.body);
    }
    expect(await count(t, 'student_guardians')).toBe(before + 1);
    expect((await claims(parent)).map((c: { status: string }) => c.status)).toEqual(['pending', 'pending', 'pending']);
  });

  test('conflicting claims are both held for review; the reviewer decides each', async () => {
    const p1 = await otpLogin(t, sms, newPhone());
    const p2 = await otpLogin(t, sms, newPhone());
    const body = { schoolCode: a.schoolCode, studentNumber: kid2.studentNumber, relationshipType: 'mother', guardianName: 'Claimant' };
    await claim(p1, body).expect(202);
    await claim(p2, body).expect(202);

    const links = (await adminA.get(`/students/${kid2.id}/guardian-links`)).body.items.filter(
      (l: { status: string; relationshipType: string; initiatedVia: string }) =>
        l.status === 'pending' && l.relationshipType === 'mother' && l.initiatedVia === 'guardian_claim',
    );
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const l of links) expect(l.otherLiveLinksForStudent).toBeGreaterThanOrEqual(1);

    for (const l of links) await adminA.post(`/guardian-links/${l.id}/reject`, { reason: 'Not on admission record' }).expect(200);
    expect((await claims(p1))[0].status).toBe('declined');
    expect(await children(p1)).toEqual([]);
    expect(await children(p2)).toEqual([]);
  });

  test('a repeated request reuses the live link; a claimant cannot rename an existing guardian record', async () => {
    const phone = newPhone();
    await guardian(adminA, phone, 'Name From School');
    const parent = await otpLogin(t, sms, phone);
    const body = { schoolCode: a.schoolCode, studentNumber: kid1.studentNumber, relationshipType: 'grandparent', guardianName: 'Self-chosen Name' };
    const before = await count(t, 'student_guardians');
    await claim(parent, body).expect(202);
    await claim(parent, body).expect(202);
    expect(await count(t, 'student_guardians')).toBe(before + 1);
    const { rows } = await t.database.pool.query(`SELECT full_name FROM guardians WHERE school_id = $1 AND phone = $2`, [
      a.schoolId,
      phone,
    ]);
    expect(rows[0].full_name).toBe('Name From School');
  });

  test('staff accounts have no phone login: no children, and they cannot file requests', async () => {
    expect((await http(t).get('/api/v1/parents/me/children').set(bearer(a.admin))).body.items).toEqual([]);
    const res = await claim(a.admin, { schoolCode: a.schoolCode, studentNumber: kid1.studentNumber, relationshipType: 'mother', guardianName: 'X' });
    expect(res.status).toBe(403);
  });

  test('parent routes require authentication', async () => {
    await http(t).get('/api/v1/parents/me/children').expect(401);
    await http(t).post('/api/v1/parents/me/link-requests').send({}).expect(401);
  });
});
