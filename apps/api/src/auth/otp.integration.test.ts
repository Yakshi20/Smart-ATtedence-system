import { createTestApp, type TestApp } from '../testing/app-harness';
import { newPhone, otpLogin, requestOtp, TestSms, verifyOtp } from '../testing/guardian-fixtures';
import { bearer, count, GENEROUS_RATE_LIMITS, http, withoutRequestId } from '../testing/identity-fixtures';

let t: TestApp;
const sms = new TestSms();

beforeAll(async () => {
  t = await createTestApp('otp', { smsProvider: sms, rateLimitRules: GENEROUS_RATE_LIMITS });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function openChallenge(phone: string) {
  const { rows } = await t.database.pool.query(
    `SELECT id, attempts, delivery_status, encode(code_hmac, 'hex') AS mac, consumed_at, invalidated_at
     FROM otp_challenges WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone],
  );
  return rows[0];
}

describe('requesting a code', () => {
  test('every valid mobile number gets the same response', async () => {
    const res = await requestOtp(t, '98450 12345');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'accepted', expiresInSeconds: 300 });

    const other = await requestOtp(t, newPhone());
    expect(other.status).toBe(res.status);
    expect(other.body).toEqual(res.body);
  });

  test('the code is stored only as a keyed MAC and recorded as dev-outbox, not "sent"', async () => {
    const phone = newPhone();
    await requestOtp(t, phone).expect(202);
    const code = sms.lastCode(phone);
    const row = await openChallenge(phone);

    expect(row.mac).toHaveLength(64);
    expect(row.mac).not.toContain(Buffer.from(code).toString('hex'));
    expect(row.delivery_status).toBe('dev_outbox');
    const { rows } = await t.database.pool.query(`SELECT row_to_json(c)::text AS j FROM otp_challenges c WHERE phone = $1`, [
      phone,
    ]);
    for (const r of rows) expect(r.j).not.toContain(code);
  });

  test('the code never appears in server output', async () => {
    const written: string[] = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const phone = newPhone();
      await requestOtp(t, phone).expect(202);
      const code = sms.lastCode(phone);
      await verifyOtp(t, phone, '000000');
      await verifyOtp(t, phone, code).expect(200);
      expect(written.join('')).not.toContain(code);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  test('a new code invalidates the previous one', async () => {
    const phone = newPhone();
    await requestOtp(t, phone).expect(202);
    const first = sms.lastCode(phone);
    await requestOtp(t, phone).expect(202);
    const second = sms.lastCode(phone);

    if (first !== second) await verifyOtp(t, phone, first).expect(400);
    await verifyOtp(t, phone, second).expect(200);
  });

  test('malformed phone numbers are 400 and create nothing', async () => {
    const before = await count(t, 'otp_challenges');
    await requestOtp(t, '12345').expect(400);
    await requestOtp(t, '+14155550100').expect(400);
    expect(await count(t, 'otp_challenges')).toBe(before);
  });

  test('a provider failure is reported honestly as 503 and the code is withdrawn', async () => {
    const phone = newPhone();
    sms.fail = true;
    try {
      const res = await requestOtp(t, phone);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      sms.fail = false;
    }
    const row = await openChallenge(phone);
    expect(row.delivery_status).toBe('failed');
    expect(row.invalidated_at).not.toBeNull();
  });
});

describe('verifying a code', () => {
  test('a correct code signs the parent in with a phone account that grants nothing yet', async () => {
    const phone = newPhone();
    const tokens = await otpLogin(t, sms, phone);

    const me = await http(t).get('/api/v1/me').set(bearer(tokens));
    expect(me.status).toBe(200);
    expect(me.body.platform).toEqual({ roles: [], permissions: [] });
    expect((await http(t).get('/api/v1/me/schools').set(bearer(tokens))).body.items).toEqual([]);
    expect(await count(t, 'auth_identities', `provider = 'phone_otp' AND provider_subject = $1`, [phone])).toBe(1);
  });

  test('the same phone signs in to the same account next time', async () => {
    const phone = newPhone();
    const a = await otpLogin(t, sms, phone);
    const b = await otpLogin(t, sms, phone);
    const idA = (await http(t).get('/api/v1/me').set(bearer(a))).body.user.id;
    const idB = (await http(t).get('/api/v1/me').set(bearer(b))).body.user.id;
    expect(idA).toBe(idB);
  });

  test('a used code cannot be replayed', async () => {
    const phone = newPhone();
    await requestOtp(t, phone).expect(202);
    const code = sms.lastCode(phone);
    await verifyOtp(t, phone, code).expect(200);
    const replay = await verifyOtp(t, phone, code);
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  test('an expired code fails even when correct', async () => {
    const phone = newPhone();
    await requestOtp(t, phone).expect(202);
    await t.database.pool.query(
      `UPDATE otp_challenges SET created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second'
       WHERE phone = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [phone],
    );
    await verifyOtp(t, phone, sms.lastCode(phone)).expect(400);
  });

  test('after the maximum wrong attempts the code is dead, even the right one', async () => {
    const phone = newPhone();
    await requestOtp(t, phone).expect(202);
    const code = sms.lastCode(phone);
    const wrong = code === '111111' ? '222222' : '111111';

    for (let i = 0; i < 5; i += 1) await verifyOtp(t, phone, wrong).expect(400);
    const row = await openChallenge(phone);
    expect(row.attempts).toBe(5);
    expect(row.invalidated_at).not.toBeNull();

    await verifyOtp(t, phone, code).expect(400);
  });

  test('wrong code, unknown phone and used code give the identical response', async () => {
    const phone = newPhone();
    await requestOtp(t, phone).expect(202);
    const code = sms.lastCode(phone);
    const wrong = await verifyOtp(t, phone, code === '000000' ? '000001' : '000000');
    const unknown = await verifyOtp(t, newPhone(), '123456');
    await verifyOtp(t, phone, code).expect(200);
    const used = await verifyOtp(t, phone, code);

    for (const res of [wrong, unknown, used]) {
      expect(res.status).toBe(400);
      expect(withoutRequestId(res.body)).toEqual({ code: 'INVALID_OR_EXPIRED_TOKEN', message: 'Invalid or expired code' });
    }
  });

  test('concurrent submissions of the correct code: exactly one session', async () => {
    const phone = newPhone();
    await requestOtp(t, phone).expect(202);
    const code = sms.lastCode(phone);
    const sessionsBefore = await count(t, 'user_sessions');

    const results = await Promise.all(Array.from({ length: 5 }, () => verifyOtp(t, phone, code)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400, 400, 400]);
    expect(await count(t, 'user_sessions')).toBe(sessionsBefore + 1);
    expect(await count(t, 'users', 'phone = $1', [phone])).toBe(1);
  });

  test('a disabled phone account cannot sign in', async () => {
    const phone = newPhone();
    await otpLogin(t, sms, phone);
    await t.database.pool.query(`UPDATE users SET status = 'disabled' WHERE phone = $1`, [phone]);
    await requestOtp(t, phone).expect(202);
    await verifyOtp(t, phone, sms.lastCode(phone)).expect(400);
  });
});

describe('brute-force protection', () => {
  let strict: TestApp;
  const strictSms = new TestSms();

  beforeAll(async () => {
    strict = await createTestApp('otp_strict', {
      smsProvider: strictSms,
      rateLimitRules: {
        ...GENEROUS_RATE_LIMITS,
        otpRequestCooldownPerPhone: { limit: 1, windowMs: 60_000 },
        otpVerifyFailuresPerPhone: { limit: 3, windowMs: 60_000 },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await strict?.close();
  });

  test('a second code within the cooldown is refused with Retry-After', async () => {
    const phone = newPhone();
    await requestOtp(strict, phone).expect(202);
    const res = await requestOtp(strict, phone);
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(strictSms.count(phone)).toBe(1);
  });

  test('after repeated failures the phone is locked, even for the right code', async () => {
    const phone = newPhone();
    await requestOtp(strict, phone).expect(202);
    const code = strictSms.lastCode(phone);
    const wrong = code === '999999' ? '888888' : '999999';
    for (let i = 0; i < 3; i += 1) await verifyOtp(strict, phone, wrong).expect(400);
    expect((await verifyOtp(strict, phone, code)).status).toBe(429);
  });
});

describe('no provider configured', () => {
  test('requests fail with 503 and no challenge is created', async () => {
    const none = await createTestApp('otp_none', { smsProvider: null, rateLimitRules: GENEROUS_RATE_LIMITS });
    try {
      const res = await requestOtp(none, newPhone());
      expect(res.status).toBe(503);
      expect(await count(none, 'otp_challenges')).toBe(0);
    } finally {
      await none.close();
    }
  }, 60_000);
});
