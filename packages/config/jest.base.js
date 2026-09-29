/**
 * Shared Jest configuration. SWC is used rather than ts-jest because NestJS requires
 * emitDecoratorMetadata, which esbuild-based transformers do not emit.
 */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2023',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/*.test.ts'],
  clearMocks: true,
};
