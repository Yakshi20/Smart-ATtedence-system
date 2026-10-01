import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { requestIdOf } from './request-context';

export interface RequestMeta {
  requestId: string;
  /** Client address as Express resolves it, honouring TRUST_PROXY. Used as a rate-limit key. */
  ip: string;
}

export const ReqMeta = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { requestId: requestIdOf(req), ip: req.ip ?? 'unknown' };
});
