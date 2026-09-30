import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError, ErrorCode } from '@smart-school/shared';
import { AccessTokenService } from './access-token.service';
import { IS_PUBLIC, setPrincipal } from './principal';
import { SessionService } from './session.service';

/**
 * Global, default-deny authentication. Registered as APP_GUARD, so a new route is protected
 * unless it is explicitly marked @Public().
 *
 * Establishes identity only. Whether the caller may act on a given school is decided by
 * SchoolAccessService/PlatformAccessService at the point of use, against the resource.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header('authorization');
    const match = header ? /^Bearer ([A-Za-z0-9._-]{1,2048})$/.exec(header) : null;
    if (!match?.[1]) throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Authentication required');

    const claims = await this.accessTokens.verify(match[1]);
    const principal = await this.sessions.resolvePrincipal(claims.userId, claims.sessionId);
    if (!principal) throw new DomainError(ErrorCode.SESSION_REVOKED, 'Session is no longer valid');

    setPrincipal(req, principal);
    return true;
  }
}
