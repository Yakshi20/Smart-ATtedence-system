import request from 'supertest';
import type { AccountNotifier, ActivationMessage } from '../auth/account-notifier';
import type { IssuedTokens } from '../auth/session.service';
import { RATE_LIMIT_RULE_NAMES, type RateLimitRules } from '../common/rate-limiter';
import { bootstrapPlatformAdmin } from '../identity/platform-admin';
import type { TestApp } from './app-harness';

export const PASSWORD = 'correct horse battery staple';

/** Captures activation messages so tests can complete the out-of-band step. */
export class CapturingNotifier implements AccountNotifier {
  readonly sent: ActivationMessage[] = [];

  async sendActivation(message: ActivationMessage): Promise<void> {
    this.sent.push(message);
  }

  tokenFor(email: string): string {
    const message = [...this.sent].reverse().find((m) => m.email === email);
    if (!message) throw new Error(`no activation was sent to ${email}`);
    return message.token;
  }

  countFor(email: string): number {
    return this.sent.filter((m) => m.email === email).length;
  }
}

/** Limits high enough that functional tests never trip them; rate-limit tests set their own. */
export const GENEROUS_RATE_LIMITS: RateLimitRules = Object.fromEntries(
  RATE_LIMIT_RULE_NAMES.map((name) => [name, { limit: 100_000, windowMs: 60_000 }]),
) as RateLimitRules;

export function http(t: TestApp) {
  return request(t.app.getHttpServer());
}

export function bearer(tokens: IssuedTokens | string): { Authorization: string } {
  return { Authorization: `Bearer ${typeof tokens === 'string' ? tokens : tokens.accessToken}` };
}

export async function login(t: TestApp, email: string, password = PASSWORD): Promise<IssuedTokens> {
  const res = await http(t)
    .post('/api/v1/auth/login')
    .send({ method: 'staff_password', email, password });
  if (res.status !== 200) throw new Error(`login for ${email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as IssuedTokens;
}

export async function createPlatformAdmin(t: TestApp, email = 'ops@platform.test'): Promise<IssuedTokens> {
  await bootstrapPlatformAdmin(t.database.db, { email, displayName: 'Platform Ops', password: PASSWORD });
  return login(t, email);
}

let sequence = 0;

export function registrationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    schoolName: `Government Higher Primary School ${sequence}`,
    sector: 'government',
    districtName: 'Mysuru',
    addressLine: `${sequence} Temple Road`,
    pincode: '570001',
    contactName: `Head Teacher ${sequence}`,
    contactEmail: `head${sequence}.${Date.now()}@school.test`,
    contactPhone: '9845012345',
    ...overrides,
  };
}

/** Submits a public registration and returns the id of the stored request. */
export async function submitRegistration(
  t: TestApp,
  overrides: Record<string, unknown> = {},
): Promise<{ requestId: string; contactEmail: string }> {
  const payload = registrationPayload(overrides);
  const res = await http(t).post('/api/v1/schools/registration-requests').send(payload);
  if (res.status !== 202) throw new Error(`registration failed: ${res.status} ${JSON.stringify(res.body)}`);

  const contactEmail = String(payload['contactEmail']).trim().toLowerCase();
  const { rows } = await t.database.pool.query<{ id: string }>(
    `SELECT id FROM school_registration_requests WHERE contact_email = $1
     ORDER BY submitted_at DESC LIMIT 1`,
    [contactEmail],
  );
  if (!rows[0]) throw new Error('registration row not found');
  return { requestId: rows[0].id, contactEmail };
}

export interface OnboardedSchool {
  schoolId: string;
  schoolCode: string;
  adminEmail: string;
  admin: IssuedTokens;
}

/** Full onboarding: public request → platform approval → admin activation → admin login. */
export async function onboardSchool(
  t: TestApp,
  notifier: CapturingNotifier,
  platform: IssuedTokens,
  overrides: Record<string, unknown> = {},
): Promise<OnboardedSchool> {
  const { requestId, contactEmail } = await submitRegistration(t, overrides);
  const sentBefore = notifier.countFor(contactEmail);

  const approved = await http(t)
    .post(`/api/v1/platform/school-registration-requests/${requestId}/approve`)
    .set(bearer(platform))
    .send({});
  if (approved.status !== 200) throw new Error(`approve failed: ${approved.status} ${JSON.stringify(approved.body)}`);

  // Only a contact without a password is sent an activation token.
  if (notifier.countFor(contactEmail) > sentBefore) {
    await activate(t, notifier.tokenFor(contactEmail));
  }

  return {
    schoolId: approved.body.school.id,
    schoolCode: approved.body.school.schoolCode,
    adminEmail: contactEmail,
    admin: await login(t, contactEmail),
  };
}

export async function activate(t: TestApp, token: string, password = PASSWORD): Promise<void> {
  const res = await http(t).post('/api/v1/auth/staff/activate').send({ token, password });
  if (res.status !== 204) throw new Error(`activation failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** A school admin invites a staff member, who then activates and logs in. */
export async function inviteAndActivate(
  t: TestApp,
  notifier: CapturingNotifier,
  admin: IssuedTokens,
  schoolId: string,
  staff: { email: string; role: 'school_admin' | 'teacher'; displayName?: string },
): Promise<IssuedTokens> {
  const res = await http(t)
    .post(`/api/v1/schools/${schoolId}/staff`)
    .set(bearer(admin))
    .send({ email: staff.email, role: staff.role, displayName: staff.displayName ?? 'Staff Member' });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  await activate(t, notifier.tokenFor(staff.email));
  return login(t, staff.email);
}

export async function count(t: TestApp, table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const { rows } = await t.database.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/** An error body with the per-request id removed, for comparing two responses for equality. */
export function withoutRequestId(body: { error?: Record<string, unknown> }): unknown {
  const { requestId: _ignored, ...rest } = body.error ?? {};
  return rest;
}

