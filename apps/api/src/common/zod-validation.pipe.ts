import { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { DomainError, ErrorCode } from '@smart-school/shared';

/**
 * Validates and narrows a request payload at the HTTP boundary.
 *
 * Returns the parsed value, not the input, so unknown keys are stripped rather than passed
 * through to a service. That matters for tenant safety: a client-supplied `schoolId` must
 * never reach a query by riding along in an unvalidated object.
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw new DomainError(
      ErrorCode.VALIDATION_FAILED,
      'Request payload failed validation',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
}
