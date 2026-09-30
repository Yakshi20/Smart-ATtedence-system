import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema, type Database, type Executor } from '@smart-school/database';
import { DomainError, ErrorCode } from '@smart-school/shared';
import { writeAudit } from '../audit/audit';
import { CONFIG, type AppConfig } from '../config/env';
import { DATABASE } from '../database/database.module';
import { AccessTokenService } from './access-token.service';
import type { Principal } from './principal';
import { generateOpaqueToken, hashOpaqueToken } from './secrets';

export interface IssuedTokens {
  tokenType: 'Bearer';
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

type RotationOutcome =
  | { kind: 'rotated'; userId: string; sessionId: string; refreshToken: string; expiresAt: Date }
  | { kind: 'unknown' }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'replayed'; userId: string; sessionId: string };

/**
 * Sessions and refresh-token rotation (D-09).
 *
 * - A session is one login. Its `expires_at` is absolute; rotation never extends it.
 * - Each refresh token is single-use. Presenting one rotates it into a successor linked by
 *   `parent_token_id`.
 * - Presenting a token that was already used means two parties hold the lineage — the
 *   legitimate client and whoever copied the token. The server cannot tell which is which, so
 *   it revokes the whole session and both must log in again.
 *
 * There is deliberately no grace window for a client that retries a refresh whose response
 * it lost: that window is exactly the one an attacker racing a stolen token would use. The
 * cost is an occasional forced re-login on a flaky network, recorded in the architecture notes.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly accessTokens: AccessTokenService,
  ) {}

  /** Opens a session and its first refresh token. Runs inside the caller's transaction. */
  async start(tx: Executor, userId: string): Promise<{ sessionId: string; refreshToken: string; expiresAt: Date }> {
    const [session] = await tx
      .insert(schema.userSessions)
      .values({
        userId,
        expiresAt: sql`now() + make_interval(secs => ${this.config.REFRESH_TOKEN_TTL_SECONDS})`,
      })
      .returning({ id: schema.userSessions.id, expiresAt: schema.userSessions.expiresAt });
    if (!session) throw new Error('session insert returned no row');

    const refreshToken = generateOpaqueToken();
    await tx.insert(schema.refreshTokens).values({
      sessionId: session.id,
      tokenHash: hashOpaqueToken(refreshToken),
      expiresAt: session.expiresAt,
    });

    return { sessionId: session.id, refreshToken, expiresAt: session.expiresAt };
  }

  async issueTokens(
    userId: string,
    sessionId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<IssuedTokens> {
    return {
      tokenType: 'Bearer',
      accessToken: await this.accessTokens.issue({ userId, sessionId }),
      accessTokenExpiresIn: this.accessTokens.ttlSeconds,
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  async rotate(presentedToken: string, requestId: string): Promise<IssuedTokens> {
    const outcome = await this.db.transaction((tx) => this.rotateInTransaction(tx, presentedToken, requestId));

    switch (outcome.kind) {
      case 'rotated':
        return this.issueTokens(outcome.userId, outcome.sessionId, outcome.refreshToken, outcome.expiresAt);
      case 'replayed':
        this.logger.warn({
          requestId,
          event: 'refresh_token_reuse',
          userId: outcome.userId,
          sessionId: outcome.sessionId,
        });
        throw new DomainError(ErrorCode.SESSION_REVOKED, 'Session has been revoked');
      case 'revoked':
        throw new DomainError(ErrorCode.SESSION_REVOKED, 'Session has been revoked');
      case 'expired':
        throw new DomainError(ErrorCode.SESSION_EXPIRED, 'Session has expired');
      case 'unknown':
        throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Invalid refresh token');
    }
  }

  /**
   * Returns an outcome rather than throwing for the replay case, because the revocation
   * must commit: throwing inside the transaction would roll it back and leave the stolen
   * lineage alive.
   */
  private async rotateInTransaction(
    tx: Executor,
    presentedToken: string,
    requestId: string,
  ): Promise<RotationOutcome> {
    // Row locks serialize concurrent presentations of the same token: the second waits, then
    // sees `used_at` set and is treated as a replay.
    const [row] = await tx
      .select({
        tokenId: schema.refreshTokens.id,
        usedAt: schema.refreshTokens.usedAt,
        tokenExpired: sql<boolean>`${schema.refreshTokens.expiresAt} <= now()`,
        sessionId: schema.userSessions.id,
        sessionRevokedAt: schema.userSessions.revokedAt,
        sessionExpired: sql<boolean>`${schema.userSessions.expiresAt} <= now()`,
        sessionExpiresAt: schema.userSessions.expiresAt,
        userId: schema.users.id,
        userStatus: schema.users.status,
      })
      .from(schema.refreshTokens)
      .innerJoin(schema.userSessions, eq(schema.userSessions.id, schema.refreshTokens.sessionId))
      .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
      .where(eq(schema.refreshTokens.tokenHash, hashOpaqueToken(presentedToken)))
      .for('update', { of: [schema.refreshTokens, schema.userSessions] });

    if (!row) return { kind: 'unknown' };
    if (row.sessionRevokedAt) return { kind: 'revoked' };

    if (row.usedAt) {
      await this.revokeInTransaction(tx, row.sessionId, 'refresh_token_reuse');
      await writeAudit(tx, {
        action: 'auth.refresh_token_reused',
        entityType: 'user_session',
        entityId: row.sessionId,
        actorUserId: row.userId,
        requestId,
        metadata: { refreshTokenId: row.tokenId },
      });
      return { kind: 'replayed', userId: row.userId, sessionId: row.sessionId };
    }

    if (row.tokenExpired || row.sessionExpired) return { kind: 'expired' };
    if (row.userStatus !== 'active') return { kind: 'revoked' };

    await tx
      .update(schema.refreshTokens)
      .set({ usedAt: sql`now()` })
      .where(eq(schema.refreshTokens.id, row.tokenId));

    const refreshToken = generateOpaqueToken();
    await tx.insert(schema.refreshTokens).values({
      sessionId: row.sessionId,
      parentTokenId: row.tokenId,
      tokenHash: hashOpaqueToken(refreshToken),
      expiresAt: row.sessionExpiresAt,
    });

    return {
      kind: 'rotated',
      userId: row.userId,
      sessionId: row.sessionId,
      refreshToken,
      expiresAt: row.sessionExpiresAt,
    };
  }

  async revoke(principal: Principal, reason: 'logout', requestId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const revoked = await this.revokeInTransaction(tx, principal.sessionId, reason);
      if (revoked) {
        await writeAudit(tx, {
          action: 'auth.logout',
          entityType: 'user_session',
          entityId: principal.sessionId,
          actorUserId: principal.userId,
          requestId,
        });
      }
    });
  }

  private async revokeInTransaction(
    tx: Executor,
    sessionId: string,
    reason: 'logout' | 'refresh_token_reuse',
  ): Promise<boolean> {
    const rows = await tx
      .update(schema.userSessions)
      .set({ revokedAt: sql`now()`, revokeReason: reason })
      .where(and(eq(schema.userSessions.id, sessionId), isNull(schema.userSessions.revokedAt)))
      .returning({ id: schema.userSessions.id });
    return rows.length > 0;
  }

  /**
   * Resolves the caller for one request. A single indexed lookup, run on every
   * authenticated request, so that logout, replay revocation and a disabled account take
   * effect immediately rather than when the access token expires.
   */
  async resolvePrincipal(userId: string, sessionId: string): Promise<Principal | null> {
    const [row] = await this.db
      .select({ sessionId: schema.userSessions.id })
      .from(schema.userSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
      .where(
        and(
          eq(schema.userSessions.id, sessionId),
          eq(schema.userSessions.userId, userId),
          isNull(schema.userSessions.revokedAt),
          gt(schema.userSessions.expiresAt, sql`now()`),
          eq(schema.users.status, 'active'),
        ),
      );
    return row ? { userId, sessionId } : null;
  }
}
