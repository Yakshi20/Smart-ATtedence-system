import { SignJWT } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import type { IssuedTokens } from './session.service';
import { createTestApp, type TestApp } from '../testing/app-harness';
import {
  activate,
  bearer,
  CapturingNotifier,
  count,
  createPlatformAdmin,
  GENEROUS_RATE_LIMITS,
  http,
  login,
  onboardSchool,
  PASSWORD,
  submitRegistration,
  withoutRequestId,
  type OnboardedSchool,
} from '../testing/identity-fixtures';

let t: TestApp;
const notifier = new CapturingNotifier();
let platform: IssuedTokens;
let school: OnboardedSchool;

beforeAll(async () => {
  t = await createTestApp('auth', { accountNotifier: notifier, rateLimitRules: GENEROUS_RATE_LIMITS });
  platform = await createPlatformAdmin(t);
  school = await onboardSchool(t, notifier, platform);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const LOGIN = '/api/v1/auth/login';
const REFRESH = '/api/v1/auth/refresh';
const LOGOUT = '/api/v1/auth/logout';
const ACTIVATE = '/api/v1/auth/staff/activate';
const ME = '/api/v1/me';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

async function approvedButNotActivated(): Promise<{ email: string; token: string }> {
  const { requestId, contactEmail } = await submitRegistration(t);
  await http(t)
    .post(`/api/v1/platform/school-registration-requests/${requestId}/approve`)
    .set(bearer(platform))
    .send({})
    .expect(200);
  return { email: contactEmail, token: notifier.tokenFor(contactEmail) };
}

describe('default-deny authentication', () => {
  test('protected routes require a bearer token; health stays public', async () => {
    await http(t).get('/health').expect(200);
    const res = await http(t).get(ME);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test.each([
    ['garbage', 'Bearer not-a-jwt'],
    ['wrong scheme', `Basic ${Buffer.from('a:b').toString('base64')}`],
    ['empty bearer', 'Bearer '],
  ])('rejects a %s authorization header', async (_label, header) => {
    await http(t).get(ME).set('Authorization', header).expect(401);
  });

  test('rejects a token signed with another key', async () => {
    const forged = await new SignJWT({ sid: randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setIssuer('smart-school-api')
      .setAudience('smart-school')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('some-other-secret-that-is-long-enough-000'));
    await http(t).get(ME).set(bearer(forged)).expect(401);
  });

  test('rejects an unsigned (alg: none) token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: randomUUID(), sid: randomUUID(), iss: 'smart-school-api', aud: 'smart-school' }),
    ).toString('base64url');
    await http(t).get(ME).set(bearer(`${header}.${payload}.`)).expect(401);
  });

  test('an expired access token says so, so the client knows to refresh', async () => {
    const tokens = await login(t, school.adminEmail);
    const { rows } = await t.database.pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM user_sessions ORDER BY created_at DESC LIMIT 1`,
    );
    const expired = await new SignJWT({ sid: rows[0]!.id })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(rows[0]!.user_id)
      .setIssuer('smart-school-api')
      .setAudience('smart-school')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(t.config.JWT_ACCESS_SECRET));

    const res = await http(t).get(ME).set(bearer(expired));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCESS_TOKEN_EXPIRED');
    await http(t).get(ME).set(bearer(tokens)).expect(200);
  });
});

describe('login', () => {
  test('returns an access and refresh token; /me identifies the caller', async () => {
    const tokens = await login(t, school.adminEmail);
    expect(tokens.tokenType).toBe('Bearer');
    expect(tokens.accessTokenExpiresIn).toBe(t.config.ACCESS_TOKEN_TTL_SECONDS);
    expect(tokens.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const me = await http(t).get(ME).set(bearer(tokens));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(school.adminEmail);
    expect(me.body.platform).toEqual({ roles: [], permissions: [] });
  });

  test('email matching is case-insensitive and whitespace-tolerant', async () => {
    await login(t, `  ${school.adminEmail.toUpperCase()} `);
  });

  test('the JWT carries identity only — no roles or school ids', async () => {
    const tokens = await login(t, school.adminEmail);
    const payload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1]!, 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
  });

  test('refresh tokens are stored only as SHA-256 hashes', async () => {
    const tokens = await login(t, school.adminEmail);
    const { rows } = await t.database.pool.query<{ token_hash: Buffer }>(
      `SELECT token_hash FROM refresh_tokens WHERE token_hash = $1`,
      [sha256(tokens.refreshToken)],
    );
    expect(rows).toHaveLength(1);

    const { rows: leaked } = await t.database.pool.query(
      `SELECT 1 FROM refresh_tokens WHERE encode(token_hash, 'escape') LIKE '%' || $1 || '%'
         OR encode(token_hash, 'base64') = $1`,
      [tokens.refreshToken],
    );
    expect(leaked).toHaveLength(0);
  });

  test('passwords are stored as argon2id, never plaintext', async () => {
    const { rows } = await t.database.pool.query<{ secret_hash: string }>(
      `SELECT secret_hash FROM auth_identities WHERE provider_subject = $1`,
      [school.adminEmail],
    );
    expect(rows[0]!.secret_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]!.secret_hash).not.toContain(PASSWORD);
  });

  test('unknown email, wrong password and unactivated account are indistinguishable', async () => {
    const pending = await approvedButNotActivated();

    const attempts = await Promise.all([
      http(t).post(LOGIN).send({ method: 'staff_password', email: 'nobody@nowhere.test', password: PASSWORD }),
      http(t).post(LOGIN).send({ method: 'staff_password', email: school.adminEmail, password: 'wrong password!' }),
      http(t).post(LOGIN).send({ method: 'staff_password', email: pending.email, password: PASSWORD }),
    ]);

    for (const res of attempts) {
      expect(res.status).toBe(401);
      expect(withoutRequestId(res.body)).toEqual({ code: 'UNAUTHENTICATED', message: 'Invalid credentials' });
    }
  });

  test('a disabled account cannot log in and its live tokens stop working at once', async () => {
    const email = `disabled.${Date.now()}@school.test`;
    const other = await onboardSchool(t, notifier, platform, { contactEmail: email });

    await t.database.pool.query(`UPDATE users SET status = 'disabled' WHERE email = $1`, [email]);

    await http(t).get(ME).set(bearer(other.admin)).expect(401);
    await http(t).post(REFRESH).send({ refreshToken: other.admin.refreshToken }).expect(401);
    const res = await http(t).post(LOGIN).send({ method: 'staff_password', email, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid credentials');
  });

  test('login requires the method discriminator (D-08)', async () => {
    await http(t).post(LOGIN).send({ email: school.adminEmail, password: PASSWORD }).expect(400);
  });
});

describe('activation', () => {
  test('a token activates once, then is dead', async () => {
    const pending = await approvedButNotActivated();
    await activate(t, pending.token);
    await login(t, pending.email);

    const replay = await http(t).post(ACTIVATE).send({ token: pending.token, password: 'another passphrase here' });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
    // The replay did not change the password.
    await login(t, pending.email);
  });

  test('unknown, used and expired tokens share one response', async () => {
    const used = await approvedButNotActivated();
    await activate(t, used.token);

    const expired = await approvedButNotActivated();
    await t.database.pool.query(
      `UPDATE account_activation_tokens
       SET created_at = now() - interval '4 days', expires_at = now() - interval '1 day'
       WHERE token_hash = $1`,
      [sha256(expired.token)],
    );

    const bodies = [];
    for (const token of [used.token, expired.token, 'A'.repeat(43)]) {
      const res = await http(t).post(ACTIVATE).send({ token, password: 'a long enough passphrase' });
      expect(res.status).toBe(400);
      bodies.push(withoutRequestId(res.body));
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  test('a weak password is rejected without consuming the token', async () => {
    const pending = await approvedButNotActivated();
    const res = await http(t).post(ACTIVATE).send({ token: pending.token, password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    await activate(t, pending.token);
  });

  test('activation tokens are stored only as hashes', async () => {
    const pending = await approvedButNotActivated();
    expect(await count(t, 'account_activation_tokens', 'token_hash = $1', [sha256(pending.token)])).toBe(1);
  });
});

describe('refresh-token rotation', () => {
  test('rotation issues a new pair and the old refresh token is single-use', async () => {
    const first = await login(t, school.adminEmail);

    const rotated = await http(t).post(REFRESH).send({ refreshToken: first.refreshToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(first.refreshToken);
    await http(t).get(ME).set(bearer(rotated.body.accessToken)).expect(200);

    // The session's absolute expiry is not extended by rotation.
    expect(rotated.body.refreshTokenExpiresAt).toBe(first.refreshTokenExpiresAt);

    const { rows } = await t.database.pool.query(
      `SELECT child.parent_token_id = parent.id AS linked
       FROM refresh_tokens child JOIN refresh_tokens parent ON parent.token_hash = $1
       WHERE child.token_hash = $2`,
      [sha256(first.refreshToken), sha256(rotated.body.refreshToken)],
    );
    expect(rows).toEqual([{ linked: true }]);
  });

  test('replaying a used refresh token revokes the whole session', async () => {
    const r1 = await login(t, school.adminEmail);
    const r2 = (await http(t).post(REFRESH).send({ refreshToken: r1.refreshToken }).expect(200)).body as IssuedTokens;

    // An attacker replays the stolen, already-rotated token.
    const replay = await http(t).post(REFRESH).send({ refreshToken: r1.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');

    // The legitimate client's newer tokens are dead too: the lineage is compromised.
    const legit = await http(t).post(REFRESH).send({ refreshToken: r2.refreshToken });
    expect(legit.status).toBe(401);
    expect(legit.body.error.code).toBe('SESSION_REVOKED');
    await http(t).get(ME).set(bearer(r2)).expect(401);
    await http(t).get(ME).set(bearer(r1)).expect(401);

    const { rows } = await t.database.pool.query(
      `SELECT s.revoke_reason FROM user_sessions s JOIN refresh_tokens rt ON rt.session_id = s.id
       WHERE rt.token_hash = $1`,
      [sha256(r1.refreshToken)],
    );
    expect(rows[0].revoke_reason).toBe('refresh_token_reuse');
    expect(await count(t, 'audit_logs', `action = 'auth.refresh_token_reused'`)).toBeGreaterThan(0);
  });

  test('replay revocation is confined to the compromised session', async () => {
    const phone = await login(t, school.adminEmail);
    const laptop = await login(t, school.adminEmail);

    await http(t).post(REFRESH).send({ refreshToken: phone.refreshToken }).expect(200);
    await http(t).post(REFRESH).send({ refreshToken: phone.refreshToken }).expect(401);

    await http(t).get(ME).set(bearer(laptop)).expect(200);
    await http(t).post(REFRESH).send({ refreshToken: laptop.refreshToken }).expect(200);
  });

  test('racing refreshes of one token cannot both succeed', async () => {
    const tokens = await login(t, school.adminEmail);
    const results = await Promise.all(
      [1, 2, 3].map(() => http(t).post(REFRESH).send({ refreshToken: tokens.refreshToken })),
    );
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);

    const { rows } = await t.database.pool.query(
      `SELECT s.revoked_at IS NOT NULL AS revoked FROM user_sessions s
       JOIN refresh_tokens rt ON rt.session_id = s.id WHERE rt.token_hash = $1`,
      [sha256(tokens.refreshToken)],
    );
    expect(rows[0].revoked).toBe(true);
  });

  test('an unknown refresh token is a plain 401', async () => {
    const res = await http(t).post(REFRESH).send({ refreshToken: 'B'.repeat(43) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('a malformed refresh token is rejected before any lookup', async () => {
    await http(t).post(REFRESH).send({ refreshToken: 'short' }).expect(400);
  });

  test('an expired session cannot be refreshed and its access token stops working', async () => {
    const tokens = await login(t, school.adminEmail);
    await t.database.pool.query(
      `UPDATE user_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 second'
       WHERE id = (SELECT session_id FROM refresh_tokens WHERE token_hash = $1)`,
      [sha256(tokens.refreshToken)],
    );

    const res = await http(t).post(REFRESH).send({ refreshToken: tokens.refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
    await http(t).get(ME).set(bearer(tokens)).expect(401);
  });
});

describe('logout', () => {
  test('revokes the session: its access and refresh tokens stop working immediately', async () => {
    const tokens = await login(t, school.adminEmail);
    const other = await login(t, school.adminEmail);

    await http(t).post(LOGOUT).set(bearer(tokens)).expect(204);

    await http(t).get(ME).set(bearer(tokens)).expect(401);
    const refresh = await http(t).post(REFRESH).send({ refreshToken: tokens.refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.error.code).toBe('SESSION_REVOKED');

    // Other sessions of the same user are untouched.
    await http(t).get(ME).set(bearer(other)).expect(200);
  });

  test('requires authentication', async () => {
    await http(t).post(LOGOUT).expect(401);
  });
});
