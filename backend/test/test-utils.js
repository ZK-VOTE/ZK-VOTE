/**
 * Shared test helpers.
 *
 * createTestApp() boots the real relayer Express app (src/index.ts) against a
 * test-mode configuration and returns { app, config } for supertest. Importing
 * index.ts is safe: it only starts listening when run as the main module.
 */

export async function createTestApp() {
  process.env.RELAYER_SECRET_KEY =
    "SCVZXEUXJLRZKPCUXGXN53BJTD3RAZPRSSXHXDGSZQH5EOGEUTWINUXF";
  process.env.VOTING_CONTRACT_ID = "C".padEnd(56, "A");
  process.env.TREE_CONTRACT_ID = "C".padEnd(56, "B");
  process.env.COMMENTS_CONTRACT_ID = "C".padEnd(56, "C");
  process.env.SOROBAN_RPC_URL = "http://localhost";
  process.env.CORS_ORIGIN = "http://localhost";
  process.env.NETWORK_PASSPHRASE = "Test";
  process.env.RELAYER_AUTH_TOKEN = "testtoken";
  process.env.HEALTH_EXPOSE_DETAILS = "true";
  process.env.RELAYER_TEST_MODE = "true";

  // Import config lazily (after env vars are set) so it reflects the values
  // above rather than whatever .env.development provided.
  const [{ config }, relayer] = await Promise.all([
    import("../src/config.js"),
    import("../src/index.ts"),
  ]);

  return { app: relayer.app || relayer.default || relayer, config };
}
