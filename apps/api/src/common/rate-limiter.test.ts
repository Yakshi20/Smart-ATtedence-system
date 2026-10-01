import { ErrorCode, RateLimitedError } from '@smart-school/shared';
import { DEFAULT_RATE_LIMIT_RULES, RateLimiter } from './rate-limiter';

function limiterAt(start = 1_000_000) {
  let now = start;
  const limiter = new RateLimiter(
    { ...DEFAULT_RATE_LIMIT_RULES, loginPerIp: { limit: 3, windowMs: 60_000 } },
    () => now,
  );
  return { limiter, advance: (ms: number) => (now += ms) };
}

test('allows up to the limit, then throws RATE_LIMITED with a retry hint', () => {
  const { limiter } = limiterAt();
  for (let i = 0; i < 3; i += 1) limiter.hit('loginPerIp', '1.2.3.4');

  try {
    limiter.hit('loginPerIp', '1.2.3.4');
    throw new Error('expected a rate limit');
  } catch (err) {
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).code).toBe(ErrorCode.RATE_LIMITED);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(60);
  }
});

test('the window resets after it elapses', () => {
  const { limiter, advance } = limiterAt();
  for (let i = 0; i < 3; i += 1) limiter.hit('loginPerIp', 'k');
  expect(() => limiter.hit('loginPerIp', 'k')).toThrow(RateLimitedError);

  advance(60_001);
  expect(() => limiter.hit('loginPerIp', 'k')).not.toThrow();
});

test('keys and rules are independent', () => {
  const { limiter } = limiterAt();
  for (let i = 0; i < 3; i += 1) limiter.hit('loginPerIp', 'a');
  expect(() => limiter.hit('loginPerIp', 'b')).not.toThrow();
  expect(() => limiter.hit('refreshPerIp', 'a')).not.toThrow();
});

test('check blocks at the limit without counting', () => {
  const { limiter } = limiterAt();
  limiter.check('loginPerIp', 'k');
  limiter.check('loginPerIp', 'k');
  for (let i = 0; i < 3; i += 1) limiter.hit('loginPerIp', 'k');
  expect(() => limiter.check('loginPerIp', 'k')).toThrow(RateLimitedError);
});

test('reset clears a key', () => {
  const { limiter } = limiterAt();
  for (let i = 0; i < 3; i += 1) limiter.hit('loginPerIp', 'k');
  limiter.reset('loginPerIp', 'k');
  expect(() => limiter.hit('loginPerIp', 'k')).not.toThrow();
});
