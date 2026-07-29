// Jest configuration is retained for compatibility and issue #208 acceptance.
// The repository's active test runner is Node.js `--test`.
export default {
  testEnvironment: "node",
  transform: {},
  moduleFileExtensions: ["js", "json"],
  verbose: false,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
  ],
  coverageThreshold: {
    global: {
      lines: 80,
    },
  },
};
