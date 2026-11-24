const fs = require('fs');
const path = require('path');

describe('tree depth alignment guardrails', () => {
  test('membership-tree max depth matches the vote circuit main depth', () => {
    const contractPath = path.join(__dirname, '../contracts/membership-tree/src/lib.rs');
    const circuitPath = path.join(__dirname, 'vote.circom');

    const contractSource = fs.readFileSync(contractPath, 'utf8');
    const circuitSource = fs.readFileSync(circuitPath, 'utf8');

    const contractMatch = contractSource.match(/const MAX_TREE_DEPTH: u32 = (\d+);/);
    expect(contractMatch).not.toBeNull();

    const circuitMatch = circuitSource.match(/component main \{public \[root, nullifier, daoId, proposalId, voteChoice\]\} = Vote\((\d+)\);/);
    expect(circuitMatch).not.toBeNull();

    const contractDepth = Number(contractMatch[1]);
    const circuitDepth = Number(circuitMatch[1]);

    expect(contractDepth).toBe(circuitDepth);
    expect(contractDepth).toBeGreaterThan(0);
  });
});
