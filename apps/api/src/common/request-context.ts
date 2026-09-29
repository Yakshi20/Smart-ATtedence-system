import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Request ids are held in a WeakMap keyed by the request object rather than assigned as a
 * property via module augmentation. Augmenting `express-serve-static-core` requires that
 * package to be directly resolvable, which it is not under pnpm's isolated node_modules, and
 * a global augmentation would silently widen the Request type for every consumer.
 * Entries are collected with the request, so nothing accumulates.
 */
const requestIds = new WeakMap<Request, string>();

/** Accepted inbound ids: short, and safe to place in a log line. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Assigns a correlation id to every request and echoes it back.
 *
 * An inbound id is honoured so a mobile client's bug report can be traced end to end, but it
 * is length- and character-restricted first: it reaches log output, and unbounded
 * client-controlled text in a log line is a log-injection vector.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header(REQUEST_ID_HEADER);
  const id = inbound !== undefined && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  requestIds.set(req, id);
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

/**
 * Returns the correlation id for a request.
 *
 * Falls back to a marker rather than throwing: an error response must still be produced for a
 * request that failed before the middleware ran.
 */
export function requestIdOf(req: Request): string {
  return requestIds.get(req) ?? 'unassigned';
}
