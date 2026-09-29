import { z } from 'zod';
import { DomainError, ErrorCode } from '@smart-school/shared';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({ name: z.string().min(1), grade: z.coerce.number().int().min(1).max(7) });

test('returns the parsed value with coercion applied', () => {
  const pipe = new ZodValidationPipe(schema);
  expect(pipe.transform({ name: 'Anitha', grade: '5' })).toEqual({ name: 'Anitha', grade: 5 });
});

test('strips unknown keys instead of passing them through', () => {
  // A client-supplied schoolId must not reach a service by riding along on the payload.
  const pipe = new ZodValidationPipe(schema);
  const out = pipe.transform({ name: 'Anitha', grade: 5, schoolId: 'other-school' });
  expect(out).toEqual({ name: 'Anitha', grade: 5 });
  expect('schoolId' in out).toBe(false);
});

test('raises VALIDATION_FAILED with field paths', () => {
  const pipe = new ZodValidationPipe(schema);
  try {
    pipe.transform({ name: '', grade: 99 });
    throw new Error('expected transform to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    const domain = err as DomainError;
    expect(domain.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(domain.fields?.map((f) => f.path).sort()).toEqual(['grade', 'name']);
  }
});
