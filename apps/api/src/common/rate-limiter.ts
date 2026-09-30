import { RateLimitedError } from '@smart-school/shared';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT_RULE_NAMES = [
  'registrationPerIp',
  'registrationPerEmail',
  'loginPerIp',
  'loginFailuresPerIdentifier',
  'refreshPerIp',
  'activationPerIp',
  'otpRequestGlobal',
  'otpRequestPerIp',
  'otpRequestPerPhone',
  'otpRequestCooldownPerPhone',
  'otpVerifyPerIp',
  'otpVerifyFailuresPerPhone',
  'linkClaimPerUser',
] as const;
export type RateLimitName = (typeof RATE_LIMIT_RULE_NAMES)[number];
export type RateLimitRules = Record<RateLimitName, RateLimitRule>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_RATE_LIMIT_RULES: RateLimitRules = {
  // Registration is unauthenticated and writes a row; keep it tight.
  registrationPerIp: { limit: 5, windowMs: HOUR },
  registrationPerEmail: { limit: 3, windowMs: 24 * HOUR },
  // Counts every attempt from an address — the brute-force ceiling.
  loginPerIp: { limit: 30, windowMs: 15 * MINUTE },
  // Counts only failures against one identifier, so a password-guessing run spread over
  // many addresses still stalls on the account it targets.
  loginFailuresPerIdentifier: { limit: 10, windowMs: 15 * MINUTE },
  refreshPerIp: { limit: 120, windowMs: 15 * MINUTE },
  activationPerIp: { limit: 20, windowMs: 15 * MINUTE },

  // OTP requests cost money and are the classic SMS-pumping target: a global ceiling, per-IP
  // and per-phone caps, and a one-minute cooldown between codes to the same phone.
  otpRequestGlobal: { limit: 1_000, windowMs: HOUR },
  otpRequestPerIp: { limit: 20, windowMs: HOUR },
  otpRequestPerPhone: { limit: 5, windowMs: HOUR },
  otpRequestCooldownPerPhone: { limit: 1, windowMs: MINUTE },
  otpVerifyPerIp: { limit: 60, windowMs: 15 * MINUTE },
  // Together with 5 attempts per code, at most 10 wrong guesses per phone per hour:
  // a 6-digit code survives with probability ≥ 1 − 10⁻⁵ per hour of guessing.
  otpVerifyFailuresPerPhone: { limit: 10, windowMs: HOUR },
  linkClaimPerUser: { limit: 10, windowMs: 24 * HOUR },
};

export const RATE_LIMIT_RULES = Symbol('RATE_LIMIT_RULES');

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counters held in process memory.
 *
 * Limitation, accepted for now: counters are per API instance and reset on restart, so N
 * instances allow N× the configured rate. Redis is deferred to Phase 3 (architecture
 * proposal §1); this class is the single place to swap for a shared store then.
 *
 * Keys are namespaced by rule, and callers pass normalized identifiers (lower-cased email),
 * so trivially varied spellings of one identity share one bucket.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private operations = 0;

  constructor(
    private readonly rules: RateLimitRules,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one event; throws once the count exceeds the rule's limit. */
  hit(name: RateLimitName, key: string): void {
    const bucket = this.current(name, key, true);
    bucket.count += 1;
    if (bucket.count > this.rules[name].limit) throw this.limited(bucket);
  }

  /** Throws if the limit is already reached, without counting an event. */
  check(name: RateLimitName, key: string): void {
    const bucket = this.current(name, key, false);
    if (bucket.count >= this.rules[name].limit) throw this.limited(bucket);
  }

  reset(name: RateLimitName, key: string): void {
    this.buckets.delete(`${name}:${key}`);
  }

  private current(name: RateLimitName, key: string, create: boolean): Bucket {
    this.sweepOccasionally();
    const id = `${name}:${key}`;
    const now = this.now();
    const existing = this.buckets.get(id);
    if (existing && existing.resetAt > now) return existing;

    const fresh = { count: 0, resetAt: now + this.rules[name].windowMs };
    if (create) this.buckets.set(id, fresh);
    else this.buckets.delete(id);
    return fresh;
  }

  private limited(bucket: Bucket): RateLimitedError {
    return new RateLimitedError(Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1000)));
  }

  /** Bounds memory: expired buckets are dropped every thousand operations. */
  private sweepOccasionally(): void {
    this.operations += 1;
    if (this.operations % 1000 !== 0) return;
    const now = this.now();
    for (const [id, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(id);
    }
  }
}
