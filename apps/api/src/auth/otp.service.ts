import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, hkdfSync, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database, type Transaction } from '@smart-school/database';
import { DomainError, ErrorCode } from '@smart-school/shared';
import { writeAudit } from '../audit/audit';
import { RateLimiter } from '../common/rate-limiter';
import type { RequestMeta } from '../common/request-meta';
import { CONFIG, type AppConfig } from '../config/env';
import { DATABASE } from '../database/database.module';
import { maskPhone, SMS_PROVIDER, type SmsProvider } from '../sms/sms-provider';
import { SessionService, type IssuedTokens } from './session.service';

type Purpose = 'guardian_login';

/**
 * One response for every verification failure — no challenge, expired, used, wrong code, too
 * many attempts — so a caller learns nothing about the phone or the challenge's state.
 */
const invalidCode = () => new DomainError(ErrorCode.INVALID_OR_EXPIRED_TOKEN, 'Invalid or expired code');

type VerifyOutcome = { kind: 'ok'; userId: string; sessionId: string; refreshToken: string; expiresAt: Date } | { kind: 'invalid' };

/**
 * Phone one-time codes (07 §1: expiry, attempt caps, rate limits; never stored or logged in
 * plaintext).
 *
 * - Request: any valid Indian mobile number gets a challenge and a message, so the response —
 *   body and timing — is the same for every number. Issuing a code invalidates the previous one.
 * - Storage: HMAC-SHA256 over (challenge id, code) under a server key; the code itself exists
 *   only in memory until handed to the SMS provider.
 * - Verify: the challenge row is locked, so two simultaneous correct submissions cannot both
 *   succeed; a code is consumed on first success, so replay fails; every attempt is counted and
 *   committed even when it fails.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly key: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider | null,
    private readonly limiter: RateLimiter,
    private readonly sessions: SessionService,
  ) {
    this.key = config.OTP_HASH_SECRET
      ? Buffer.from(config.OTP_HASH_SECRET, 'utf8')
      : Buffer.from(hkdfSync('sha256', config.JWT_ACCESS_SECRET, 'smart-school', 'otp-code-hmac-v1', 32));
  }

  async request(input: { phone: string; purpose: Purpose }, meta: RequestMeta): Promise<{ status: 'accepted'; expiresInSeconds: number }> {
    this.limiter.hit('otpRequestGlobal', 'all');
    this.limiter.hit('otpRequestPerIp', meta.ip);
    this.limiter.hit('otpRequestCooldownPerPhone', input.phone);
    this.limiter.hit('otpRequestPerPhone', input.phone);

    // Honest failure, identical for every phone: without a provider no code can reach anyone.
    if (!this.sms) throw new DomainError(ErrorCode.SERVICE_UNAVAILABLE, 'Phone verification is not available');

    const challengeId = randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.otpChallenges)
        .set({ invalidatedAt: sql`now()` })
        .where(this.openChallenge(input.phone, input.purpose));
      await tx.insert(schema.otpChallenges).values({
        id: challengeId,
        phone: input.phone,
        purpose: input.purpose,
        codeHmac: this.mac(challengeId, code),
        expiresAt: sql`now() + make_interval(secs => ${this.config.OTP_TTL_SECONDS})`,
        maxAttempts: this.config.OTP_MAX_ATTEMPTS,
      });
    });

    const minutes = Math.round(this.config.OTP_TTL_SECONDS / 60);
    try {
      await this.sms.send(
        input.phone,
        `${code} is your Smart School verification code. It expires in ${minutes} minutes. Do not share it with anyone.`,
      );
    } catch (err) {
      await this.db
        .update(schema.otpChallenges)
        .set({ deliveryStatus: 'failed', invalidatedAt: sql`now()` })
        .where(eq(schema.otpChallenges.id, challengeId));
      this.logger.error(
        { requestId: meta.requestId, event: 'otp_delivery_failed', to: maskPhone(input.phone) },
        err instanceof Error ? err.message : String(err),
      );
      throw new DomainError(ErrorCode.SERVICE_UNAVAILABLE, 'Phone verification is temporarily unavailable');
    }

    await this.db
      .update(schema.otpChallenges)
      .set({ deliveryStatus: this.sms.kind === 'dev_outbox' ? 'dev_outbox' : 'sent' })
      .where(eq(schema.otpChallenges.id, challengeId));

    return { status: 'accepted', expiresInSeconds: this.config.OTP_TTL_SECONDS };
  }

  async verify(input: { phone: string; code: string; purpose: Purpose }, meta: RequestMeta): Promise<IssuedTokens> {
    this.limiter.hit('otpVerifyPerIp', meta.ip);
    this.limiter.check('otpVerifyFailuresPerPhone', input.phone);

    // The attempt counter must commit even on failure, so failures are returned, not thrown.
    const outcome = await this.db.transaction((tx) => this.verifyInTransaction(tx, input, meta));

    if (outcome.kind === 'invalid') {
      this.limiter.hit('otpVerifyFailuresPerPhone', input.phone);
      throw invalidCode();
    }
    this.limiter.reset('otpVerifyFailuresPerPhone', input.phone);
    return this.sessions.issueTokens(outcome.userId, outcome.sessionId, outcome.refreshToken, outcome.expiresAt);
  }

  private async verifyInTransaction(
    tx: Transaction,
    input: { phone: string; code: string; purpose: Purpose },
    meta: RequestMeta,
  ): Promise<VerifyOutcome> {
    const [challenge] = await tx
      .select({
        id: schema.otpChallenges.id,
        codeHmac: schema.otpChallenges.codeHmac,
        attempts: schema.otpChallenges.attempts,
        maxAttempts: schema.otpChallenges.maxAttempts,
        expired: sql<boolean>`${schema.otpChallenges.expiresAt} <= now()`,
      })
      .from(schema.otpChallenges)
      .where(this.openChallenge(input.phone, input.purpose))
      .for('update');

    if (!challenge) return { kind: 'invalid' };

    if (challenge.expired || challenge.attempts >= challenge.maxAttempts) {
      await tx
        .update(schema.otpChallenges)
        .set({ invalidatedAt: sql`now()` })
        .where(eq(schema.otpChallenges.id, challenge.id));
      return { kind: 'invalid' };
    }

    const attempts = challenge.attempts + 1;
    const matches = timingSafeEqual(challenge.codeHmac, this.mac(challenge.id, input.code));

    if (!matches) {
      await tx
        .update(schema.otpChallenges)
        .set({ attempts, ...(attempts >= challenge.maxAttempts ? { invalidatedAt: sql`now()` } : {}) })
        .where(eq(schema.otpChallenges.id, challenge.id));
      return { kind: 'invalid' };
    }

    await tx
      .update(schema.otpChallenges)
      .set({ attempts, consumedAt: sql`now()` })
      .where(eq(schema.otpChallenges.id, challenge.id));

    const user = await this.findOrCreatePhoneUser(tx, input.phone);
    if (user.status !== 'active') return { kind: 'invalid' };

    const session = await this.sessions.start(tx, user.id);
    await writeAudit(tx, {
      action: 'auth.login_succeeded',
      entityType: 'user_session',
      entityId: session.sessionId,
      actorUserId: user.id,
      requestId: meta.requestId,
      metadata: { method: 'phone_otp', accountCreated: user.created },
    });
    return { kind: 'ok', userId: user.id, ...session };
  }

  /**
   * The account for a verified phone: one per phone number (UNIQUE on the identity subject).
   * Creating it grants nothing — access to any child still requires a school-verified link.
   */
  private async findOrCreatePhoneUser(
    tx: Transaction,
    phone: string,
  ): Promise<{ id: string; status: string; created: boolean }> {
    const [existing] = await tx
      .select({ id: schema.users.id, status: schema.users.status })
      .from(schema.authIdentities)
      .innerJoin(schema.users, eq(schema.users.id, schema.authIdentities.userId))
      .where(and(eq(schema.authIdentities.provider, 'phone_otp'), eq(schema.authIdentities.providerSubject, phone)));
    if (existing) return { ...existing, created: false };

    const [user] = await tx
      .insert(schema.users)
      .values({ phone, displayName: 'Guardian' })
      .returning({ id: schema.users.id, status: schema.users.status });
    await tx.insert(schema.authIdentities).values({ userId: user!.id, provider: 'phone_otp', providerSubject: phone });
    return { ...user!, created: true };
  }

  private openChallenge(phone: string, purpose: Purpose) {
    return and(
      eq(schema.otpChallenges.phone, phone),
      eq(schema.otpChallenges.purpose, purpose),
      isNull(schema.otpChallenges.consumedAt),
      isNull(schema.otpChallenges.invalidatedAt),
    );
  }

  private mac(challengeId: string, code: string): Buffer {
    return createHmac('sha256', this.key).update(`${challengeId}:${code}`).digest();
  }
}
