const base = require('@smart-school/config/jest.base.js');
module.exports = {
  ...base,
  rootDir: 'src',
  testTimeout: 30_000,
  // Each integration test file provisions its own database; limit concurrency so a
  // developer laptop is not opening dozens of Postgres connections at once.
  maxWorkers: 2,
};
