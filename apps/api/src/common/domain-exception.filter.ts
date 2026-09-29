import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiErrorBody,
  DomainError,
  ErrorCode,
  httpStatusForErrorCode,
} from '@smart-school/shared';
import { requestIdOf } from './request-context';

/**
 * The single place HTTP error responses are produced.
 *
 * Centralized so the 403-vs-404 policy (D-19) cannot drift between modules: an
 * inconsistency there is itself an enumeration oracle, because a caller can compare status
 * codes across tenants to learn whether an object exists.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = requestIdOf(req);

    const { code, message, fields } = this.classify(exception);
    const status = httpStatusForErrorCode(code);

    // Server faults keep their stack in the log; clients never see it.
    if (status >= 500) {
      this.logger.error(
        { requestId, path: req.path, method: req.method, code },
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn({ requestId, path: req.path, method: req.method, code, status });
    }

    const body: ApiErrorBody = {
      error: { code, message, requestId, ...(fields ? { fields } : {}) },
    };
    res.status(status).json(body);
  }

  private classify(exception: unknown): {
    code: ErrorCode;
    message: string;
    fields?: Array<{ path: string; message: string }>;
  } {
    if (exception instanceof DomainError) {
      return {
        code: exception.code,
        message: exception.message,
        ...(exception.fields ? { fields: exception.fields } : {}),
      };
    }

    if (exception instanceof HttpException) {
      return { code: this.codeForStatus(exception.getStatus()), message: exception.message };
    }

    // Anything unrecognized is a bug. Return a generic message so an internal detail —
    // a constraint name, a connection string, a file path — cannot leak to the client.
    return { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred' };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case 400:
        return ErrorCode.VALIDATION_FAILED;
      case 401:
        return ErrorCode.UNAUTHENTICATED;
      case 403:
        return ErrorCode.PERMISSION_DENIED;
      case 404:
        return ErrorCode.NOT_FOUND;
      case 409:
        return ErrorCode.STATE_CONFLICT;
      case 422:
        return ErrorCode.BUSINESS_RULE_VIOLATION;
      case 429:
        return ErrorCode.RATE_LIMITED;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
