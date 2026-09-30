/**
 * PostgreSQL error classification.
 *
 * Drizzle wraps driver errors, so the PostgreSQL error with its SQLSTATE may sit anywhere
 * in the `cause` chain. Callers match on SQLSTATE and constraint name — never on message
 * text, which is localized by the server and changes between versions.
 */
interface PgErrorShape {
  code: string;
  constraint?: string;
}

function isPgErrorShape(value: unknown): value is PgErrorShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((value as { code: string }).code)
  );
}

export function pgErrorOf(err: unknown): PgErrorShape | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (isPgErrorShape(current)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export const SqlState = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
} as const;

const UNIQUE_VIOLATION = SqlState.UNIQUE_VIOLATION;

/** True when `err` is a unique violation, optionally of one named constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = pgErrorOf(err);
  if (pg?.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}

function matches(err: unknown, sqlState: string, constraint?: string): boolean {
  const pg = pgErrorOf(err);
  if (pg?.code !== sqlState) return false;
  return constraint === undefined || pg.constraint === constraint;
}

/** True when `err` violates an EXCLUDE constraint (e.g. overlapping date ranges). */
export function isExclusionViolation(err: unknown, constraint?: string): boolean {
  return matches(err, SqlState.EXCLUSION_VIOLATION, constraint);
}

export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  return matches(err, SqlState.FOREIGN_KEY_VIOLATION, constraint);
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  return matches(err, SqlState.CHECK_VIOLATION, constraint);
}

/** The violated constraint's name, when the error is a constraint violation. */
export function violatedConstraint(err: unknown): string | undefined {
  return pgErrorOf(err)?.constraint;
}
