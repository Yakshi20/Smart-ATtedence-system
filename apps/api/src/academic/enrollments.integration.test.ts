import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from '../testing/app-harness';
import {
  api,
  createGrade,
  createSection,
  createStudent,
  createYear,
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
  withoutRequestId,
  type OnboardedSchool,
} from '../testing/identity-fixtures';

let t: TestApp;
const notifier = new CapturingNotifier();
let a: OnboardedSchool;
let b: OnboardedSchool;
let adminA: SchoolApi;
let adminB: SchoolApi;
let teacherA: SchoolApi;
let s: Awaited<ReturnType<typeof standardStructure>>;
let sB: Awaited<ReturnType<typeof standardStructure>>;

beforeAll(async () => {
  t = await createTestApp('enrollments', { accountNotifier: notifier, rateLimitRules: GENEROUS_RATE_LIMITS });
  const platform = await createPlatformAdmin(t);
  a = await onboardSchool(t, notifier, platform, { schoolName: 'School A' });
  b = await onboardSchool(t, notifier, platform, { schoolName: 'School B' });
  adminA = api(t, a.admin, a.schoolId);
  adminB = api(t, b.admin, b.schoolId);
  teacherA = api(
    t,
    await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: `t.${Date.now()}@school.test`, role: 'teacher' }),
    a.schoolId,
  );
  s = await standardStructure(adminA);
  sB = await standardStructure(adminB);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('student records and numbers', () => {
  test('a supplied number is normalized; generated numbers are sequential and skip taken ones', async () => {
    const manual = await createStudent(adminA, { studentNumber: ' adm/2026-7 ', fullName: 'Asha' });
    expect(manual.studentNumber).toBe('ADM/2026-7');

    await createStudent(adminA, { studentNumber: '000002' });
    const g1 = await createStudent(adminA);
    const g2 = await createStudent(adminA);
    expect([g1.studentNumber, g2.studentNumber]).toEqual(['000001', '000003']);
  });

  test('student numbers are unique within a school, reusable in another', async () => {
    await createStudent(adminA, { studentNumber: 'SAME-1' });
    const dup = await adminA.post('/students', { studentNumber: 'same-1', fullName: 'Dup' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_RESOURCE');
    await createStudent(adminB, { studentNumber: 'SAME-1' });
  });

  test('concurrent creation never issues the same generated number twice', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => adminB.post('/students', { fullName: 'Parallel' })));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    const numbers = results.map((r) => r.body.studentNumber);
    expect(new Set(numbers).size).toBe(6);
  });

  test('only minimal personal data is accepted and a schoolId in the body is ignored', async () => {
    const res = await adminA.post('/students', {
      fullName: 'Ravi',
      dateOfBirth: '2016-08-15',
      schoolId: b.schoolId,
      aadhaar: '1234 5678 9012',
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['dateOfBirth', 'fullName', 'id', 'status', 'studentNumber']);
    expect(await count(t, 'students', 'id = $1 AND school_id = $2', [res.body.id, a.schoolId])).toBe(1);

    expect((await adminA.post('/students', { fullName: 'Future', dateOfBirth: '2999-01-01' })).status).toBe(400);
  });

  test("another school's student is 404 — the same as a student that does not exist", async () => {
    const pupilB = await createStudent(adminB, { fullName: 'B Pupil' });
    const viaA = await adminA.get(`/students/${pupilB.id}`);
    const missing = await adminA.get(`/students/${randomUUID()}`);
    expect(viaA.status).toBe(404);
    expect(withoutRequestId(viaA.body)).toEqual(withoutRequestId(missing.body));
    expect((await adminA.patch(`/students/${pupilB.id}`, { fullName: 'Hijack' })).status).toBe(404);
    expect((await adminA.get(`/students/${pupilB.id}/enrollments`)).status).toBe(404);
    expect((await api(t, a.admin, b.schoolId).get('/students')).status).toBe(404);
  });

  test('the list is paginated with stable ordering', async () => {
    const page1 = await adminA.get('/students', { limit: 2, offset: 0 });
    const page2 = await adminA.get('/students', { limit: 2, offset: 2 });
    expect(page1.body.items).toHaveLength(2);
    const ids = [...page1.body.items, ...page2.body.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await adminA.get('/students', { limit: 1000 })).status).toBe(400);
  });

  test('teachers cannot create or edit students', async () => {
    expect((await teacherA.post('/students', { fullName: 'X' })).status).toBe(403);
  });
});

describe('enrolment', () => {
  test('enrols a student into a section of the year', async () => {
    const pupil = await createStudent(adminA, { fullName: 'Enrol Me' });
    const res = await adminA.post(`/academic-years/${s.yearId}/enrollments`, {
      studentId: pupil.id,
      sectionId: s.s5a,
      effectiveFrom: '2026-06-01',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sectionId: s.s5a, effectiveFrom: '2026-06-01', effectiveTo: null, voided: false });

    const detail = await adminA.get(`/students/${pupil.id}`);
    expect(detail.body.currentEnrollments).toEqual([
      expect.objectContaining({ enrollmentId: res.body.id, sectionId: s.s5a }),
    ]);
  });

  test('a second enrolment in the same year is refused', async () => {
    const pupil = await createStudent(adminA);
    await enrol(adminA, s.yearId, pupil.id, s.s5a);
    const again = await adminA.post(`/academic-years/${s.yearId}/enrollments`, {
      studentId: pupil.id,
      sectionId: s.s5b,
      effectiveFrom: '2026-07-01',
    });
    expect(again.status).toBe(409);
  });

  test('concurrent enrolments of one student: exactly one wins', async () => {
    const pupil = await createStudent(adminA);
    const results = await Promise.all(
      [s.s5a, s.s5b, s.s6a].map((sectionId) =>
        adminA.post(`/academic-years/${s.yearId}/enrollments`, { studentId: pupil.id, sectionId, effectiveFrom: '2026-06-01' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await count(t, 'enrollments', 'student_id = $1', [pupil.id])).toBe(1);
  });

  test('dates outside the year are refused', async () => {
    const pupil = await createStudent(adminA);
    const res = await adminA.post(`/academic-years/${s.yearId}/enrollments`, {
      studentId: pupil.id,
      sectionId: s.s5a,
      effectiveFrom: '2027-05-01',
    });
    expect(res.status).toBe(422);
  });

  test('scopes must agree: foreign student, foreign section, or a section of another year → 404', async () => {
    const pupil = await createStudent(adminA);
    const pupilB = await createStudent(adminB);
    const nextYear = await createYear(adminA, { name: 'scope-check', startDate: '2029-06-01', endDate: '2030-03-31' });
    const before = await count(t, 'enrollments');

    const responses = await Promise.all([
      adminA.post(`/academic-years/${s.yearId}/enrollments`, { studentId: pupilB.id, sectionId: s.s5a, effectiveFrom: '2026-06-01' }),
      adminA.post(`/academic-years/${s.yearId}/enrollments`, { studentId: pupil.id, sectionId: sB.s5a, effectiveFrom: '2026-06-01' }),
      adminA.post(`/academic-years/${nextYear}/enrollments`, { studentId: pupil.id, sectionId: s.s5a, effectiveFrom: '2029-06-01' }),
      adminA.post(`/academic-years/${sB.yearId}/enrollments`, { studentId: pupil.id, sectionId: s.s5a, effectiveFrom: '2026-06-01' }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(await count(t, 'enrollments')).toBe(before);
  });

  test('once students are enrolled the year’s dates are frozen', async () => {
    const y = await createYear(adminA, { name: 'freeze', startDate: '2031-06-01', endDate: '2032-03-31' });
    const g = await createGrade(adminA, 2);
    const sec = await createSection(adminA, y, g, 'A');
    await adminA.patch(`/academic-years/${y}`, { endDate: '2032-04-10' }).expect(200);
    await enrol(adminA, y, (await createStudent(adminA)).id, sec, '2031-06-01');
    expect((await adminA.patch(`/academic-years/${y}`, { endDate: '2032-03-31' })).status).toBe(409);
  });
});

describe('transfer between sections keeps history', () => {
  test('ends the old placement, opens the new one, and the roster follows the date', async () => {
    const pupil = await createStudent(adminA, { fullName: 'Mover' });
    const first = await enrol(adminA, s.yearId, pupil.id, s.s5a);

    const moved = await adminA.post(`/enrollments/${first}/transfer`, { sectionId: s.s5b, effectiveDate: '2026-10-01' });
    expect(moved.status).toBe(201);
    expect(moved.body.previousEnrollmentId).toBe(first);

    const history = await adminA.get(`/students/${pupil.id}/enrollments`);
    expect(history.body.items).toEqual([
      expect.objectContaining({ id: first, sectionName: 'A', effectiveTo: '2026-10-01', endReason: 'section_transfer' }),
      expect.objectContaining({ id: moved.body.id, sectionName: 'B', effectiveFrom: '2026-10-01', effectiveTo: null }),
    ]);

    const inA = (date: string) =>
      adminA.get(`/sections/${s.s5a}/roster`, { date }).then((r) => r.body.items.map((i: { studentId: string }) => i.studentId));
    const inB = (date: string) =>
      adminA.get(`/sections/${s.s5b}/roster`, { date }).then((r) => r.body.items.map((i: { studentId: string }) => i.studentId));
    expect(await inA('2026-09-30')).toContain(pupil.id);
    expect(await inB('2026-09-30')).not.toContain(pupil.id);
    expect(await inA('2026-10-01')).not.toContain(pupil.id);
    expect(await inB('2026-10-01')).toContain(pupil.id);

    expect(await count(t, 'audit_logs', `action = 'enrollment.transferred' AND entity_id = $1`, [moved.body.id])).toBe(1);
  });

  test('a transfer on the first day is refused — that is a correction, use void', async () => {
    const pupil = await createStudent(adminA);
    const e = await enrol(adminA, s.yearId, pupil.id, s.s5a, '2026-07-01');
    const res = await adminA.post(`/enrollments/${e}/transfer`, { sectionId: s.s5b, effectiveDate: '2026-07-01' });
    expect(res.status).toBe(422);
  });

  test('an ended enrolment cannot be transferred again', async () => {
    const pupil = await createStudent(adminA);
    const e = await enrol(adminA, s.yearId, pupil.id, s.s5a);
    await adminA.post(`/enrollments/${e}/transfer`, { sectionId: s.s5b, effectiveDate: '2026-08-01' }).expect(201);
    expect((await adminA.post(`/enrollments/${e}/transfer`, { sectionId: s.s6a, effectiveDate: '2026-09-01' })).status).toBe(409);
  });
});

describe('corrections by voiding', () => {
  test('a wrong placement is voided with a reason, stays in history, and can be replaced', async () => {
    const pupil = await createStudent(adminA);
    const wrong = await enrol(adminA, s.yearId, pupil.id, s.s6a);

    const voided = await adminA.post(`/enrollments/${wrong}/void`, { reason: 'Entered in Class 6 by mistake' });
    expect(voided.status).toBe(200);
    expect(voided.body.voided).toBe(true);
    await enrol(adminA, s.yearId, pupil.id, s.s5a);

    const history = await adminA.get(`/students/${pupil.id}/enrollments`);
    expect(history.body.items).toEqual([
      expect.objectContaining({ id: wrong, voided: true, voidReason: 'Entered in Class 6 by mistake' }),
      expect.objectContaining({ sectionId: s.s5a, voided: false }),
    ]);
    expect((await adminA.post(`/enrollments/${wrong}/void`, { reason: 'again' })).status).toBe(409);
    expect((await adminA.post(`/enrollments/${wrong}/void`, {})).status).toBe(400);

    // Voided placements never appear on a roster.
    const roster = await adminA.get(`/sections/${s.s6a}/roster`, { date: '2026-06-15' });
    expect(roster.body.items.map((i: { enrollmentId: string }) => i.enrollmentId)).not.toContain(wrong);
  });

  test('a row with a live successor cannot be voided', async () => {
    const pupil = await createStudent(adminA);
    const e = await enrol(adminA, s.yearId, pupil.id, s.s5a);
    await adminA.post(`/enrollments/${e}/transfer`, { sectionId: s.s5b, effectiveDate: '2026-11-01' }).expect(201);
    expect((await adminA.post(`/enrollments/${e}/void`, { reason: 'x' })).status).toBe(409);
  });
});

describe('promotion into the next year keeps history', () => {
  let nextYear: string;
  let s6aNext: string;
  let s4aNext: string;

  beforeAll(async () => {
    nextYear = await createYear(adminA, { name: '2027-28', startDate: '2027-06-01', endDate: '2028-03-31' });
    s6aNext = await createSection(adminA, nextYear, s.grade6, 'A');
    const grade4 = (await adminA.get('/grades')).body.items.find((g: { gradeNumber: number }) => g.gradeNumber === 4)?.id
      ?? (await createGrade(adminA, 4));
    s4aNext = await createSection(adminA, nextYear, grade4, 'A');
  });

  test('closes the source at year end and opens the target, linked', async () => {
    const pupil = await createStudent(adminA, { fullName: 'Promoted' });
    const source = await enrol(adminA, s.yearId, pupil.id, s.s5a);

    const res = await adminA.post(`/academic-years/${nextYear}/promotions`, {
      effectiveFrom: '2027-06-01',
      items: [{ enrollmentId: source, sectionId: s6aNext }],
    });
    expect(res.status).toBe(201);

    const history = (await adminA.get(`/students/${pupil.id}/enrollments`)).body.items;
    expect(history).toEqual([
      expect.objectContaining({ id: source, academicYearName: '2026-27', gradeNumber: 5, effectiveTo: '2027-04-01', endReason: 'promoted' }),
      expect.objectContaining({ academicYearName: '2027-28', gradeNumber: 6, previousEnrollmentId: source, effectiveTo: null }),
    ]);
    // Last day of the old year: still on the Class 5 roster.
    const roster = await adminA.get(`/sections/${s.s5a}/roster`, { date: '2027-03-31' });
    expect(roster.body.items.map((i: { studentId: string }) => i.studentId)).toContain(pupil.id);
  });

  test('a batch is all-or-nothing and reports the failing item', async () => {
    const ok = await createStudent(adminA);
    const bad = await createStudent(adminA);
    const okE = await enrol(adminA, s.yearId, ok.id, s.s5a);
    const badE = await enrol(adminA, s.yearId, bad.id, s.s5b);
    const before = await count(t, 'enrollments', 'academic_year_id = $1', [nextYear]);

    const res = await adminA.post(`/academic-years/${nextYear}/promotions`, {
      effectiveFrom: '2027-06-01',
      items: [
        { enrollmentId: okE, sectionId: s6aNext },
        { enrollmentId: badE, sectionId: s4aNext },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toEqual([{ path: 'items.1.sectionId', message: expect.stringMatching(/lower class/) }]);
    expect(await count(t, 'enrollments', 'academic_year_id = $1', [nextYear])).toBe(before);
    const okNow = (await adminA.get(`/students/${ok.id}/enrollments`)).body.items;
    expect(okNow).toHaveLength(1);
    expect(okNow[0].effectiveTo).toBeNull();
  });

  test('promotion must go to a later year', async () => {
    const pupil = await createStudent(adminA);
    const e = await enrol(adminA, s.yearId, pupil.id, s.s5a);
    const res = await adminA.post(`/academic-years/${s.yearId}/promotions`, {
      effectiveFrom: '2026-06-01',
      items: [{ enrollmentId: e, sectionId: s.s6a }],
    });
    expect(res.status).toBe(422);
  });
});

describe('leaving and returning', () => {
  test('withdrawal ends the current placement, voids a future one, and keeps history', async () => {
    const nextYear = (await adminA.get('/academic-years')).body.items.find((y: { name: string }) => y.name === '2027-28').id;
    const nextSection = (await adminA.get(`/academic-years/${nextYear}/sections`)).body.items[0].id;

    const pupil = await createStudent(adminA, { fullName: 'Leaver' });
    const current = await enrol(adminA, s.yearId, pupil.id, s.s5a);
    const future = await enrol(adminA, nextYear, pupil.id, nextSection, '2027-06-01');

    const res = await adminA.post(`/students/${pupil.id}/status`, { status: 'withdrawn', effectiveDate: '2026-12-15' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('withdrawn');

    const history = (await adminA.get(`/students/${pupil.id}/enrollments`)).body.items;
    expect(history.find((e: { id: string }) => e.id === current)).toMatchObject({ effectiveTo: '2026-12-15', endReason: 'withdrawn' });
    expect(history.find((e: { id: string }) => e.id === future)).toMatchObject({ voided: true });

    const roster = (date: string) =>
      adminA.get(`/sections/${s.s5a}/roster`, { date }).then((r) => r.body.items.map((i: { studentId: string }) => i.studentId));
    expect(await roster('2026-12-14')).toContain(pupil.id);
    expect(await roster('2026-12-15')).not.toContain(pupil.id);

    // Cannot be enrolled while withdrawn.
    expect(
      (await adminA.post(`/academic-years/${s.yearId}/enrollments`, { studentId: pupil.id, sectionId: s.s5b, effectiveFrom: '2027-01-10' })).status,
    ).toBe(422);

    // Readmission restores the status; the school then enrols explicitly.
    expect((await adminA.post(`/students/${pupil.id}/status`, { status: 'active' })).body.status).toBe('active');
    await enrol(adminA, s.yearId, pupil.id, s.s5b, '2027-01-10');
    expect(await count(t, 'audit_logs', `action = 'student.status_changed' AND entity_id = $1`, [pupil.id])).toBe(2);
  });

  test('transfer out records the reason on the ended placement', async () => {
    const pupil = await createStudent(adminA);
    const e = await enrol(adminA, s.yearId, pupil.id, s.s5b);
    await adminA.post(`/students/${pupil.id}/status`, { status: 'transferred', effectiveDate: '2026-11-01' }).expect(200);
    const history = (await adminA.get(`/students/${pupil.id}/enrollments`)).body.items;
    expect(history[0]).toMatchObject({ id: e, endReason: 'transferred_out', effectiveTo: '2026-11-01' });
    expect((await adminA.post(`/students/${pupil.id}/status`, { status: 'withdrawn', effectiveDate: '2026-12-01' })).status).toBe(409);
  });
});

describe('closed years are read-only', () => {
  test('no enrolment changes once the year is closed', async () => {
    const y = await createYear(adminB, { name: 'closing', startDate: '2033-06-01', endDate: '2034-03-31' });
    const g = await createGrade(adminB, 3);
    const sec = await createSection(adminB, y, g, 'A');
    const pupil = await createStudent(adminB);
    const e = await enrol(adminB, y, pupil.id, sec, '2033-06-01');
    await adminB.post(`/academic-years/${sB.yearId}/close`).expect(200);
    await adminB.post(`/academic-years/${y}/open`).expect(200);
    await adminB.post(`/academic-years/${y}/close`).expect(200);

    expect((await adminB.post(`/enrollments/${e}/void`, { reason: 'late' })).status).toBe(409);
    const other = await createStudent(adminB);
    expect(
      (await adminB.post(`/academic-years/${y}/enrollments`, { studentId: other.id, sectionId: sec, effectiveFrom: '2033-07-01' })).status,
    ).toBe(409);
  });
});
