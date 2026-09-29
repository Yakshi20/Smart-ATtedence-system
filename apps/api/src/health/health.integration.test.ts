import request from 'supertest';
import { createTestApp, type TestApp } from '../testing/app-harness';
import { REQUEST_ID_HEADER } from '../common/request-context';

let harness: TestApp;

beforeAll(async () => {
  harness = await createTestApp('health');
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

test('reports ok with a live database', async () => {
  const res = await request(harness.app.getHttpServer()).get('/health');

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: 'ok', checks: { database: 'up' } });
});

test('health is outside the versioned prefix', async () => {
  await request(harness.app.getHttpServer()).get('/health').expect(200);
  await request(harness.app.getHttpServer()).get('/api/v1/health').expect(404);
});

test('assigns a request id and echoes it back', async () => {
  const res = await request(harness.app.getHttpServer()).get('/health');
  expect(res.headers[REQUEST_ID_HEADER]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test('honours a well-formed inbound request id', async () => {
  const res = await request(harness.app.getHttpServer())
    .get('/health')
    .set(REQUEST_ID_HEADER, 'mobile-abc123');
  expect(res.headers[REQUEST_ID_HEADER]).toBe('mobile-abc123');
});

test('replaces an over-long inbound request id', async () => {
  const oversized = 'a'.repeat(200);
  const res = await request(harness.app.getHttpServer())
    .get('/health')
    .set(REQUEST_ID_HEADER, oversized);

  expect(res.headers[REQUEST_ID_HEADER]).not.toBe(oversized);
  expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
});

test('replaces an inbound request id containing disallowed characters', async () => {
  // Control characters cannot be tested here: Node's HTTP client refuses to transmit them,
  // so those vectors are covered in request-context.test.ts. Spaces and punctuation are
  // legal in a header value and do reach the server.
  const res = await request(harness.app.getHttpServer())
    .get('/health')
    .set(REQUEST_ID_HEADER, 'id with spaces; and=punctuation');

  expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
});

test('an unknown route returns the standard error envelope with no stack trace', async () => {
  const res = await request(harness.app.getHttpServer()).get('/api/v1/does-not-exist');

  expect(res.status).toBe(404);
  expect(res.body.error.code).toBe('NOT_FOUND');
  expect(res.body.error.requestId).toBeTruthy();
  expect(JSON.stringify(res.body)).not.toMatch(/at \/|node_modules|postgresql:\/\//);
});
