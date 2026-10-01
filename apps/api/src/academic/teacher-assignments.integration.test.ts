import { createTestApp, type TestApp } from '../testing/app-harness';
import {
  api,
  createClassSubject,
  createStudent,
  createSubject,
  enrol,
  standardStructure,
  type SchoolApi,
} from '../testing/academic-fixtures';
import {
  CapturingNotifier,
  count,
  createPlatformAdmin,
  GENEROUS_RATE_LIMITS,
  inviteAndActivate,
  onboardSchool,
  type OnboardedSchool,
} from '../testing/identity-fixtures';

/**
 * Teacher assignments and the relationship checks they drive (07 §2: "Teacher changes school or
 * section ID to access another class").
 *
 * Fixture in school A: MATH on 5A with teacher T1 assigned; teacher T2 has no assignment.
 * Pupils: p5a in 5A, p5b in 5B.
 */
let t: TestApp;
const notifier = new CapturingNotifier();
let a: OnboardedSchool;
let b: OnboardedSchool;
let adminA: SchoolApi;
let adminB: SchoolApi;
let t1: SchoolApi;
let t2: SchoolApi;
let t1Email: string;
let s: Awaited<ReturnType<typeof standardStructure>>;
let sB: Awaited<ReturnType<typeof standardStructure>>;
let p5a: string;
let p5b: string;
let assignmentT1: string;

async function membershipIdOf(admin: SchoolApi, email: string): Promise<string> {
  const staff = await admin.get('/staff');
  const m = staff.body.items.find((x: { email: string }) => x.email === email);
  if (!m) throw new Error(`no membership for ${email}`);
  return m.membershipId;
}

beforeAll(async () => {
  t = await createTestApp('assignments', { accountNotifier: notifier, rateLimitRules: GENEROUS_RATE_LIMITS });
  const platform = await createPlatformAdmin(t);
  a = await onboardSchool(t, notifier, platform, { schoolName: 'School A' });
  b = await onboardSchool(t, notifier, platform, { schoolName: 'School B' });
  adminA = api(t, a.admin, a.schoolId);
  adminB = api(t, b.admin, b.schoolId);
  t1Email = `t1.${Date.now()}@school.test`;
  t1 = api(t, await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: t1Email, role: 'teacher' }), a.schoolId);
  t2 = api(
    t,
    await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: `t2.${Date.now()}@school.test`, role: 'teacher' }),
    a.schoolId,
  );
  s = await standardStructure(adminA);
  sB = await standardStructure(adminB);

  p5a = (await createStudent(adminA, { fullName: 'Anu (5A)', dateOfBirth: '2016-01-01' })).id;
  p5b = (await createStudent(adminA, { fullName: 'Bala (5B)' })).id;
  await enrol(adminA, s.yearId, p5a, s.s5a);
  await enrol(adminA, s.yearId, p5b, s.s5b);

  const res = await adminA.post(`/academic-years/${s.yearId}/teacher-assignments`, {
    classSubjectId: s.math5a,
    membershipId: await membershipIdOf(adminA, t1Email),
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  assignmentT1 = res.body.id;
}, 90_000);

afterAll(async () => {
  await t?.close();
});

describe('creating assignments', () => {
  test('a duplicate active assignment is refused', async () => {
    const res = await adminA.post(`/academic-years/${s.yearId}/teacher-assignments`, {
      classSubjectId: s.math5a,
      membershipId: await membershipIdOf(adminA, t1Email),
    });
    expect(res.status).toBe(409);
  });

  test("another school's teacher, a revoked teacher, or a class-subject of another year are refused", async () => {
    const teacherB = `tb.${Date.now()}@school.test`;
    await inviteAndActivate(t, notifier, b.admin, b.schoolId, { email: teacherB, role: 'teacher' });
    const foreignMembership = await membershipIdOf(adminB, teacherB);

    const revokedEmail = `revoked.${Date.now()}@school.test`;
    await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: revokedEmail, role: 'teacher' });
    const revokedMembership = await membershipIdOf(adminA, revokedEmail);
    await t.database.pool.query(`UPDATE school_memberships SET status = 'revoked' WHERE id = $1`, [revokedMembership]);

    const before = await count(t, 'teacher_assignments');
    const foreign = await adminA.post(`/academic-years/${s.yearId}/teacher-assignments`, {
      classSubjectId: s.math5a,
      membershipId: foreignMembership,
    });
    const revoked = await adminA.post(`/academic-years/${s.yearId}/teacher-assignments`, {
      classSubjectId: s.math5a,
      membershipId: revokedMembership,
    });
    const foreignClassSubject = await adminA.post(`/academic-years/${s.yearId}/teacher-assignments`, {
      classSubjectId: sB.math5a,
      membershipId: await membershipIdOf(adminA, t1Email),
    });

    expect([foreign.status, revoked.status, foreignClassSubject.status]).toEqual([404, 422, 404]);
    expect(await count(t, 'teacher_assignments')).toBe(before);
  });

  test('a school admin may also teach', async () => {
    const eng = await createSubject(adminA, 'ENG', 'English');
    const eng5b = await createClassSubject(adminA, s.yearId, s.s5b, eng);
    const res = await adminA.post(`/academic-years/${s.yearId}/teacher-assignments`, {
      classSubjectId: eng5b,
      membershipId: await membershipIdOf(adminA, a.adminEmail),
    });
    expect(res.status).toBe(201);
  });

  test('teachers cannot assign or end assignments', async () => {
    const create = await t1.post(`/academic-years/${s.yearId}/teacher-assignments`, {
      classSubjectId: s.math5a,
      membershipId: await membershipIdOf(adminA, t1Email),
    });
    const end = await t1.post(`/teacher-assignments/${assignmentT1}/end`);
    expect([create.status, end.status]).toEqual([403, 403]);
  });

  test('teachers list only their own assignments; admins list all', async () => {
    const mine = await t1.get('/teacher-assignments');
    expect(mine.status).toBe(200);
    expect(mine.body.items).toEqual([
      expect.objectContaining({ id: assignmentT1, sectionName: 'A', gradeNumber: 5, subjectCode: 'MATH' }),
    ]);
    expect((await t2.get('/teacher-assignments')).body.items).toEqual([]);
    expect((await adminA.get('/teacher-assignments')).body.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe('what an assigned teacher can see', () => {
  test('the roster of the assigned section', async () => {
    const res = await t1.get(`/sections/${s.s5a}/roster`, { date: '2026-07-01' });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { studentId: string }) => i.studentId)).toEqual([p5a]);
  });

  test('an unassigned section of the same school is 403 — visible, but not theirs', async () => {
    const res = await t1.get(`/sections/${s.s5b}/roster`, { date: '2026-07-01' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  test("another school's section is 404", async () => {
    expect((await t1.get(`/sections/${sB.s5a}/roster`, { date: '2026-07-01' })).status).toBe(404);
  });

  test('students of assigned sections only, without date of birth', async () => {
    const list = await t1.get('/students');
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([p5a]);
    expect(list.body.items[0]).not.toHaveProperty('dateOfBirth');

    const own = await t1.get(`/students/${p5a}`);
    expect(own.status).toBe(200);
    expect(own.body).not.toHaveProperty('dateOfBirth');
    expect((await t1.get(`/students/${p5a}/enrollments`)).status).toBe(200);

    // Changing the id in the URL to a pupil of another section yields nothing.
    expect((await t1.get(`/students/${p5b}`)).status).toBe(404);
    expect((await t1.get(`/students/${p5b}/enrollments`)).status).toBe(404);
  });

  test('a teacher with no assignment sees no students and no rosters', async () => {
    expect((await t2.get('/students')).body.items).toEqual([]);
    expect((await t2.get(`/students/${p5a}`)).status).toBe(404);
    expect((await t2.get(`/sections/${s.s5a}/roster`, { date: '2026-07-01' })).status).toBe(403);
  });

  test('teachers cannot change enrolments', async () => {
    const e = (await adminA.get(`/students/${p5a}`)).body.currentEnrollments[0].enrollmentId;
    const responses = await Promise.all([
      t1.post(`/enrollments/${e}/transfer`, { sectionId: s.s5b, effectiveDate: '2026-09-01' }),
      t1.post(`/enrollments/${e}/void`, { reason: 'x' }),
      t1.post(`/academic-years/${s.yearId}/enrollments`, { studentId: p5b, sectionId: s.s5a, effectiveFrom: '2026-06-01' }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403]);
  });
});

describe('access follows the relationship, request by request', () => {
  test('a pupil who moves out of the section disappears from the teacher’s view', async () => {
    const mover = (await createStudent(adminA, { fullName: 'Chandra' })).id;
    const e = await enrol(adminA, s.yearId, mover, s.s5a);
    expect((await t1.get(`/students/${mover}`)).status).toBe(200);

    await adminA.post(`/enrollments/${e}/transfer`, { sectionId: s.s5b, effectiveDate: '2026-08-01' }).expect(201);
    expect((await t1.get(`/students/${mover}`)).status).toBe(404);
  });

  test('ending the assignment removes access on the next request, and history is kept', async () => {
    const ended = await adminA.post(`/teacher-assignments/${assignmentT1}/end`);
    expect(ended.status).toBe(200);

    expect((await t1.get(`/sections/${s.s5a}/roster`, { date: '2026-07-01' })).status).toBe(403);
    expect((await t1.get(`/students/${p5a}`)).status).toBe(404);
    expect((await t1.get('/students')).body.items).toEqual([]);

    expect((await adminA.post(`/teacher-assignments/${assignmentT1}/end`)).status).toBe(409);
    const history = await adminA.get('/teacher-assignments', { includeEnded: 'true' });
    expect(history.body.items.find((x: { id: string }) => x.id === assignmentT1).endedAt).not.toBeNull();

    // Re-assigning after the end is allowed.
    const again = await adminA.post(`/academic-years/${s.yearId}/teacher-assignments`, {
      classSubjectId: s.math5a,
      membershipId: await membershipIdOf(adminA, t1Email),
    });
    expect(again.status).toBe(201);
    expect((await t1.get(`/sections/${s.s5a}/roster`, { date: '2026-07-01' })).status).toBe(200);
  });

  test('a revoked membership blocks the teacher entirely', async () => {
    await t.database.pool.query(
      `UPDATE school_memberships SET status = 'revoked' WHERE id = $1`,
      [await membershipIdOf(adminA, t1Email)],
    );
    expect((await t1.get(`/sections/${s.s5a}/roster`, { date: '2026-07-01' })).status).toBe(404);
    expect((await t1.get('/academic-years')).status).toBe(404);
  });
});
