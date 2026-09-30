import type { IssuedTokens } from '../auth/session.service';
import type { TestApp } from './app-harness';
import { bearer, http } from './identity-fixtures';

/** Thin HTTP helpers for academic setup. Each throws with the response body on an unexpected status. */

async function expectStatus(
  res: { status: number; body: unknown },
  status: number,
  what: string,
): Promise<Record<string, unknown>> {
  if (res.status !== status) throw new Error(`${what}: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, unknown>;
}

export function api(t: TestApp, tokens: IssuedTokens, schoolId: string) {
  const base = `/api/v1/schools/${schoolId}`;
  const h = bearer(tokens);
  return {
    get: (path: string, query: Record<string, unknown> = {}) => http(t).get(`${base}${path}`).query(query).set(h),
    post: (path: string, body: unknown = {}) => http(t).post(`${base}${path}`).set(h).send(body as object),
    patch: (path: string, body: unknown) => http(t).patch(`${base}${path}`).set(h).send(body as object),
  };
}

export type SchoolApi = ReturnType<typeof api>;

export async function createYear(
  s: SchoolApi,
  input: { name?: string; startDate?: string; endDate?: string; open?: boolean } = {},
): Promise<string> {
  const body = await expectStatus(
    await s.post('/academic-years', {
      name: input.name ?? '2026-27',
      startDate: input.startDate ?? '2026-06-01',
      endDate: input.endDate ?? '2027-03-31',
    }),
    201,
    'create year',
  );
  const id = String(body['id']);
  if (input.open) await expectStatus(await s.post(`/academic-years/${id}/open`), 200, 'open year');
  return id;
}

export async function createGrade(s: SchoolApi, gradeNumber: number): Promise<string> {
  return String((await expectStatus(await s.post('/grades', { gradeNumber }), 201, 'create grade'))['id']);
}

export async function createSection(s: SchoolApi, yearId: string, gradeId: string, name: string): Promise<string> {
  return String(
    (await expectStatus(await s.post(`/academic-years/${yearId}/sections`, { gradeId, name }), 201, 'create section'))['id'],
  );
}

export async function createSubject(s: SchoolApi, code: string, name = code): Promise<string> {
  return String((await expectStatus(await s.post('/subjects', { code, name }), 201, 'create subject'))['id']);
}

export async function createClassSubject(
  s: SchoolApi,
  yearId: string,
  sectionId: string,
  subjectId: string,
): Promise<string> {
  const body = await expectStatus(
    await s.post(`/academic-years/${yearId}/class-subjects`, { sectionId, subjectId }),
    201,
    'create class-subject',
  );
  return String((body['items'] as Array<{ id: string }>)[0]!.id);
}

export async function createStudent(
  s: SchoolApi,
  input: { fullName?: string; studentNumber?: string; dateOfBirth?: string } = {},
): Promise<{ id: string; studentNumber: string }> {
  const body = await expectStatus(
    await s.post('/students', { fullName: input.fullName ?? 'Test Pupil', ...input }),
    201,
    'create student',
  );
  return { id: String(body['id']), studentNumber: String(body['studentNumber']) };
}

export async function enrol(
  s: SchoolApi,
  yearId: string,
  studentId: string,
  sectionId: string,
  effectiveFrom = '2026-06-01',
): Promise<string> {
  const body = await expectStatus(
    await s.post(`/academic-years/${yearId}/enrollments`, { studentId, sectionId, effectiveFrom }),
    201,
    'enrol',
  );
  return String(body['id']);
}

/** One year (opened), grades 5 and 6, sections 5A, 5B, 6A, subject MATH on 5A. */
export async function standardStructure(s: SchoolApi) {
  const yearId = await createYear(s, { open: true });
  const grade5 = await createGrade(s, 5);
  const grade6 = await createGrade(s, 6);
  const s5a = await createSection(s, yearId, grade5, 'A');
  const s5b = await createSection(s, yearId, grade5, 'B');
  const s6a = await createSection(s, yearId, grade6, 'A');
  const math = await createSubject(s, 'MATH', 'Mathematics');
  const math5a = await createClassSubject(s, yearId, s5a, math);
  return { yearId, grade5, grade6, s5a, s5b, s6a, math, math5a };
}
