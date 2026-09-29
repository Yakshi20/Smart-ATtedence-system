import { Controller, Get, Inject } from '@nestjs/common';
import type { DatabaseHandle } from '@smart-school/database';
import { DATABASE_HANDLE } from '../database/database.module';

interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: { database: 'up' | 'down' };
}

@Controller()
export class HealthController {
  constructor(@Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle) {}

  /**
   * Liveness plus a real dependency probe.
   *
   * Returns 200 with `degraded` rather than a 5xx when the database is unreachable, so an
   * orchestrator's readiness check and a human's diagnostic both get a usable answer.
   * Deliberately unauthenticated and deliberately free of version or schema detail.
   */
  @Get('health')
  async health(): Promise<HealthResponse> {
    try {
      await this.database.pool.query('SELECT 1');
      return { status: 'ok', checks: { database: 'up' } };
    } catch {
      return { status: 'degraded', checks: { database: 'down' } };
    }
  }
}
