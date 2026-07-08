module.exports = {
  // Run tests in a single process to avoid BigInt serialization issues
  // between Jest workers
  maxWorkers: 1,
  testEnvironment: 'node',
  // Exclude files that use node:test (not Jest) or require missing fixtures
  testPathIgnorePatterns: [
    '/node_modules/',
    '/utils/test/',       // Uses node:test, not Jest
    'regression.test.js', // Requires proof fixture files
  ],
};
