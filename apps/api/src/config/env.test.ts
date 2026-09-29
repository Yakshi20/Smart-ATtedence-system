import { ConfigError, loadConfig } from './env';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

test('applies documented defaults', () => {
  const config = loadConfig(valid);
  expect(config.NODE_ENV).toBe('development');
  expect(config.API_PORT).toBe(3000);
  expect(config.ACCESS_TOKEN_TTL_SECONDS).toBe(600);
});

test('rejects a missing DATABASE_URL', () => {
  expect(() => loadConfig({ JWT_ACCESS_SECRET: 'x'.repeat(32) })).toThrow(ConfigError);
});

test('rejects a short JWT secret rather than accepting a weak one', () => {
  expect(() => loadConfig({ ...valid, JWT_ACCESS_SECRET: 'tooshort' })).toThrow(
    /at least 32 characters/,
  );
});

test('reports every problem at once so an operator fixes them in one pass', () => {
  try {
    loadConfig({ JWT_ACCESS_SECRET: 'short', API_PORT: '99999' });
    throw new Error('expected loadConfig to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as Error).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).toContain('API_PORT');
  }
});

test('the resulting config is frozen', () => {
  const config = loadConfig(valid);
  expect(() => {
    (config as { API_PORT: number }).API_PORT = 1;
  }).toThrow();
});
