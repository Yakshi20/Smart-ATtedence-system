import { randomUUID } from 'node:crypto';
import type { IssuedTokens } from '../auth/session.service';
import { createTestApp, type TestApp } from '../testing/app-harness';
import {
  api,
  createClassSubject,
  createGrade,
  createSection,
  createStudent,
  createSubject,
  createYear,
  enrol,
  type SchoolApi,
} from '../testing/academic-fixtures';
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
  type OnboardedSchool,
} from '../testing/identity-fixtures';

/**
 * Attendance reports against a small, hand-countable fixture (dates relative to "today"):
 *
 *   R1  5A MATH  D1 p1  submitted  Anu present · Bala absent · Eshwar late
 *   R2  5A ENG   D1 p2  submitted  Anu present · Bala present · Eshwar approved_leave
 *   R3  5A MATH  D3 p1  OPEN       Anu, Bala, Deepa unmarked
 *   R4  5B MATH  D3 p1  submitted  Farah absent · Eshwar present
 *   R5  6A MATH  D4 p1  submitted  Gita present
 *
 * Eshwar moves 5A → 5B at D2. Deepa joins 5A at D3. 5B has NO register on D1 (a missing register
 * must not become absences). T1 teaches MATH 5A only; T2 teaches MATH 5B only.
 */
let t: TestApp;
const notifier = new CapturingNotifier();
const sms = new TestSms();
let platform: IssuedTokens;
let a: OnboardedSchool;
let b: OnboardedSchool;
let adminA: SchoolApi;
let adminB: SchoolApi;
let t1Token: IssuedTokens;
let t2Token: IssuedTokens;
let t1: SchoolApi;
let t2: SchoolApi;
let t1Email: string;
let today: string;
let day: (offset: number) => string;
let D1: string;
let D2: string;
let D3: string;
let D4: string;

const id = {} as Record<
  'year' | 'g5' | 'g6' | 's5a' | 's5b' | 's6a' | 'math5a' | 'eng5a' | 'math5b' | 'math6a' | 'anu' | 'bala' | 'eshwar' | 'deepa' | 'farah' | 'gita' | 'r1',
  string
>;

async function membershipIdOf(admin: SchoolApi, email: string): Promise<string> {
  return (await admin.get('/staff')).body.items.find((x: { email: string }) => x.email === email).membershipId;
}

function putRecords(tokens: IssuedTokens, sessionId: string, records: Array<{ studentId: string; status: string }>) {
  return http(t)
    .put(`/api/v1/schools/${a.schoolId}/attendance/sessions/${sessionId}/records`)
    .set(bearer(tokens))
    .set('Idempotency-Key', randomUUID())
    .send({ records });
}

async function register(classSubjectId: string, date: string, period: number, marks?: Record<string, string>): Promise<string> {
  const res = await adminA.post('/attendance/sessions', { classSubjectId, sessionDate: date, period });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  if (marks) {
    const records = Object.entries(marks).map(([studentId, status]) => ({ studentId, status }));
    const put = await putRecords(a.admin, res.body.id, records);
    if (put.status !== 200) throw new Error(JSON.stringify(put.body));
  }
  return res.body.id;
}

beforeAll(async () => {
  t = await createTestApp('reports', { accountNotifier: notifier, smsProvider: sms, rateLimitRules: GENEROUS_RATE_LIMITS });
  const { rows } = await t.database.pool.query<{ today: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS today`, [
    t.config.ATTENDANCE_TIMEZONE,
  ]);
  today = rows[0]!.today;
  day = (offset: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  [D1, D2, D3, D4] = [day(-6), day(-4), day(-2), day(-1)];

  platform = await createPlatformAdmin(t);
  a = await onboardSchool(t, notifier, platform, { schoolName: 'School A' });
  b = await onboardSchool(t, notifier, platform, { schoolName: 'School B' });
  adminA = api(t, a.admin, a.schoolId);
  adminB = api(t, b.admin, b.schoolId);
  t1Email = `t1.${Date.now()}@school.test`;
  const t2Email = `t2.${Date.now()}@school.test`;
  t1Token = await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: t1Email, role: 'teacher' });
  t2Token = await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: t2Email, role: 'teacher' });
  t1 = api(t, t1Token, a.schoolId);
  t2 = api(t, t2Token, a.schoolId);

  id.year = await createYear(adminA, { name: 'current', startDate: day(-60), endDate: day(200), open: true });
  id.g5 = await createGrade(adminA, 5);
  id.g6 = await createGrade(adminA, 6);
  id.s5a = await createSection(adminA, id.year, id.g5, 'A');
  id.s5b = await createSection(adminA, id.year, id.g5, 'B');
  id.s6a = await createSection(adminA, id.year, id.g6, 'A');
  const math = await createSubject(adminA, 'MATH', 'Mathematics');
  const eng = await createSubject(adminA, 'ENG', 'English');
  id.math5a = await createClassSubject(adminA, id.year, id.s5a, math);
  id.eng5a = await createClassSubject(adminA, id.year, id.s5a, eng);
  id.math5b = await createClassSubject(adminA, id.year, id.s5b, math);
  id.math6a = await createClassSubject(adminA, id.year, id.s6a, math);
  for (const [cs, email] of [
    [id.math5a, t1Email],
    [id.math5b, t2Email],
  ] as const) {
    await adminA
      .post(`/academic-years/${id.year}/teacher-assignments`, { classSubjectId: cs, membershipId: await membershipIdOf(adminA, email) })
      .expect(201);
  }

  const pupil = async (name: string, section: string, from = day(-60)) => {
    const s = await createStudent(adminA, { fullName: name });
    return { id: s.id, enrollmentId: await enrol(adminA, id.year, s.id, section, from) };
  };
  id.anu = (await pupil('Anu', id.s5a)).id;
  id.bala = (await pupil('Bala', id.s5a)).id;
  const eshwar = await pupil('Eshwar', id.s5a);
  id.eshwar = eshwar.id;
  await adminA.post(`/enrollments/${eshwar.enrollmentId}/transfer`, { sectionId: id.s5b, effectiveDate: D2 }).expect(201);
  id.deepa = (await pupil('Deepa', id.s5a, D3)).id;
  id.farah = (await pupil('Farah', id.s5b)).id;
  id.gita = (await pupil('Gita', id.s6a)).id;

  id.r1 = await register(id.math5a, D1, 1, { [id.anu]: 'present', [id.bala]: 'absent', [id.eshwar]: 'late' });
  await register(id.eng5a, D1, 2, { [id.anu]: 'present', [id.bala]: 'present', [id.eshwar]: 'approved_leave' });
  await register(id.math5a, D3, 1);
  await register(id.math5b, D3, 1, { [id.farah]: 'absent', [id.eshwar]: 'present' });
  await register(id.math6a, D4, 1, { [id.gita]: 'present' });
}, 180_000);

afterAll(async () => {
  await t?.close();
});

const range = () => ({ from: D1, to: D4 });
type Row = {
  gradeNumber: number;
  sectionName: string;
  period: number | null;
  registers: Record<string, number | null>;
  studentPeriods: { eligible: number; marked: number; unmarked: number; attended: number; byStatus: Record<string, number>; markingCompleteness: number | null };
  attendanceRate: number | null;
  distinctStudents: number;
  daysWithAnyMark: number;
};
const rowFor = (rows: Row[], grade: number, section: string) => rows.find((r) => r.gradeNumber === grade && r.sectionName === section)!;

describe('section report (school admin)', () => {
  test('counts registers, eligible, marked, unmarked and statuses per section', async () => {
    const res = await adminA.get('/attendance/reports/sections', range());
    expect(res.status).toBe(200);
    expect(res.body.included).toMatchObject({ from: D1, to: D4, registers: 'all registers in the school' });
    expect(res.body.definitions.basis).toBe('periods');
    expect(res.body.rows.map((r: Row) => `${r.gradeNumber}${r.sectionName}`)).toEqual(['5A', '5B', '6A']);

    expect(rowFor(res.body.rows, 5, 'A')).toMatchObject({
      registers: { opened: 3, submitted: 2, open: 1, submissionRate: 0.6667, daysWithRegisters: 2 },
      studentPeriods: {
        eligible: 9,
        marked: 6,
        unmarked: 3,
        attended: 4,
        byStatus: { present: 3, absent: 1, late: 1, approved_leave: 1 },
        markingCompleteness: 0.6667,
      },
      attendanceRate: 0.6667,
      distinctStudents: 4,
      daysWithAnyMark: 1,
    });
    // No register on D1 in 5B → no periods, so Farah has no absence for D1.
    expect(rowFor(res.body.rows, 5, 'B')).toMatchObject({
      registers: { opened: 1, submitted: 1, open: 0, submissionRate: 1 },
      studentPeriods: { eligible: 2, marked: 2, unmarked: 0, byStatus: { present: 1, absent: 1, late: 0, approved_leave: 0 } },
      attendanceRate: 0.5,
      distinctStudents: 2,
    });
  });

  test('groupBy=period splits a section by timetable slot', async () => {
    const res = await adminA.get('/attendance/reports/sections', { ...range(), sectionId: id.s5a, groupBy: 'period' });
    const byPeriod = Object.fromEntries(res.body.rows.map((r: Row) => [r.period, r]));
    expect(byPeriod[1]).toMatchObject({ registers: { opened: 2, submitted: 1 }, studentPeriods: { eligible: 6, marked: 3 } });
    expect(byPeriod[2]).toMatchObject({ registers: { opened: 1, submitted: 1 }, studentPeriods: { eligible: 3, marked: 3 } });
  });

  test('a range with no registers returns no rows — not a class of absentees', async () => {
    const res = await adminA.get('/attendance/reports/sections', { from: day(-30), to: day(-20) });
    expect(res.body.rows).toEqual([]);
  });
});

describe('school summary (admins only)', () => {
  test('class totals count a pupil who changed section once; school totals add up', async () => {
    const res = await adminA.get('/attendance/reports/summary', range());
    expect(res.status).toBe(200);
    const g5 = res.body.grades.find((g: Row) => g.gradeNumber === 5);
    expect(g5).toMatchObject({
      registers: { opened: 4, submitted: 3 },
      studentPeriods: { eligible: 11, marked: 8, unmarked: 3, byStatus: { present: 4, absent: 2, late: 1, approved_leave: 1 } },
      attendanceRate: 0.625,
      // Anu, Bala, Eshwar, Deepa, Farah — Eshwar is in both 5A and 5B rows but one pupil here.
      distinctStudents: 5,
    });
    const sectionSum = res.body.sections
      .filter((s: Row) => s.gradeNumber === 5)
      .reduce((n: number, s: Row) => n + s.distinctStudents, 0);
    expect(sectionSum).toBe(6);

    expect(res.body.total).toMatchObject({
      gradeNumber: null,
      sectionName: null,
      registers: { opened: 5, submitted: 4, open: 1, submissionRate: 0.8, daysWithRegisters: 3 },
      studentPeriods: { eligible: 12, marked: 9, unmarked: 3, attended: 6 },
      attendanceRate: 0.6667,
      distinctStudents: 6,
      daysWithAnyMark: 3,
    });
  });

  test('rows are ordered by class and section, never ranked by rate', async () => {
    const res = await adminA.get('/attendance/reports/summary', range());
    expect(res.body.sections.map((r: Row) => `${r.gradeNumber}${r.sectionName}`)).toEqual(['5A', '5B', '6A']);
    expect(JSON.stringify(res.body)).not.toMatch(/Anu|Bala|Eshwar|Deepa|Farah|Gita/);
  });

  test('teachers cannot see the school summary', async () => {
    expect((await t1.get('/attendance/reports/summary', range())).status).toBe(403);
  });
});

describe('student report', () => {
  test('a pupil who changed section keeps historical class and section per period', async () => {
    const res = await adminA.get(`/attendance/reports/students/${id.eshwar}`, range());
    expect(res.body.items.map((i: { date: string; sectionName: string; status: string }) => [i.date, i.sectionName, i.status])).toEqual([
      [D1, 'A', 'late'],
      [D1, 'A', 'approved_leave'],
      [D3, 'B', 'present'],
    ]);
    expect(res.body.summary).toMatchObject({
      basis: 'periods',
      eligiblePeriods: 3,
      periodsMarked: 3,
      unmarkedPeriods: 0,
      attendedPeriods: 2,
      attendanceRate: 0.6667,
      markingCompleteness: 1,
      daysWithRegisters: 2,
      daysWithAnyMark: 2,
    });
  });

  test('unmarked is not absent; zero marked gives a null rate, not a division by zero', async () => {
    const deepa = await adminA.get(`/attendance/reports/students/${id.deepa}`, range());
    expect(deepa.body.items).toEqual([expect.objectContaining({ date: D3, status: null })]);
    expect(deepa.body.summary).toMatchObject({
      eligiblePeriods: 1,
      periodsMarked: 0,
      unmarkedPeriods: 1,
      byStatus: { absent: 0 },
      attendanceRate: null,
      markingCompleteness: 0,
    });

    // Farah on D1: no register existed for 5B → no periods at all, both rates null.
    const farah = await adminA.get(`/attendance/reports/students/${id.farah}`, { from: D1, to: D1 });
    expect(farah.body.summary).toMatchObject({ eligiblePeriods: 0, periodsMarked: 0, attendanceRate: null, markingCompleteness: null });
  });

  test('the older per-student route returns the same report', async () => {
    const legacy = await adminA.get(`/students/${id.bala}/attendance`, range());
    const current = await adminA.get(`/attendance/reports/students/${id.bala}`, range());
    expect(legacy.body).toEqual(current.body);
    expect(current.body.summary).toMatchObject({ eligiblePeriods: 3, periodsMarked: 2, unmarkedPeriods: 1, attendanceRate: 0.5 });
  });
});

describe('teachers', () => {
  test('see only registers of class-subjects they actively teach', async () => {
    const res = await t1.get('/attendance/reports/sections', range());
    expect(res.status).toBe(200);
    expect(res.body.included.registers).toBe('registers of class-subjects you are actively assigned to');
    // MATH 5A only: R1 and R3. ENG 5A, 5B and 6A are excluded.
    expect(res.body.rows).toHaveLength(1);
    expect(rowFor(res.body.rows, 5, 'A')).toMatchObject({
      registers: { opened: 2, submitted: 1 },
      studentPeriods: { eligible: 6, marked: 3, unmarked: 3, byStatus: { present: 1, absent: 1, late: 1, approved_leave: 0 } },
    });
  });

  test('a section they do not teach is 403; another school’s section is 404', async () => {
    const bYear = await createYear(adminB, { name: 'b', startDate: day(-60), endDate: day(200) });
    const bSection = await createSection(adminB, bYear, await createGrade(adminB, 5), 'A');
    expect((await t1.get('/attendance/reports/sections', { ...range(), sectionId: id.s5b })).status).toBe(403);
    expect((await t1.get('/attendance/reports/sections', { ...range(), sectionId: bSection })).status).toBe(404);
  });

  test('student reports: current pupils of their sections only, limited to their class-subjects', async () => {
    const anu = await t1.get(`/attendance/reports/students/${id.anu}`, range());
    expect(anu.status).toBe(200);
    expect(anu.body.items.map((i: { subjectCode: string }) => i.subjectCode)).toEqual(['MATH', 'MATH']);
    expect(anu.body.summary).toMatchObject({ eligiblePeriods: 2, periodsMarked: 1, unmarkedPeriods: 1 });

    // Eshwar is now in 5B: invisible to T1, visible to T2 with only MATH 5B periods.
    expect((await t1.get(`/attendance/reports/students/${id.eshwar}`, range())).status).toBe(404);
    const viaT2 = await t2.get(`/attendance/reports/students/${id.eshwar}`, range());
    expect(viaT2.body.items).toEqual([expect.objectContaining({ date: D3, sectionName: 'B', status: 'present' })]);
    expect((await t1.get(`/attendance/reports/students/${id.gita}`, range())).status).toBe(404);
  });
});

describe('isolation and filters', () => {
  test('another school sees nothing of school A', async () => {
    const viaAPath = api(t, b.admin, a.schoolId);
    expect((await viaAPath.get('/attendance/reports/summary', range())).status).toBe(404);
    expect((await viaAPath.get(`/attendance/reports/students/${id.anu}`, range())).status).toBe(404);
    expect((await api(t, platform, a.schoolId).get('/attendance/reports/sections', range())).status).toBe(404);

    // School B's own report, filtered by school A's ids, is 404 — and unfiltered shows no A data.
    expect((await adminB.get('/attendance/reports/sections', { ...range(), sectionId: id.s5a })).status).toBe(404);
    expect((await adminB.get('/attendance/reports/summary', { ...range(), academicYearId: id.year })).status).toBe(404);
    expect((await adminB.get(`/attendance/reports/students/${id.anu}`, range())).status).toBe(404);
    const bSummary = await adminB.get('/attendance/reports/summary', range());
    expect(bSummary.body.total).toMatchObject({ registers: { opened: 0 }, studentPeriods: { eligible: 0 }, attendanceRate: null });
    expect(bSummary.body.sections).toEqual([]);
  });

  test('ranges are ordered and at most 366 days; ids are validated against the school and each other', async () => {
    expect((await adminA.get('/attendance/reports/sections', { from: D4, to: D1 })).status).toBe(400);
    expect((await adminA.get('/attendance/reports/sections', { from: day(-400), to: today })).status).toBe(400);
    expect((await adminA.get('/attendance/reports/sections', { from: D1 })).status).toBe(400);
    expect((await adminA.get('/attendance/reports/sections', { ...range(), sectionId: 'A' })).status).toBe(400);
    expect((await adminA.get('/attendance/reports/sections', { ...range(), groupBy: 'student' })).status).toBe(400);
    expect((await adminA.get('/attendance/reports/sections', { ...range(), gradeId: randomUUID() })).status).toBe(404);
    expect((await adminA.get('/attendance/reports/sections', { ...range(), sectionId: id.s5a, gradeId: id.g6 })).status).toBe(422);

    const later = await createYear(adminA, { name: 'later', startDate: day(201), endDate: day(500) });
    const laterSection = await createSection(adminA, later, id.g5, 'L');
    expect((await adminA.get('/attendance/reports/sections', { ...range(), academicYearId: later })).status).toBe(422);
    expect(
      (await adminA.get('/attendance/reports/sections', { from: day(201), to: day(210), academicYearId: id.year, sectionId: laterSection })).status,
    ).toBe(422);
    const filtered = await adminA.get('/attendance/reports/sections', { ...range(), academicYearId: id.year, gradeId: id.g6 });
    expect(filtered.body.rows.map((r: Row) => `${r.gradeNumber}${r.sectionName}`)).toEqual(['6A']);
  });
});

describe('parents', () => {
  test('a verified guardian sees only their child, with period counts; revocation cuts it off', async () => {
    const phone = newPhone();
    const parent = await otpLogin(t, sms, phone);
    const g = await adminA.post('/guardians', { fullName: 'Bala’s mother', phone });
    const link = await adminA.post(`/students/${id.bala}/guardian-links`, { guardianId: g.body.id, relationshipType: 'mother' });
    await adminA.post(`/guardian-links/${link.body.id}/verify`).expect(200);

    const url = (studentId: string) => `/api/v1/parents/me/children/${studentId}/attendance`;
    const res = await http(t).get(url(id.bala)).query(range()).set(bearer(parent));
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ basis: 'periods', eligiblePeriods: 3, periodsMarked: 2, unmarkedPeriods: 1, attendanceRate: 0.5 });
    expect(JSON.stringify(res.body)).not.toMatch(/Anu|Eshwar|Deepa|Farah|Gita/);
    expect((await http(t).get(url(id.anu)).query(range()).set(bearer(parent))).status).toBe(404);

    await adminA.post(`/guardian-links/${link.body.id}/revoke`, { reason: 'Custody order' }).expect(200);
    expect((await http(t).get(url(id.bala)).query(range()).set(bearer(parent))).status).toBe(404);
  });

  test('parents cannot reach school reports', async () => {
    const parent = await otpLogin(t, sms, newPhone());
    expect((await api(t, parent, a.schoolId).get('/attendance/reports/sections', range())).status).toBe(404);
  });
});

describe('CSV export', () => {
  test('aggregate rows only, documented columns, formula injection neutralized, audited', async () => {
    // A school-entered section name that a spreadsheet would execute, in its own date range.
    const evil = await createSection(adminA, id.year, id.g6, '=HYPERLINK("http://x","y")');
    const cs = await createClassSubject(adminA, id.year, evil, (await adminA.get('/subjects')).body.items[0].id);
    const kid = await createStudent(adminA, { fullName: 'Harini' });
    await enrol(adminA, id.year, kid.id, evil, day(-60));
    await register(cs, day(-10), 1, { [kid.id]: 'present' });
    const before = await count(t, 'audit_logs', `action = 'attendance_report.exported'`);

    const res = await http(t)
      .get(`/api/v1/schools/${a.schoolId}/attendance/reports/sections.csv`)
      .query({ from: day(-10), to: day(-10) })
      .set(bearer(a.admin));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="attendance-sections-${day(-10)}-to-${day(-10)}.csv"`);
    expect(res.headers['cache-control']).toBe('no-store');

    const text = res.text.replace(/^\uFEFF/, '');
    const [header, row] = text.trim().split('\r\n');
    expect(header!.split(',').slice(0, 6)).toEqual(['range_from', 'range_to', 'registers_included', 'grade_number', 'section_name', 'registers_opened']);
    expect(row).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(text).not.toContain('Harini');
    expect(text).not.toContain(kid.id);
    expect(await count(t, 'audit_logs', `action = 'attendance_report.exported'`)).toBe(before + 1);
  });

  test('same authorization as the JSON reports; denied exports are not audited', async () => {
    const before = await count(t, 'audit_logs', `action = 'attendance_report.exported'`);
    const get = (tokens: IssuedTokens, schoolId: string, path: string) =>
      http(t).get(`/api/v1/schools/${schoolId}/attendance/reports/${path}`).query(range()).set(bearer(tokens));

    expect((await get(t1Token, a.schoolId, 'summary.csv')).status).toBe(403);
    expect((await get(b.admin, a.schoolId, 'sections.csv')).status).toBe(404);
    expect((await get(t1Token, a.schoolId, `sections.csv?sectionId=${id.s5b}`)).status).toBe(403);
    expect(await count(t, 'audit_logs', `action = 'attendance_report.exported'`)).toBe(before);

    // A teacher's export is scoped to their class-subjects and says so.
    const mine = await get(t1Token, a.schoolId, 'sections.csv');
    expect(mine.status).toBe(200);
    expect(mine.text).toContain('registers of class-subjects you are actively assigned to');
    expect(mine.text.trim().split('\r\n')).toHaveLength(2);
    const summary = await get(a.admin, a.schoolId, 'summary.csv');
    expect(summary.text.split('\r\n')[1]).toMatch(/^[0-9-]+,[0-9-]+,school,,,/);
  });
});

describe('corrections flow into reports', () => {
  test('a correction changes the report on the next request; nothing is cached', async () => {
    const before = await adminA.get(`/attendance/reports/students/${id.bala}`, range());
    expect(before.body.summary.byStatus).toMatchObject({ present: 1, absent: 1 });

    await adminA
      .post(`/attendance/sessions/${id.r1}/corrections`, { studentId: id.bala, status: 'present', reason: 'Register mis-marked' })
      .expect(201);

    const after = await adminA.get(`/attendance/reports/students/${id.bala}`, range());
    expect(after.body.summary).toMatchObject({ byStatus: { present: 2, absent: 0 }, attendanceRate: 1 });
    expect(after.body.items.find((i: { date: string; subjectCode: string }) => i.date === D1 && i.subjectCode === 'MATH').corrected).toBe(true);
    const section = rowFor((await adminA.get('/attendance/reports/sections', range())).body.rows, 5, 'A');
    expect(section).toMatchObject({ studentPeriods: { byStatus: { present: 4, absent: 0 } }, attendanceRate: 0.8333 });
  });

  test('ending a teacher’s assignment removes report access on the next request', async () => {
    const assignment = (await adminA.get('/teacher-assignments')).body.items.find(
      (x: { classSubjectId: string }) => x.classSubjectId === id.math5a,
    );
    await adminA.post(`/teacher-assignments/${assignment.id}/end`).expect(200);
    expect((await t1.get('/attendance/reports/sections', range())).body.rows).toEqual([]);
    expect((await t1.get('/attendance/reports/sections', { ...range(), sectionId: id.s5a })).status).toBe(403);
    expect((await t1.get(`/attendance/reports/students/${id.anu}`, range())).status).toBe(404);
  });
});

describe('integrity alarm', () => {
  test('a record outside eligibility (only possible with triggers disabled) is logged, not hidden', async () => {
    const { Logger } = await import('@nestjs/common');
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const pool = t.database.pool;
    const { rows } = await pool.query(`SELECT id FROM enrollments WHERE student_id = $1 AND voided_at IS NULL`, [id.deepa]);
    // Deepa joined 5A at D3, so she is not eligible on R1 (D1). Only a disabled trigger allows this row.
    await pool.query(`ALTER TABLE attendance_records DISABLE TRIGGER attendance_records_integrity`);
    try {
      await pool.query(
        `INSERT INTO attendance_records (school_id, session_id, section_id, student_id, enrollment_id, status)
         VALUES ($1, $2, $3, $4, $5, 'present')`,
        [a.schoolId, id.r1, id.s5a, id.deepa, rows[0].id],
      );
      const res = await adminA.get(`/attendance/reports/students/${id.deepa}`, { from: D1, to: D1 });
      expect(res.status).toBe(200);
      expect(res.body.summary).toMatchObject({ eligiblePeriods: 0, periodsMarked: 1 });
      expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: 'attendance_report_integrity' }));
    } finally {
      await pool.query(`DELETE FROM attendance_records WHERE session_id = $1 AND student_id = $2`, [id.r1, id.deepa]);
      await pool.query(`ALTER TABLE attendance_records ENABLE TRIGGER attendance_records_integrity`);
      errors.mockRestore();
    }
  });
});
