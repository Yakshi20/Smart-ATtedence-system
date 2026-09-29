import { ErrorCode, httpStatusForErrorCode, notVisible, permissionDenied } from './errors';

test('every error code maps to an HTTP status', () => {
  for (const code of Object.values(ErrorCode)) {
    const status = httpStatusForErrorCode(code);
    expect(typeof status).toBe('number');
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThanOrEqual(599);
  }
});

test('invisible resources surface as 404, never 403 (D-19)', () => {
  const err = notVisible('school');
  expect(err.code).toBe(ErrorCode.NOT_FOUND);
  expect(httpStatusForErrorCode(err.code)).toBe(404);
});

test('permission denial on a visible resource surfaces as 403 (D-19)', () => {
  const err = permissionDenied('publish marks');
  expect(err.code).toBe(ErrorCode.PERMISSION_DENIED);
  expect(httpStatusForErrorCode(err.code)).toBe(403);
});

test('not-found messages interpolate no caller-supplied identifiers', () => {
  // Guards a future refactor from leaking ids into messages, which would let a caller
  // confirm an object exists in another tenant by reading the message back.
  expect(notVisible('school').message).toBe('school not found or not visible to caller');
});

test('DomainError carries field detail only when given', () => {
  expect(notVisible('school').fields).toBeUndefined();
});
