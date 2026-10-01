/**
 * Stable, machine-readable error codes.
 *
 * Clients localize these; the API never returns translated prose (see D-20).
 * Codes are part of the public API contract — rename only with a version bump.
 */
export const ErrorCode = {
  // 400 / 422
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** A one-time token (activation, reset) that is unknown, used or expired — deliberately not distinguished. */
  INVALID_OR_EXPIRED_TOKEN: 'INVALID_OR_EXPIRED_TOKEN',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',

  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** The access token expired; the client should refresh and retry. */
  ACCESS_TOKEN_EXPIRED: 'ACCESS_TOKEN_EXPIRED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',

  // 403 — the caller may see the resource but not perform this action
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  // 404 — the caller may not see the resource at all, or it does not exist.
  // Deliberately indistinguishable: see D-19.
  NOT_FOUND: 'NOT_FOUND',

  // 409
  STATE_CONFLICT: 'STATE_CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  /** An idempotency key was reused with a different payload. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',

  // 500
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // 503 — a dependency (e.g. SMS delivery) is not configured or failed. Never used to signal
  // anything about the caller's input, so it cannot leak whether an account exists.
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** The only error shape the API emits. No stack traces, storage keys or unrelated records. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** Non-localized, for logs and developers. Never shown verbatim to end users. */
    message: string;
    /** Correlates a client report with server logs. */
    requestId: string;
    /** Field-level detail, only for VALIDATION_FAILED. */
    fields?: Array<{ path: string; message: string }>;
  };
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  INVALID_OR_EXPIRED_TOKEN: 400,
  BUSINESS_RULE_VIOLATION: 422,
  UNAUTHENTICATED: 401,
  ACCESS_TOKEN_EXPIRED: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  STATE_CONFLICT: 409,
  DUPLICATE_RESOURCE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

export function httpStatusForErrorCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * Domain-level error carrying a code rather than an HTTP status, so services stay
 * transport-agnostic and the mapping lives in exactly one place.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * Raised when a caller has no visibility of a resource.
 *
 * Always surfaces as 404, never 403, so that an object's existence cannot be probed by
 * comparing status codes across tenants (D-19).
 */
export function notVisible(resource: string): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, `${resource} not found or not visible to caller`);
}

/** Raised when the caller can see the resource but lacks permission for this action. */
export function permissionDenied(action: string): DomainError {
  return new DomainError(ErrorCode.PERMISSION_DENIED, `Not permitted to ${action}`);
}

/** Raised when a rate limit is exceeded. Carries the wait so the API can send `Retry-After`. */
export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super(ErrorCode.RATE_LIMITED, 'Too many requests; try again later');
    this.name = 'RateLimitedError';
  }
}
