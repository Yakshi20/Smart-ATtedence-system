import { randomUUID } from 'node:crypto';
import type { IssuedTokens } from '../auth/session.service';
import { createTestApp, type TestApp } from '../testing/app-harness';
import {
  api,
  createClassSubject,
  createGrade,
  createSection,
  createSubject,
  createYear,
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

let t: TestApp;
const notifier = new CapturingNotifier();
let a: OnboardedSchool;
let b: OnboardedSchool;
let adminA: SchoolApi;
let adminB: SchoolApi;
let teacherA: SchoolApi;
let bAsAdminA: SchoolApi;
let platform: IssuedTokens;

beforeAll(async () => {
  t = await createTestApp('structure', { accountNotifier: notifier, rateLimitRules: GENEROUS_RATE_LIMITS });
  platform = await createPlatformAdmin(t);
  a = await onboardSchool(t, notifier, platform, { schoolName: 'School A' });
  b = await onboardSchool(t, notifier, platform, { schoolName: 'School B' });
  adminA = api(t, a.admin, a.schoolId);
  adminB = api(t, b.admin, b.schoolId);
  bAsAdminA = api(t, a.admin, b.schoolId);
  const teacher = await inviteAndActivate(t, notifier, a.admin, a.schoolId, {
    email: `t.${Date.now()}@school.test`,
    role: 'teacher',
  });
  teacherA = api(t, teacher, a.schoolId);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('academic years', () => {
  test('valid setup, readable by teachers, not creatable by them', async () => {
    const id = await createYear(adminA, { name: '2024-25', startDate: '2024-06-01', endDate: '2025-03-31' });

    const list = await teacherA.get('/academic-years');
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual(
      expect.arrayContaining([
        { id, name: '2024-25', startDate: '2024-06-01', endDate: '2025-03-31', status: 'planned' },
      ]),
    );

    const denied = await teacherA.post('/academic-years', { name: 'x', startDate: '2030-06-01', endDate: '2031-03-31' });
    expect(denied.status).toBe(403);
  });

  test.each([
    ['end before start', '2033-06-01', '2033-05-01'],
    ['end equal to start', '2033-06-01', '2033-06-01'],
    ['impossible date', '2033-02-30', '2034-03-31'],
  ])('rejects %s with 400', async (_l, startDate, endDate) => {
    const res = await adminA.post('/academic-years', { name: `bad-${randomUUID()}`, startDate, endDate });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('overlapping or duplicate-named years conflict', async () => {
    await createYear(adminA, { name: '2035-36', startDate: '2035-06-01', endDate: '2036-03-31' });

    const overlap = await adminA.post('/academic-years', { name: 'Overlap', startDate: '2036-03-01', endDate: '2036-12-31' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('STATE_CONFLICT');

    const dupName = await adminA.post('/academic-years', { name: '2035-36', startDate: '2037-06-01', endDate: '2038-03-31' });
    expect(dupName.status).toBe(409);
    expect(dupName.body.error.code).toBe('DUPLICATE_RESOURCE');
  });

  test('another school may use the same name and dates', async () => {
    await createYear(adminB, { name: '2035-36', startDate: '2035-06-01', endDate: '2036-03-31' });
  });

  test('lifecycle: planned → active → closed → archived, one direction only', async () => {
    const id = await createYear(adminA, { name: '2040-41', startDate: '2040-06-01', endDate: '2041-03-31' });

    await adminA.patch(`/academic-years/${id}`, { endDate: '2041-04-10' }).expect(200);
    expect((await adminA.post(`/academic-years/${id}/open`)).body.status).toBe('active');
    expect((await adminA.patch(`/academic-years/${id}`, { name: 'renamed' })).status).toBe(409);

    // A second active year is refused while this one is open.
    const other = await createYear(adminA, { name: '2042-43', startDate: '2042-06-01', endDate: '2043-03-31' });
    const second = await adminA.post(`/academic-years/${other}/open`);
    expect(second.status).toBe(409);

    expect((await adminA.post(`/academic-years/${id}/close`)).body.status).toBe('closed');
    // Closed is final for structure.
    const grade = await createGrade(adminA, 1);
    const section = await adminA.post(`/academic-years/${id}/sections`, { gradeId: grade, name: 'A' });
    expect(section.status).toBe(409);
    // No reopening.
    expect((await adminA.post(`/academic-years/${id}/open`)).status).toBe(409);

    expect((await adminA.post(`/academic-years/${id}/archive`)).body.status).toBe('archived');
    const listed = await adminA.get('/academic-years');
    expect(listed.body.items.map((y: { id: string }) => y.id)).not.toContain(id);
    const archived = await adminA.get('/academic-years', { status: 'archived' });
    expect(archived.body.items.map((y: { id: string }) => y.id)).toEqual([id]);

    expect(await count(t, 'audit_logs', `entity_id = $1 AND action LIKE 'academic_year.%'`, [id])).toBe(5);
  });

  test('concurrent opens of two years leave exactly one active', async () => {
    const x = await createYear(adminB, { name: '2050-51', startDate: '2050-06-01', endDate: '2051-03-31' });
    const y = await createYear(adminB, { name: '2052-53', startDate: '2052-06-01', endDate: '2053-03-31' });
    const results = await Promise.all([adminB.post(`/academic-years/${x}/open`), adminB.post(`/academic-years/${y}/open`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await count(t, 'academic_years', `school_id = $1 AND status = 'active'`, [b.schoolId])).toBe(1);
  });
});

describe('grades, sections, subjects, class-subjects', () => {
  let yearId: string;
  let grade5: string;

  beforeAll(async () => {
    yearId = await createYear(adminA, { name: '2026-27', startDate: '2026-06-01', endDate: '2027-03-31' });
    grade5 = await createGrade(adminA, 5);
  });

  test('grades are Classes 1–7 and unique per school', async () => {
    expect((await adminA.post('/grades', { gradeNumber: 5 })).status).toBe(409);
    expect((await adminA.post('/grades', { gradeNumber: 8 })).status).toBe(400);
    expect((await adminA.post('/grades', { gradeNumber: 0 })).status).toBe(400);
    const g = await adminA.post('/grades', { gradeNumber: 3, displayName: '3ನೇ ತರಗತಿ' });
    expect(g.body).toMatchObject({ gradeNumber: 3, displayName: '3ನೇ ತರಗತಿ' });
  });

  test('section names are the school’s own and unique per class and year, ignoring case', async () => {
    await createSection(adminA, yearId, grade5, 'Kaveri');
    const dup = await adminA.post(`/academic-years/${yearId}/sections`, { gradeId: grade5, name: 'KAVERI' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_RESOURCE');

    // Same name in another class is fine.
    const grade4 = await createGrade(adminA, 4);
    await createSection(adminA, yearId, grade4, 'Kaveri');
  });

  test('a section cannot reference another school’s grade or year', async () => {
    const gradeB = await createGrade(adminB, 5);
    const yearB = await createYear(adminB, { name: 'B-2026', startDate: '2026-06-01', endDate: '2027-03-31' });
    const before = await count(t, 'sections');

    const foreignGrade = await adminA.post(`/academic-years/${yearId}/sections`, { gradeId: gradeB, name: 'X' });
    const foreignYear = await adminA.post(`/academic-years/${yearB}/sections`, { gradeId: grade5, name: 'X' });
    const missing = await adminA.post(`/academic-years/${yearId}/sections`, { gradeId: randomUUID(), name: 'X' });

    expect([foreignGrade.status, foreignYear.status, missing.status]).toEqual([404, 404, 404]);
    expect(foreignGrade.body.error.message).toBe(missing.body.error.message);
    expect(await count(t, 'sections')).toBe(before);
  });

  test('subjects are configurable, with optional Kannada labels', async () => {
    const res = await adminA.post('/subjects', {
      code: 'kan',
      name: 'Kannada',
      nameTranslations: { en: 'Kannada', kn: 'ಕನ್ನಡ' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: 'KAN', nameTranslations: { kn: 'ಕನ್ನಡ' }, status: 'active' });

    expect((await adminA.post('/subjects', { code: 'KAN', name: 'Again' })).status).toBe(409);
    expect((await adminA.post('/subjects', { code: 'FR', name: 'French', nameTranslations: { fr: 'x' } })).status).toBe(400);

    // A school may define a subject nobody else has.
    await createSubject(adminA, 'YOGA', 'Yoga and Wellbeing');
    const other = await adminB.get('/subjects');
    expect(other.body.items.map((s: { code: string }) => s.code)).not.toContain('YOGA');
  });

  test('class-subjects: per section, per grade, no duplicates, all-or-nothing', async () => {
    const s5a = await createSection(adminA, yearId, grade5, 'A');
    const s5b = await createSection(adminA, yearId, grade5, 'B');
    const eng = await createSubject(adminA, 'ENG', 'English');
    const sci = await createSubject(adminA, 'SCI', 'Science');

    await createClassSubject(adminA, yearId, s5a, eng);
    const dup = await adminA.post(`/academic-years/${yearId}/class-subjects`, { sectionId: s5a, subjectId: eng });
    expect(dup.status).toBe(409);

    // Whole grade: ENG already on 5A, so the grade-wide request creates nothing.
    const before = await count(t, 'class_subjects');
    expect((await adminA.post(`/academic-years/${yearId}/class-subjects`, { gradeId: grade5, subjectId: eng })).status).toBe(409);
    expect(await count(t, 'class_subjects')).toBe(before);

    const bulk = await adminA.post(`/academic-years/${yearId}/class-subjects`, { gradeId: grade5, subjectId: sci });
    expect(bulk.status).toBe(201);
    // Sections of grade 5 in this year: Kaveri, A, B.
    expect(bulk.body.items).toHaveLength(3);
    expect(bulk.body.items.map((i: { sectionId: string }) => i.sectionId)).toEqual(expect.arrayContaining([s5a, s5b]));
  });

  test('a retired subject cannot be newly assigned', async () => {
    const art = await createSubject(adminA, 'ART', 'Art');
    await adminA.patch(`/subjects/${art}`, { status: 'retired' }).expect(200);
    const s = await createSection(adminA, yearId, grade5, 'R');
    const res = await adminA.post(`/academic-years/${yearId}/class-subjects`, { sectionId: s, subjectId: art });
    expect(res.status).toBe(422);
  });

  test('a class-subject cannot use another school’s subject or section', async () => {
    const subjectB = await createSubject(adminB, 'MATH', 'Maths');
    const s = await createSection(adminA, yearId, grade5, 'Z');
    expect(
      (await adminA.post(`/academic-years/${yearId}/class-subjects`, { sectionId: s, subjectId: subjectB })).status,
    ).toBe(404);
  });

  test('teachers cannot change structure', async () => {
    const responses = await Promise.all([
      teacherA.post('/grades', { gradeNumber: 7 }),
      teacherA.post(`/academic-years/${yearId}/sections`, { gradeId: grade5, name: 'T' }),
      teacherA.post('/subjects', { code: 'TT', name: 'T' }),
      teacherA.post(`/academic-years/${yearId}/open`),
    ]);
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    // …but can read it.
    expect((await teacherA.get(`/academic-years/${yearId}/sections`)).status).toBe(200);
  });
});

describe('isolation and school state', () => {
  test('another school’s admin gets 404 on every academic route', async () => {
    const yearA = (await adminA.get('/academic-years')).body.items[0].id;
    const responses = await Promise.all([
      api(t, b.admin, a.schoolId).get('/academic-years'),
      api(t, b.admin, a.schoolId).get(`/academic-years/${yearA}/sections`),
      api(t, b.admin, a.schoolId).post('/grades', { gradeNumber: 2 }),
      api(t, b.admin, a.schoolId).get('/subjects'),
    ]);
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
  });

  test('a year of school A addressed through school B’s path is 404', async () => {
    const yearA = (await adminA.get('/academic-years')).body.items[0].id;
    expect((await adminB.get(`/academic-years/${yearA}`)).status).toBe(404);
    expect((await bAsAdminA.get(`/academic-years/${yearA}`)).status).toBe(404);
  });

  test('the platform admin cannot use academic routes', async () => {
    expect((await api(t, platform, a.schoolId).get('/academic-years')).status).toBe(404);
  });

  test('a school not yet approved (status pending) cannot use academic routes', async () => {
    const c = await onboardSchool(t, notifier, platform, { schoolName: 'School C' });
    const adminC = api(t, c.admin, c.schoolId);
    await adminC.get('/academic-years').expect(200);

    await t.database.pool.query(`UPDATE schools SET status = 'pending' WHERE id = $1`, [c.schoolId]);
    const responses = await Promise.all([
      adminC.get('/academic-years'),
      adminC.post('/academic-years', { name: 'x', startDate: '2026-06-01', endDate: '2027-03-31' }),
      adminC.post('/grades', { gradeNumber: 1 }),
      adminC.get('/students'),
    ]);
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
  });
});
