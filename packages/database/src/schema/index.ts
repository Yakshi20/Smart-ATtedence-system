/**
 * Drizzle schema root. Each slice's tables live in their own module and are re-exported
 * here; the SQL files in migrations/ remain the source of truth for the database itself.
 */
export * from './identity';
export * from './academic';
export * from './guardians';
export * from './attendance';
