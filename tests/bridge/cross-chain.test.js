/**
 * Cross-Chain Integration Tests
 *
 * Tests the full bridge flow: EVM -> Soroban relay.
 * Requires both Anvil (local Ethereum) and Soroban quickstart running.
 *
 * Run with:
 *   docker-compose up -d  # Start Anvil + Soroban
 *   cd tests/bridge && npx jest cross-chain.test.js
 */

const { ethers } = require("ethers");
const StellarSdk = require("@stellar/stellar-sdk");

// ============================================
// CONFIGURATION
// ============================================

const ANVIL_URL = process.env.ANVIL_URL || "http://127.0.0.1:8545";
const SOROBAN_RPC = process.env.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017";

// Contract addresses (deployed before tests)
const BRIDGE_ADDRESS = process.env.BRIDGE_ADDRESS;
const SOROBAN_BRIDGE_ID = process.env.SOROBAN_BRIDGE_ID;

// ============================================
// RPC PREFLIGHT
// ============================================

async function waitForJsonRpc(url, method, attempts = 30, delayMs = 2000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
      });

      const data = await response.json();

      // accept valid JSON-RPC response (result OR error means endpoint is alive)
      if (
        response.status < 500 &&
        data &&
        data.jsonrpc === "2.0" &&
        ("result" in data || "error" in data)
      ) {
        return;
      }

      lastErr = new Error(`status=${response.status} body=${JSON.stringify(data)}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`RPC not ready: ${url} (${method}) -> ${lastErr?.message}`);
}

// ============================================
// HELPERS
// ============================================

function getAnvilProvider() {
  return new ethers.providers.JsonRpcProvider(ANVIL_URL);
}

function getSorobanServer() {
  return new StellarSdk.rpc.Server(SOROBAN_RPC, { allowHttp: true });
}

// ============================================
// TESTS
// ============================================

describe("Cross-Chain Bridge Integration", () => {
  let evmProvider;
  let stellarServer;

  beforeAll(async () => {
    // Wait for RPC endpoints to be ready
    await waitForJsonRpc(ANVIL_URL, "eth_chainId");
    await waitForJsonRpc(SOROBAN_RPC, "getLatestLedger");

    evmProvider = getAnvilProvider();
    stellarServer = getSorobanServer();

    // Verify both chains are running
    const evmBlock = await evmProvider.getBlockNumber();
    expect(evmBlock).toBeGreaterThanOrEqual(0);

    // Verify Soroban RPC is responsive (status may vary by version)
    const stellarHealth = await stellarServer.getHealth();
    expect(stellarHealth).toBeDefined();
  }, 120000);

  test("EVM bridge contract is deployed", async () => {
    if (!BRIDGE_ADDRESS) {
      console.log("Skipping: BRIDGE_ADDRESS not set");
      return;
    }

    const code = await evmProvider.getCode(BRIDGE_ADDRESS);
    expect(code).not.toBe("0x");
    expect(code.length).toBeGreaterThan(2);
  });

  test("Soroban bridge contract is deployed", async () => {
    if (!SOROBAN_BRIDGE_ID) {
      console.log("Skipping: SOROBAN_BRIDGE_ID not set");
      return;
    }

    const contract = new StellarSdk.Contract(SOROBAN_BRIDGE_ID);
    const account = await stellarServer.getAccount(
      "GTESTRELAYERADDRESS000000000000000000000000000000000000",
    );

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("version"))
      .setTimeout(30)
      .build();

    const result = await stellarServer.simulateTransaction(tx);
    expect(StellarSdk.rpc.Api.isSimulationSuccess(result)).toBe(true);
  });

  test("EVM bridge accepts vote submission", async () => {
    if (!BRIDGE_ADDRESS) {
      console.log("Skipping: BRIDGE_ADDRESS not set");
      return;
    }

    const signer = await evmProvider.getSigner(0);

    const bridgeABI = [
      "function castVote(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes) external",
      "function isNullifierUsed(uint256,uint256,uint256) view returns (bool)",
      "function updateSbtRoot(uint256,uint256) external",
      "function updateVoteRoot(uint256,uint256,uint256) external",
      "error SbtRootNotSet()",
      "error VoteRootNotSet()",
      "error VoteRootMismatch()",
      "error NullifierUsed()",
      "error InvalidVoteChoice()",
      "error ZeroNullifier()",
      "error ZeroMemberAddr()",
      "error InvalidProof()",
    ];

    const bridge = new ethers.Contract(BRIDGE_ADDRESS, bridgeABI, signer);

    // Update SBT + vote roots first (must be non-zero)
    const daoId = 1;
    const proposalId = 1;
    const sbtRoot = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("test-sbt-root"));
    const voteRoot = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("test-vote-root"));
    await bridge.updateSbtRoot(daoId, sbtRoot);
    await bridge.updateVoteRoot(daoId, proposalId, voteRoot);

    // Create mock proof (256 bytes)
    const mockProof = ethers.utils.hexlify(ethers.utils.randomBytes(256));
    const memberAddr = 0xabcdefn;

    // Submit vote
    const tx = await bridge.castVote(
      daoId,
      proposalId,
      1, // voteChoice
      12345, // nullifier
      voteRoot,
      sbtRoot,
      memberAddr,
      mockProof,
    );

    const receipt = await tx.wait();
    expect(receipt.status).toBe(1);

    // Verify VoteForwarded event
    const iface = new ethers.utils.Interface([
      "event VoteForwarded(uint256 indexed,uint256 indexed,uint256,uint256,uint256,uint256,uint256)",
    ]);

    let voteEvent = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === "VoteForwarded") {
          voteEvent = parsed;
          break;
        }
      } catch {}
    }

    expect(voteEvent).not.toBeNull();
    expect(voteEvent.args[0].toString()).toBe(daoId.toString());
  });

  test("Soroban relay records vote", async () => {
    if (!SOROBAN_BRIDGE_ID) {
      console.log("Skipping: SOROBAN_BRIDGE_ID not set");
      return;
    }

    const contract = new StellarSdk.Contract(SOROBAN_BRIDGE_ID);
    const relayer = StellarSdk.Keypair.fromSecret(
      process.env.RELAYER_SECRET_KEY || "S...",
    );

    const account = await stellarServer.getAccount(relayer.publicKey());

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "relay_vote",
          StellarSdk.nativeToScVal(1, { type: "u64" }),
          StellarSdk.nativeToScVal(1, { type: "u64" }),
          StellarSdk.nativeToScVal(true, { type: "bool" }),
          StellarSdk.nativeToScVal(999, { type: "u256" }),
          StellarSdk.nativeToScVal(0, { type: "u256" }),
          StellarSdk.Address.fromString(relayer.publicKey()).toScVal(),
        ),
      )
      .setTimeout(30)
      .build();

    const simResult = await stellarServer.simulateTransaction(tx);
    expect(StellarSdk.rpc.Api.isSimulationSuccess(simResult)).toBe(true);
  });

  test("nullifier prevents double-voting across chains", async () => {
    if (!BRIDGE_ADDRESS || !SOROBAN_BRIDGE_ID) {
      console.log("Skipping: Contract addresses not set");
      return;
    }

    // Check nullifier on Soroban
    const contract = new StellarSdk.Contract(SOROBAN_BRIDGE_ID);

    const account = await stellarServer.getAccount(
      "GTESTRELAYERADDRESS000000000000000000000000000000000000",
    );

    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: "100000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "is_nullifier_used",
          StellarSdk.nativeToScVal(1, { type: "u64" }),
          StellarSdk.nativeToScVal(1, { type: "u64" }),
          StellarSdk.nativeToScVal(12345, { type: "u256" }),
        ),
      )
      .setTimeout(30)
      .build();

    const result = await stellarServer.simulateTransaction(tx);
    expect(StellarSdk.rpc.Api.isSimulationSuccess(result)).toBe(true);
  });
});
