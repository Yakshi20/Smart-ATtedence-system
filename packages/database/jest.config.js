const base = require('@smart-school/config/jest.base.js');
module.exports = {
  ...base,
  rootDir: 'src',
  // Isolated databases are created per test file, so files may run in parallel but
  // must not share a worker's module state.
  maxWorkers: 4,
  testTimeout: 30_000,
};
