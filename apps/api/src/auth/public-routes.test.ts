import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod, type Type } from '@nestjs/common';
import { AppModule } from '../app.module';
import { loadConfig } from '../config/env';
import { LoggingAccountNotifier } from './account-notifier';
import { IS_PUBLIC } from './principal';

/**
 * Every route is authenticated unless marked @Public(). This inventory fails when a route
 * becomes public, so widening the unauthenticated surface is always a deliberate, reviewed
 * change to this list rather than a side effect.
 */
const EXPECTED_PUBLIC = [
  'GET /health',
  'POST /auth/login',
  'POST /auth/otp/request',
  'POST /auth/otp/verify',
  'POST /auth/refresh',
  'POST /auth/staff/activate',
  'POST /schools/registration-requests',
].sort();

function routesOf(controller: Type): Array<{ route: string; isPublic: boolean }> {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const classPublic = Reflect.getMetadata(IS_PUBLIC, controller) === true;
  const proto = controller.prototype as Record<string, unknown>;

  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .map((name) => proto[name] as object)
    .filter((handler) => Reflect.getMetadata(PATH_METADATA, handler) !== undefined)
    .map((handler) => {
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
      const path = [base, String(Reflect.getMetadata(PATH_METADATA, handler))]
        .map((p) => p.replace(/^\/|\/$/g, ''))
        .filter(Boolean)
        .join('/');
      return {
        route: `${method} /${path}`,
        isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC, handler) === true,
      };
    });
}

test('only the expected routes are public', () => {
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused', JWT_ACCESS_SECRET: 'x'.repeat(32) });
  const modules = (AppModule.register(config).imports ?? []) as Type[];
  const controllers = modules.flatMap((m) => (Reflect.getMetadata('controllers', m) ?? []) as Type[]);
  const routes = controllers.flatMap(routesOf);

  expect(routes.length).toBeGreaterThan(EXPECTED_PUBLIC.length);
  expect(routes.filter((r) => r.isPublic).map((r) => r.route).sort()).toEqual(EXPECTED_PUBLIC);
});

test('the logging notifier refuses to run in production', () => {
  expect(() => new LoggingAccountNotifier('production')).toThrow(/must not run in production/);
  expect(() => new LoggingAccountNotifier('development')).not.toThrow();
});
