/**
 * Dependency-surface interfaces for the ZKVote backend (#358).
 *
 * Services should depend on these ports — never on concrete global module
 * instances. The composition root (`src/composition-root.ts`) is the single
 * place that constructs the concrete implementations and wires them into the
 * services at startup.
 *
 * These types are *structural*: any mock or real implementation with the same
 * shape satisfies them, which is what makes the refactored services unit-
 * testable with mocks.
 */
export {};
//# sourceMappingURL=interfaces.js.map