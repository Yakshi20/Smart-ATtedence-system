import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError, ErrorCode } from '@smart-school/shared';

/**
 * The authenticated caller, established by AuthGuard from a verified access token and a
 * live session row.
 *
 * It carries identity only — no roles, no school ids. Authorization is resolved per request
 * from the database (architecture proposal §3), so a revoked membership is honoured on the
 * very next request rather than when a token expires.
 */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
}

/** Held beside the request rather than on it; see request-context.ts for why. */
const principals = new WeakMap<Request, Principal>();

export function setPrincipal(req: Request, principal: Principal): void {
  principals.set(req, principal);
}

export function principalOf(req: Request): Principal | undefined {
  return principals.get(req);
}

/**
 * Injects the authenticated principal. Throws rather than yielding `undefined`, so a route
 * accidentally marked public cannot silently run with no caller.
 */
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const principal = principalOf(ctx.switchToHttp().getRequest<Request>());
  if (!principal) throw new DomainError(ErrorCode.UNAUTHENTICATED, 'Authentication required');
  return principal;
});

export const IS_PUBLIC = 'smart-school:is-public';

/**
 * Opts a route out of authentication. Every route requires authentication unless it
 * carries this marker (06_API_SPECIFICATION: "All endpoints require authentication unless
 * explicitly marked public"), so forgetting a decorator fails closed.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
