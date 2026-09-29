import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import { requestIdMiddleware } from './common/request-context';
import type { AppConfig } from './config/env';

/**
 * Builds the application with every cross-cutting concern attached.
 *
 * Shared by `main.ts` and the integration tests so tests exercise the same filter,
 * middleware and pipe stack that production runs — a test against a differently
 * configured app would not prove anything about the real error or authorization behaviour.
 */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), {
    logger: config.LOG_LEVEL === 'debug' ? ['error', 'warn', 'log', 'debug'] : ['error', 'warn'],
  });

  app.use(requestIdMiddleware);
  app.useGlobalFilters(new DomainExceptionFilter());
  // No global ValidationPipe: Nest's pipe is class-validator based, and this project
  // validates with zod via ZodValidationPipe applied per route. Running both would mean two
  // validation libraries and two places for a rule to be missed.
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.enableShutdownHooks();

  return app;
}
