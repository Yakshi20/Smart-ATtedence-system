import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { isUniqueViolation, schema, type Database } from '@smart-school/database';
import { DomainError, ErrorCode, type LoginInput } from '@smart-school/shared';
import { writeAudit } from '../audit/audit';
import { RateLimiter } from '../common/rate-limiter';
import type { RequestMeta } from '../common/request-meta';
import { DATABASE } from '../database/database.module';
import { dummyPasswordHash, hashOpaqueToken, hashPassword, verifyPassword } from './secrets';
import { SessionService, type IssuedTokens } from './session.service';

/**
 * One response for every login failure: unknown email, wrong password, account not yet
 * activated, account disabled. Distinguishing them would let anyone test which emails have
 * accounts (02 §5: identifiers must not enable account enumeration).
 */
const invalidCredentials = () => new DomainError(ErrorCode.UNAUTHENTICATED, 'Invalid credentials');

const invalidToken = () =>
  new DomainError(ErrorCode.INVALID_OR_EXPIRED_TOKEN, 'Token is invalid or has expired');

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiter,
  ) {}

  async login(input: LoginInput, meta: RequestMeta): Promise<IssuedTokens> {
    this.limiter.hit('loginPerIp', meta.ip);
    this.limiter.check('loginFailuresPerIdentifier', input.email);

    const [candidate] = await this.db
      .select({
        userId: schema.users.id,
        status: schema.users.status,
        secretHash: schema.authIdentities.secretHash,
      })
      .from(schema.authIdentities)
      .innerJoin(schema.users, eq(schema.users.id, schema.authIdentities.userId))
      .where(
        and(
          eq(schema.authIdentities.provider, 'staff_password'),
          eq(schema.authIdentities.providerSubject, input.email),
        ),
      );

    // Always run exactly one argon2 verification, against a dummy hash when there is no
    // account, so response time does not reveal whether the email exists.
    const passwordMatches = await verifyPassword(
      candidate?.secretHash ?? (await dummyPasswordHash()),
      input.password,
    );

    if (!candidate || !passwordMatches || candidate.status !== 'active') {
      this.limiter.hit('loginFailuresPerIdentifier', input.email);
      if (candidate) {
        // Recorded only for a known account: logging arbitrary submitted emails would store
        // personal data about people who have no relationship with the platform.
        await writeAudit(this.db, {
          action: 'auth.login_failed',
          entityType: 'user',
          entityId: candidate.userId,
          actorUserId: candidate.userId,
          requestId: meta.requestId,
        });
      }
      throw invalidCredentials();
    }

    this.limiter.reset('loginFailuresPerIdentifier', input.email);

    const started = await this.db.transaction(async (tx) => {
      const session = await this.sessions.start(tx, candidate.userId);
      await writeAudit(tx, {
        action: 'auth.login_succeeded',
        entityType: 'user_session',
        entityId: session.sessionId,
        actorUserId: candidate.userId,
        requestId: meta.requestId,
        metadata: { method: input.method },
      });
      return session;
    });

    return this.sessions.issueTokens(candidate.userId, started.sessionId, started.refreshToken, started.expiresAt);
  }

  async refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedTokens> {
    this.limiter.hit('refreshPerIp', meta.ip);
    return this.sessions.rotate(refreshToken, meta.requestId);
  }

  /**
   * Sets a staff member's first password from a single-use activation token. Unknown,
   * used and expired tokens share one error, so a token cannot be probed for state.
   */
  async activate(input: { token: string; password: string }, meta: RequestMeta): Promise<void> {
    this.limiter.hit('activationPerIp', meta.ip);

    // Hash before opening the transaction: argon2 is deliberately slow and must not hold
    // row locks while it runs.
    const secretHash = await hashPassword(input.password);

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          tokenId: schema.accountActivationTokens.id,
          userId: schema.users.id,
          email: schema.users.email,
          userStatus: schema.users.status,
        })
        .from(schema.accountActivationTokens)
        .innerJoin(schema.users, eq(schema.users.id, schema.accountActivationTokens.userId))
        .where(
          and(
            eq(schema.accountActivationTokens.tokenHash, hashOpaqueToken(input.token)),
            isNull(schema.accountActivationTokens.usedAt),
            sql`${schema.accountActivationTokens.expiresAt} > now()`,
          ),
        )
        .for('update', { of: schema.accountActivationTokens });

      if (!row?.email || row.userStatus !== 'active') throw invalidToken();

      // Consume every outstanding token for the user, not only this one.
      await tx
        .update(schema.accountActivationTokens)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(schema.accountActivationTokens.userId, row.userId),
            isNull(schema.accountActivationTokens.usedAt),
          ),
        );

      try {
        await tx.insert(schema.authIdentities).values({
          userId: row.userId,
          provider: 'staff_password',
          providerSubject: row.email,
          secretHash,
        });
      } catch (err) {
        // Already activated: a token must not become a password-reset path.
        if (isUniqueViolation(err)) throw invalidToken();
        throw err;
      }

      await writeAudit(tx, {
        action: 'account.activated',
        entityType: 'user',
        entityId: row.userId,
        actorUserId: row.userId,
        requestId: meta.requestId,
      });
    });
  }
}
