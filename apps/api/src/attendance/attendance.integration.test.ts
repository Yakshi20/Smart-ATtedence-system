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
 * Attendance end to end. Every date is relative to "today" as the database computes it in the
 * configured timezone, so the suite does not depend on when it runs.
 */
let t: TestApp;
const notifier = new CapturingNotifier();
const sms = new TestSms();
let platform: IssuedTokens;
let a: OnboardedSchool;
let b: OnboardedSchool;
let adminA: SchoolApi;
let t1: SchoolApi; // assigned to MATH 5A
let t2: SchoolApi; // no assignment
let t1Token: IssuedTokens;
let t2Token: IssuedTokens;
let today: string;
let day: (offset: number) => string;

const ids = {} as {
  year: string;
  s5a: string;
  s5b: string;
  math5a: string;
  eng5a: string;
  math5b: string;
  k1: string;
  k2: string;
  k3: string;
  kLate: string;
  kMoved: string;
  kLeft: string;
};

async function membershipIdOf(admin: SchoolApi, email: string): Promise<string> {
  const staff = await admin.get('/staff');
  return staff.body.items.find((x: { email: string }) => x.email === email).membershipId;
}

beforeAll(async () => {
  t = await createTestApp('attendance', { accountNotifier: notifier, smsProvider: sms, rateLimitRules: GENEROUS_RATE_LIMITS });
  const { rows } = await t.database.pool.query<{ today: string }>(
    `SELECT (now() AT TIME ZONE $1)::date::text AS today`,
    [t.config.ATTENDANCE_TIMEZONE],
  );
  today = rows[0]!.today;
  day = (offset: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  platform = await createPlatformAdmin(t);
  a = await onboardSchool(t, notifier, platform, { schoolName: 'School A' });
  b = await onboardSchool(t, notifier, platform, { schoolName: 'School B' });
  adminA = api(t, a.admin, a.schoolId);
  const t1Email = `t1.${Date.now()}@school.test`;
  t1Token = await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: t1Email, role: 'teacher' });
  t2Token = await inviteAndActivate(t, notifier, a.admin, a.schoolId, { email: `t2.${Date.now()}@school.test`, role: 'teacher' });
  t1 = api(t, t1Token, a.schoolId);
  t2 = api(t, t2Token, a.schoolId);

  // An active year from 60 days ago to 200 days ahead.
  ids.year = await createYear(adminA, { name: 'current', startDate: day(-60), endDate: day(200), open: true });
  const g5 = await createGrade(adminA, 5);
  ids.s5a = await createSection(adminA, ids.year, g5, 'A');
  ids.s5b = await createSection(adminA, ids.year, g5, 'B');
  const math = await createSubject(adminA, 'MATH', 'Mathematics');
  const eng = await createSubject(adminA, 'ENG', 'English');
  ids.math5a = await createClassSubject(adminA, ids.year, ids.s5a, math);
  ids.eng5a = await createClassSubject(adminA, ids.year, ids.s5a, eng);
  ids.math5b = await createClassSubject(adminA, ids.year, ids.s5b, math);
  const assign = await adminA.post(`/academic-years/${ids.year}/teacher-assignments`, {
    classSubjectId: ids.math5a,
    membershipId: await membershipIdOf(adminA, t1Email),
  });
  if (assign.status !== 201) throw new Error(JSON.stringify(assign.body));

  const pupil = async (name: string, from = day(-60), section = ids.s5a) => {
    const s = await createStudent(adminA, { fullName: name });
    const e = await enrol(adminA, ids.year, s.id, section, from);
    return { id: s.id, enrollmentId: e };
  };
  ids.k1 = (await pupil('Anu')).id;
  ids.k2 = (await pupil('Bala')).id;
  ids.k3 = (await pupil('Chitra')).id;
  // Joins 5A two days ago.
  ids.kLate = (await pupil('Deepa', day(-2))).id;
  // Moves from 5A to 5B three days ago.
  const moved = await pupil('Eshwar');
  ids.kMoved = moved.id;
  await adminA.post(`/enrollments/${moved.enrollmentId}/transfer`, { sectionId: ids.s5b, effectiveDate: day(-3) }).expect(201);
  // Leaves the school three days ago.
  const left = await pupil('Farah');
  ids.kLeft = left.id;
  await adminA.post(`/students/${left.id}/status`, { status: 'withdrawn', effectiveDate: day(-3) }).expect(200);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

const open = (who: SchoolApi, classSubjectId: string, sessionDate: string, period: number) =>
  who.post('/attendance/sessions', { classSubjectId, sessionDate, period });

/** PUT with the Idempotency-Key header, which the SchoolApi helper does not set. */
const submit = (who: SchoolApi, sessionId: string, records: Array<{ studentId: string; status: string }>, key: string | null = randomUUID()) => {
  const tokens = who === t1 ? t1Token : who === t2 ? t2Token : a.admin;
  const req = http(t).put(`/api/v1/schools/${a.schoolId}/attendance/sessions/${sessionId}/records`).set(bearer(tokens));
  return (key === null ? req : req.set('Idempotency-Key', key)).send({ records });
};

const registerIds = (body: { register: Array<{ studentId: string }> }) => body.register.map((r) => r.studentId).sort();
const all = (body: { register: Array<{ studentId: string }> }, status = 'present') =>
  body.register.map((r) => ({ studentId: r.studentId, status }));

describe('roster by date', () => {
  test('includes pupils enrolled on the date; excludes those not yet joined, moved out or withdrawn', async () => {
    const early = await open(t1, ids.math5a, day(-5), 1);
    expect(early.status).toBe(201);
    expect(registerIds(early.body)).toEqual([ids.k1, ids.k2, ids.k3, ids.kMoved, ids.kLeft].sort());
    expect(early.body.counts).toEqual({ onRoster: 5, marked: 0, unmarked: 5 });
    expect(early.body.register.every((r: { status: unknown }) => r.status === null)).toBe(true);

    const recent = await open(t1, ids.math5a, day(-1), 1);
    expect(registerIds(recent.body)).toEqual([ids.k1, ids.k2, ids.k3, ids.kLate].sort());

    const inB = await open(adminA, ids.math5b, day(-1), 1);
    expect(registerIds(inB.body)).toContain(ids.kMoved);
  });

  test('re-opening the same register returns it (200); another subject in the same slot is 409', async () => {
    const first = await open(t1, ids.math5a, day(-4), 2);
    const again = await open(t1, ids.math5a, day(-4), 2);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.id).toBe(first.body.id);
    expect(await count(t, 'attendance_sessions', 'section_id = $1 AND session_date = $2 AND period = 2', [ids.s5a, day(-4)])).toBe(1);

    const clash = await open(adminA, ids.eng5a, day(-4), 2);
    expect(clash.status).toBe(409);
  });

  test('concurrent opens of one slot create one session', async () => {
    const results = await Promise.all([1, 2, 3].map(() => open(adminA, ids.eng5a, day(-4), 3)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
  });
});

describe('dates and years', () => {
  test('future dates are refused; dates outside the year are refused', async () => {
    expect((await open(adminA, ids.math5a, day(1), 1)).status).toBe(422);
    expect((await open(adminA, ids.math5a, day(-61), 1)).status).toBe(422);
    expect((await open(adminA, ids.math5a, '2026-02-30', 1)).status).toBe(400);
    expect((await open(adminA, ids.math5a, day(-1), 0)).status).toBe(400);
  });

  test(`teachers may go back ${7} days; admins further`, async () => {
    expect((await open(t1, ids.math5a, day(-8), 1)).status).toBe(422);
    expect((await open(adminA, ids.math5a, day(-8), 1)).status).toBe(201);
  });

  test('a planned year does not accept attendance', async () => {
    const planned = await createYear(adminA, { name: 'next', startDate: day(201), endDate: day(500) });
    const g = await createGrade(adminA, 6);
    const sec = await createSection(adminA, planned, g, 'A');
    const subj = (await adminA.get('/subjects')).body.items.find((s: { code: string }) => s.code === 'MATH').id;
    const cs = await createClassSubject(adminA, planned, sec, subj);
    expect((await open(adminA, cs, day(201), 1)).status).toBe(409);
  });
});

describe('authorization', () => {
  test('an unassigned teacher can neither open, read nor submit', async () => {
    const s = await open(adminA, ids.math5a, day(-3), 5);
    expect((await open(t2, ids.math5a, day(-3), 6)).status).toBe(403);
    expect((await t2.get(`/attendance/sessions/${s.body.id}`)).status).toBe(403);
    expect((await submit(t2, s.body.id, all(s.body))).status).toBe(403);
    expect((await t2.get('/attendance/sessions')).body.items).toEqual([]);
  });

  test('an assigned teacher cannot reach another section’s register', async () => {
    expect((await open(t1, ids.math5b, day(-1), 2)).status).toBe(403);
    const other = await open(adminA, ids.math5b, day(-1), 3);
    expect((await t1.get(`/attendance/sessions/${other.body.id}`)).status).toBe(403);
    const mine = (await t1.get('/attendance/sessions')).body.items as Array<{ classSubjectId: string }>;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((s) => s.classSubjectId === ids.math5a)).toBe(true);
  });

  test('other schools, the platform admin and parents get 404', async () => {
    const s = await open(adminA, ids.math5a, day(-2), 6);
    const parent = await otpLogin(t, sms, newPhone());
    for (const tokens of [b.admin, platform, parent]) {
      expect((await api(t, tokens, a.schoolId).get(`/attendance/sessions/${s.body.id}`)).status).toBe(404);
    }
    // School A's session addressed through school B's own path is also 404.
    expect((await api(t, b.admin, b.schoolId).get(`/attendance/sessions/${s.body.id}`)).status).toBe(404);
    expect((await api(t, b.admin, b.schoolId).post('/attendance/sessions', { classSubjectId: ids.math5a, sessionDate: day(-1), period: 1 })).status).toBe(404);
  });

  test('teachers cannot correct attendance', async () => {
    const s = await open(t1, ids.math5a, day(-2), 7);
    await submit(t1, s.body.id, all(s.body)).expect(200);
    const res = await t1.post(`/attendance/sessions/${s.body.id}/corrections`, { studentId: ids.k1, status: 'absent', reason: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('submission', () => {
  test('saves present, absent and late for the whole roster', async () => {
    const s = await open(t1, ids.math5a, day(-1), 4);
    const records = [
      { studentId: ids.k1, status: 'present' },
      { studentId: ids.k2, status: 'absent' },
      { studentId: ids.k3, status: 'late' },
      { studentId: ids.kLate, status: 'approved_leave' },
    ];
    const res = await submit(t1, s.body.id, records);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'submitted', replayed: false, counts: { onRoster: 4, marked: 4, unmarked: 0 } });
    const byId = Object.fromEntries(res.body.register.map((r: { studentId: string; status: string }) => [r.studentId, r.status]));
    expect(byId).toEqual(Object.fromEntries(records.map((r) => [r.studentId, r.status])));
  });

  test('unknown statuses and duplicate students are rejected before anything is saved', async () => {
    const s = await open(t1, ids.math5a, day(-1), 5);
    const bad = all(s.body);
    bad[0]!.status = 'sick';
    expect((await submit(t1, s.body.id, bad)).status).toBe(400);
    const dup = [...all(s.body), all(s.body)[0]!];
    expect((await submit(t1, s.body.id, dup)).status).toBe(400);
    expect(await count(t, 'attendance_records', 'session_id = $1', [s.body.id])).toBe(0);
  });

  test('missing or extra students → 422, nothing saved, session stays open', async () => {
    const s = await open(t1, ids.math5a, day(-1), 6);
    const missing = await submit(t1, s.body.id, all(s.body).slice(1));
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields[0].message).toMatch(/^missing: /);

    const outsider = await createStudent(api(t, b.admin, b.schoolId), { fullName: 'Outsider' });
    for (const intruder of [ids.kMoved, outsider.id, randomUUID()]) {
      const extra = await submit(t1, s.body.id, [...all(s.body), { studentId: intruder, status: 'present' }]);
      expect(extra.status).toBe(422);
      expect(extra.body.error.fields[0].message).toMatch(/^not on the roster: /);
    }
    expect(await count(t, 'attendance_records', 'session_id = $1', [s.body.id])).toBe(0);
    expect((await t1.get(`/attendance/sessions/${s.body.id}`)).body.status).toBe('open');
  });

  test('a database failure mid-batch rolls back every record', async () => {
    const s = await open(adminA, ids.math5a, day(-1), 7);
    // Plant a conflicting row for one pupil so the batch insert fails part-way.
    const { rows } = await t.database.pool.query(`SELECT id FROM enrollments WHERE student_id = $1 AND voided_at IS NULL`, [ids.k2]);
    await t.database.pool.query(
      `INSERT INTO attendance_records (school_id, session_id, section_id, student_id, enrollment_id, status)
       VALUES ($1, $2, $3, $4, $5, 'present')`,
      [a.schoolId, s.body.id, ids.s5a, ids.k2, rows[0].id],
    );
    const res = await submit(adminA, s.body.id, all(s.body, 'absent'));
    expect(res.status).toBe(409);
    expect(await count(t, 'attendance_records', 'session_id = $1', [s.body.id])).toBe(1);
    expect((await adminA.get(`/attendance/sessions/${s.body.id}`)).body.status).toBe('open');
    expect(await count(t, 'audit_logs', `action = 'attendance_session.submitted' AND entity_id = $1`, [s.body.id])).toBe(0);
  });

  test('idempotent retry: same key and payload replays; different payload conflicts; new key conflicts', async () => {
    const s = await open(t1, ids.math5a, day(-1), 8);
    const key = randomUUID();
    const first = await submit(t1, s.body.id, all(s.body), key);
    const retry = await submit(t1, s.body.id, [...all(s.body)].reverse(), key);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(await count(t, 'attendance_records', 'session_id = $1', [s.body.id])).toBe(s.body.register.length);
    expect(await count(t, 'audit_logs', `action = 'attendance_session.submitted' AND entity_id = $1`, [s.body.id])).toBe(1);

    const changed = await submit(t1, s.body.id, all(s.body, 'absent'), key);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const newKey = await submit(t1, s.body.id, all(s.body));
    expect(newKey.status).toBe(409);
    expect(newKey.body.error.code).toBe('STATE_CONFLICT');
  });

  test('the Idempotency-Key header is required and must be a UUID', async () => {
    const s = await open(t1, ids.math5a, day(-1), 9);
    expect((await submit(t1, s.body.id, all(s.body), null)).status).toBe(400);
    expect((await submit(t1, s.body.id, all(s.body), 'retry-1')).status).toBe(400);
  });

  test('concurrent submissions with different keys: one wins, nothing is duplicated', async () => {
    const s = await open(adminA, ids.math5a, day(-1), 10);
    const results = await Promise.all([1, 2, 3].map(() => submit(adminA, s.body.id, all(s.body))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await count(t, 'attendance_records', 'session_id = $1', [s.body.id])).toBe(s.body.register.length);
  });
});

describe('corrections', () => {
  let sessionId: string;
  beforeAll(async () => {
    const s = await open(t1, ids.math5a, day(-2), 8);
    sessionId = s.body.id;
    await submit(t1, sessionId, all(s.body, 'absent')).expect(200);
  });

  test('require a reason; keep old value, new value, reason, actor and time; audit each', async () => {
    const noReason = await adminA.post(`/attendance/sessions/${sessionId}/corrections`, { studentId: ids.k1, status: 'present' });
    expect(noReason.status).toBe(400);
    const blank = await adminA.post(`/attendance/sessions/${sessionId}/corrections`, { studentId: ids.k1, status: 'present', reason: '  ' });
    expect(blank.status).toBe(400);

    const c1 = await adminA.post(`/attendance/sessions/${sessionId}/corrections`, {
      studentId: ids.k1,
      status: 'late',
      reason: 'Arrived after roll call; confirmed by class register',
    });
    expect(c1.status).toBe(201);
    expect(c1.body).toMatchObject({ revision: 1, oldStatus: 'absent', newStatus: 'late' });
    const c2 = await adminA.post(`/attendance/sessions/${sessionId}/corrections`, {
      studentId: ids.k1,
      status: 'present',
      reason: 'Late mark waived by headmaster',
    });
    expect(c2.body).toMatchObject({ revision: 2, oldStatus: 'late', newStatus: 'present' });

    const history = await t1.get(`/attendance/sessions/${sessionId}/corrections`);
    expect(history.body.items).toEqual([
      expect.objectContaining({ studentId: ids.k1, revision: 1, oldStatus: 'absent', newStatus: 'late', reason: expect.stringMatching(/roll call/) }),
      expect.objectContaining({ studentId: ids.k1, revision: 2, oldStatus: 'late', newStatus: 'present' }),
    ]);
    const register = (await adminA.get(`/attendance/sessions/${sessionId}`)).body.register;
    expect(register.find((r: { studentId: string }) => r.studentId === ids.k1)).toMatchObject({ status: 'present', corrected: true });
    expect(await count(t, 'audit_logs', `action = 'attendance.corrected' AND metadata->>'studentId' = $1`, [ids.k1])).toBe(2);
    // The reason is not copied into the audit log.
    expect(await count(t, 'audit_logs', `action = 'attendance.corrected' AND metadata::text LIKE '%roll call%'`)).toBe(0);
  });

  test('a correction to the same status, or on an open register, is refused', async () => {
    expect(
      (await adminA.post(`/attendance/sessions/${sessionId}/corrections`, { studentId: ids.k2, status: 'absent', reason: 'x' })).status,
    ).toBe(422);
    const openOne = await open(adminA, ids.math5a, day(-2), 9);
    expect(
      (await adminA.post(`/attendance/sessions/${openOne.body.id}/corrections`, { studentId: ids.k1, status: 'absent', reason: 'x' })).status,
    ).toBe(409);
  });

  test('a pupil enrolled afterwards with a backdated start is unmarked — not absent — until corrected', async () => {
    const s = await open(adminA, ids.math5a, day(-6), 10);
    await submit(adminA, s.body.id, all(s.body)).expect(200);
    const newcomer = await createStudent(adminA, { fullName: 'Ganesh' });
    await enrol(adminA, ids.year, newcomer.id, ids.s5a, day(-10));

    const after = (await adminA.get(`/attendance/sessions/${s.body.id}`)).body;
    expect(after.register.find((r: { studentId: string }) => r.studentId === newcomer.id)).toMatchObject({ status: null });
    expect(after.counts.unmarked).toBe(1);
    const view = (await adminA.get(`/students/${newcomer.id}/attendance`, { from: day(-10), to: today })).body;
    expect(view.summary).toMatchObject({ periodsMarked: 0, byStatus: { absent: 0 }, attendanceRate: null });

    const marked = await adminA.post(`/attendance/sessions/${s.body.id}/corrections`, {
      studentId: newcomer.id,
      status: 'present',
      reason: 'Admission backdated; present per class teacher',
    });
    expect(marked.status).toBe(201);
    expect(marked.body).toMatchObject({ oldStatus: null, newStatus: 'present', revision: 1 });
  });

  test('a student not on the register cannot be added by correction', async () => {
    const res = await adminA.post(`/attendance/sessions/${sessionId}/corrections`, { studentId: ids.kMoved, status: 'present', reason: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('enrolment history keeps recorded attendance valid', () => {
  test('no void, no transfer or withdrawal dated on/before recorded attendance; a later date works and history stays', async () => {
    const pupil = await createStudent(adminA, { fullName: 'Hari' });
    const e = await enrol(adminA, ids.year, pupil.id, ids.s5a, day(-20));
    const s = await open(adminA, ids.math5a, day(-5), 11);
    await submit(adminA, s.body.id, all(s.body)).expect(200);

    const voided = await adminA.post(`/enrollments/${e}/void`, { reason: 'mistake' });
    expect(voided.status).toBe(409);
    expect(voided.body.error.message).toMatch(/recorded attendance/);
    expect((await adminA.post(`/enrollments/${e}/transfer`, { sectionId: ids.s5b, effectiveDate: day(-5) })).status).toBe(409);
    expect((await adminA.post(`/students/${pupil.id}/status`, { status: 'withdrawn', effectiveDate: day(-6) })).status).toBe(409);

    await adminA.post(`/enrollments/${e}/transfer`, { sectionId: ids.s5b, effectiveDate: day(-4) }).expect(201);
    const history = (await adminA.get(`/students/${pupil.id}/attendance`, { from: day(-10), to: today })).body;
    expect(history.items).toEqual([expect.objectContaining({ date: day(-5), period: 11, status: 'present' })]);
    const register = (await adminA.get(`/attendance/sessions/${s.body.id}`)).body.register;
    expect(register.map((r: { studentId: string }) => r.studentId)).toContain(pupil.id);
  });
});

describe('parents', () => {
  let parent: IssuedTokens;
  let pending: IssuedTokens;
  let linkId: string;

  beforeAll(async () => {
    const phone = newPhone();
    parent = await otpLogin(t, sms, phone);
    const g = await adminA.post('/guardians', { fullName: 'Anu’s mother', phone });
    const l = await adminA.post(`/students/${ids.k1}/guardian-links`, { guardianId: g.body.id, relationshipType: 'mother' });
    linkId = l.body.id;
    await adminA.post(`/guardian-links/${linkId}/verify`).expect(200);

    const pendingPhone = newPhone();
    pending = await otpLogin(t, sms, pendingPhone);
    const pg = await adminA.post('/guardians', { fullName: 'Unverified', phone: pendingPhone });
    await adminA.post(`/students/${ids.k1}/guardian-links`, { guardianId: pg.body.id, relationshipType: 'father' }).expect(201);
  });

  const childAttendance = (tokens: IssuedTokens, studentId: string) =>
    http(t).get(`/api/v1/parents/me/children/${studentId}/attendance`).query({ from: day(-30), to: today }).set(bearer(tokens));

  test('a verified guardian sees the child’s per-period attendance, without staff notes', async () => {
    const res = await childAttendance(parent, ids.k1);
    expect(res.status).toBe(200);
    expect(res.body.summary.basis).toBe('periods');
    expect(res.body.summary.periodsMarked).toBe(res.body.items.length);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.some((i: { corrected: boolean }) => i.corrected)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/reason|roll call|headmaster/i);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['corrected', 'date', 'period', 'status', 'subjectCode', 'subjectName']);
  });

  test('another child, an unverified link, or a bad range get nothing', async () => {
    expect((await childAttendance(parent, ids.k2)).status).toBe(404);
    expect((await childAttendance(pending, ids.k1)).status).toBe(404);
    const reversed = await http(t)
      .get(`/api/v1/parents/me/children/${ids.k1}/attendance`)
      .query({ from: today, to: day(-5) })
      .set(bearer(parent));
    expect(reversed.status).toBe(400);
  });

  test('revoking the link cuts access on the next request', async () => {
    await adminA.post(`/guardian-links/${linkId}/revoke`, { reason: 'Custody change' }).expect(200);
    expect((await childAttendance(parent, ids.k1)).status).toBe(404);
  });

  test('teachers cannot use the whole-student view', async () => {
    expect((await t1.get(`/students/${ids.k1}/attendance`, { from: day(-30), to: today })).status).toBe(403);
  });
});

describe('closed years are read-only for attendance', () => {
  test('after closing, no session, submission or correction', async () => {
    const adminB = api(t, b.admin, b.schoolId);
    const year = await createYear(adminB, { name: 'b-current', startDate: day(-60), endDate: day(200), open: true });
    const g = await createGrade(adminB, 3);
    const sec = await createSection(adminB, year, g, 'A');
    const cs = await createClassSubject(adminB, year, sec, await createSubject(adminB, 'EVS', 'EVS'));
    const pupil = await createStudent(adminB, { fullName: 'Ira' });
    await enrol(adminB, year, pupil.id, sec, day(-60));

    const done = await adminB.post('/attendance/sessions', { classSubjectId: cs, sessionDate: day(-1), period: 1 });
    const bKey = randomUUID();
    await http(t)
      .put(`/api/v1/schools/${b.schoolId}/attendance/sessions/${done.body.id}/records`)
      .set(bearer(b.admin))
      .set('Idempotency-Key', bKey)
      .send({ records: [{ studentId: pupil.id, status: 'present' }] })
      .expect(200);
    const pendingOne = await adminB.post('/attendance/sessions', { classSubjectId: cs, sessionDate: day(-1), period: 2 });

    await adminB.post(`/academic-years/${year}/close`).expect(200);

    expect((await adminB.post('/attendance/sessions', { classSubjectId: cs, sessionDate: day(-1), period: 3 })).status).toBe(409);
    const late = await http(t)
      .put(`/api/v1/schools/${b.schoolId}/attendance/sessions/${pendingOne.body.id}/records`)
      .set(bearer(b.admin))
      .set('Idempotency-Key', randomUUID())
      .send({ records: [{ studentId: pupil.id, status: 'present' }] });
    expect(late.status).toBe(409);
    expect(
      (await adminB.post(`/attendance/sessions/${done.body.id}/corrections`, { studentId: pupil.id, status: 'absent', reason: 'x' })).status,
    ).toBe(409);
    // Reading history still works.
    expect((await adminB.get(`/attendance/sessions/${done.body.id}`)).body.status).toBe('submitted');
  });
});
