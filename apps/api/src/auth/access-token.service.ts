import { Inject, Injectable } from '@nestjs/common';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { DomainError, ErrorCode } from '@smart-school/shared';
import { CONFIG, type AppConfig } from '../config/env';

const ISSUER = 'smart-school-api';
const AUDIENCE = 'smart-school';

const ClaimsSchema = z.object({ sub: z.uuid(), sid: z.uuid() });

export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

/**
 * Short-lived HS256 access tokens carrying only `sub` and `sid` (architecture proposal §3).
 *
 * A token proves identity and names a session; it grants nothing by itself. AuthGuard
 * re-checks the session row on every request, so logout and replay-revocation are immediate
 * even though the token would otherwise remain valid until `exp`.
 */
@Injectable()
export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.key = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
  }

  get ttlSeconds(): number {
    return this.config.ACCESS_TOKEN_TTL_SECONDS;
  }

  async issue(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    let payload: unknown;
    try {
      // The algorithm is pinned: a token claiming `alg: none` or an asymmetric algorithm is
      // rejected rather than negotiated.
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new DomainError(ErrorCode.ACCESS_TOKEN_EXPIRED, 'Access token expired');
      }
      throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
    }

    const claims = ClaimsSchema.safeParse(payload);
    if (!claims.success) throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
    return { userId: claims.data.sub, sessionId: claims.data.sid };
  }
}
