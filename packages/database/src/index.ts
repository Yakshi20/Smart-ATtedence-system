export * from './client';
export * from './migrator';
export * as schema from './schema';

/**
 * Test helpers are exported from the package root rather than a `./testing` subpath because
 * this is an unpublished workspace package compiled with CommonJS/Node resolution, where a
 * subpath export map is not honoured. They are inert unless TEST_DATABASE_ADMIN_URL is set,
 * which no deployed environment defines.
 */
export * from './testing/test-database';
