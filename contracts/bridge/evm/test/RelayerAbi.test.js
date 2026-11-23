const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * The backend relayer reads Bridge.sol over raw JSON-RPC with hard-coded
 * topic and selector constants (backend/src/services/bridge-evm.ts). This
 * pins them to the compiled ABI, so an event or view-function change fails
 * here instead of silently stopping cross-chain relays (#887).
 */
const RELAYER = path.join(__dirname, "../../../../backend/src/services/bridge-evm.ts");

function relayerConstant(pattern) {
  const match = fs.readFileSync(RELAYER, "utf8").match(pattern);
  if (!match) throw new Error(`constant not found in ${RELAYER}: ${pattern}`);
  return match[1].toLowerCase();
}

describe("Relayer ABI contract (#887)", function () {
  let bridge;

  before(async function () {
    const verifier = await (await ethers.getContractFactory("MockVerifier")).deploy();
    bridge = await (await ethers.getContractFactory("Bridge")).deploy(await verifier.getAddress(), 1n);
  });

  it("VoteForwarded topic matches the relayer's filter", function () {
    const topic = relayerConstant(/VOTE_FORWARDED_TOPIC\s*=\s*"(0x[0-9a-fA-F]{64})"/);
    expect(bridge.interface.getEvent("VoteForwarded").topicHash).to.equal(topic);
  });

  it("VoteForwarded indexes daoId and proposalId and carries five data words, as the relayer decodes", function () {
    const inputs = bridge.interface.getEvent("VoteForwarded").inputs;
    expect(inputs.map((i) => [i.name, i.type, i.indexed])).to.deep.equal([
      ["daoId", "uint256", true],
      ["proposalId", "uint256", true],
      ["nullifier", "uint256", false],
      ["voteChoice", "uint256", false],
      ["voteRoot", "uint256", false],
      ["memberAddr", "uint256", false],
      ["chainId", "uint256", false],
    ]);
  });

  it("view selectors match the relayer's root reads", function () {
    for (const name of ["getSbtRoot", "getVoteRoot", "sbtRootBlock"]) {
      const selector = relayerConstant(new RegExp(`${name}:\\s*"(0x[0-9a-fA-F]{8})"`));
      expect(bridge.interface.getFunction(name).selector).to.equal(selector);
    }
  });

  it("Bridge calls the verifier through IGroth16Verifier with the circuit's 9 public signals", async function () {
    const iface = (await ethers.getContractFactory("MockVerifier")).interface;
    const fn = iface.getFunction("verifyProof");
    expect(fn.inputs.map((i) => i.type)).to.deep.equal(["uint256[2]", "uint256[2][2]", "uint256[2]", "uint256[9]"]);
    const circuit = fs.readFileSync(path.join(__dirname, "../../../../circuits/bridge.circom"), "utf8");
    const publics = circuit.match(/component main\s*\{\s*public\s*\[([^\]]+)\]/)[1].split(",").map((s) => s.trim());
    expect(publics).to.have.length(9);
  });
});
