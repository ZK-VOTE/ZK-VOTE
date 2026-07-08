#!/usr/bin/env node
/**
 * Generate a Groth16 proof for local quickstart:future testing.
 * Uses the actual on-chain merkle path.
 */

const fs = require('fs');
const path = require('path');
const snarkjs = require('snarkjs');
const circomlibjs = require('circomlibjs');

async function main() {
  // Test identity (leaf index 0)
  // secret=123456789, salt=987654321
  const secret = 123456789n;
  const salt = 987654321n;
  const daoId = 1n;
  const proposalId = 1n;
  const voteChoice = 1n; // Yes vote

  const poseidon = await circomlibjs.buildPoseidon();

  // Compute commitment and nullifier
  const commitment = poseidon.F.toObject(poseidon([secret, salt]));
  const nullifier = poseidon.F.toObject(poseidon([secret, daoId, proposalId]));

  console.log('Identity:');
  console.log(`  secret: ${secret}`);
  console.log(`  salt: ${salt}`);
  console.log(`  commitment: ${commitment}`);
  console.log(`  nullifier: ${nullifier}`);

  // On-chain merkle path from get_merkle_path (dao_id=1, leaf_index=0)
  const pathElements = [
    "0",
    "14744269619966411208579211824598458697587494354926760081771325075741142829156",
    "7423237065226347324353380772367382631490014989348495481811164164159255474657",
    "11286972368698509976183087595462810875513684078608517520839298933882497716792",
    "3607627140608796879659380071776844901612302623152076817094415224584923813162",
    "19712377064642672829441595136074946683621277828620209496774504837737984048981",
    "20775607673010627194014556968476266066927294572720319469184847051418138353016",
    "3396914609616007258851405644437304192397291162432396347162513310381425243293",
    "21551820661461729022865262380882070649935529853313286572328683688269863701601",
    "6573136701248752079028194407151022595060682063033565181951145966236778420039",
    "12413880268183407374852357075976609371175688755676981206018884971008854919922",
    "14271763308400718165336499097156975241954733520325982997864342600795471836726",
    "20066985985293572387227381049700832219069292839614107140851619262827735677018",
    "9394776414966240069580838672673694685292165040808226440647796406499139370960",
    "11331146992410411304059858900317123658895005918277453009197229807340014528524",
    "15819538789928229930262697811477882737253464456578333862691129291651619515538",
    "19217088683336594659449020493828377907203207941212636669271704950158751593251",
    "21035245323335827719745544373081896983162834604456827698288649288827293579666"
  ];

  // Index 0 means all bits are 0
  const pathIndices = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

  // Proposal's eligible_root from on-chain
  const root = "17138981085726982929815047770222948937180916992196016628536485002859509881328";

  console.log(`  root: ${root}`);

  const input = {
    root: root,
    nullifier: nullifier.toString(),
    daoId: daoId.toString(),
    proposalId: proposalId.toString(),
    voteChoice: voteChoice.toString(),
    commitment: commitment.toString(),
    secret: secret.toString(),
    salt: salt.toString(),
    pathElements,
    pathIndices,
  };

  console.log('\nCircuit input:');
  console.log(JSON.stringify(input, null, 2));

  const wasmPath = path.join(__dirname, '..', 'frontend', 'public', 'circuits', 'vote.wasm');
  const zkeyPath = path.join(__dirname, '..', 'frontend', 'public', 'circuits', 'vote_final.zkey');

  console.log('\nGenerating proof...');
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);

  console.log('Proof generated!');
  console.log('\nPublic signals:');
  const labels = ['Root', 'Nullifier', 'DAO ID', 'Proposal ID', 'Vote Choice', 'Commitment'];
  publicSignals.forEach((sig, i) => {
    console.log(`  [${i}] ${labels[i]}: ${sig}`);
  });

  // Convert to Soroban BE format (big-endian, following PR #1614)
  function toBE32ByteHex(n) {
    return BigInt(n).toString(16).padStart(64, '0');
  }

  // G2 needs c1||c0 swap (imaginary first per EIP-196/197)
  const pi_a_x = toBE32ByteHex(proof.pi_a[0]);
  const pi_a_y = toBE32ByteHex(proof.pi_a[1]);
  const pi_b_x0 = toBE32ByteHex(proof.pi_b[0][1]); // c1 (imaginary)
  const pi_b_x1 = toBE32ByteHex(proof.pi_b[0][0]); // c0 (real)
  const pi_b_y0 = toBE32ByteHex(proof.pi_b[1][1]); // c1 (imaginary)
  const pi_b_y1 = toBE32ByteHex(proof.pi_b[1][0]); // c0 (real)
  const pi_c_x = toBE32ByteHex(proof.pi_c[0]);
  const pi_c_y = toBE32ByteHex(proof.pi_c[1]);

  const sorobanProof = {
    a: pi_a_x + pi_a_y,
    b: pi_b_x0 + pi_b_x1 + pi_b_y0 + pi_b_y1,  // c1||c0 per EIP-196
    c: pi_c_x + pi_c_y
  };

  // Save outputs
  const outDir = path.join(__dirname, 'generated');
  fs.mkdirSync(outDir, { recursive: true });

  const data = {
    identity: {
      secret: secret.toString(),
      salt: salt.toString(),
      commitment: commitment.toString(),
    },
    vote: {
      daoId: daoId.toString(),
      proposalId: proposalId.toString(),
      voteChoice: voteChoice.toString(),
      nullifier: nullifier.toString(),
      root: root,
    },
    proof: sorobanProof,
    publicSignals,
    rawProof: proof
  };

  fs.writeFileSync(path.join(outDir, 'local_proof_be.json'), JSON.stringify(data, null, 2));

  console.log('\n=== Stellar CLI Vote Command ===\n');
  const proofJson = JSON.stringify(sorobanProof);
  console.log(`source .contract-ids.local && stellar contract invoke \\`);
  console.log(`  --rpc-url "$RPC_URL" \\`);
  console.log(`  --network-passphrase "$PASSPHRASE" \\`);
  console.log(`  --source mykey \\`);
  console.log(`  --id $VOTING_ID \\`);
  console.log(`  -- vote \\`);
  console.log(`  --dao_id ${publicSignals[2]} \\`);
  console.log(`  --proposal_id ${publicSignals[3]} \\`);
  console.log(`  --vote_choice ${publicSignals[4] === '1' ? 'true' : 'false'} \\`);
  console.log(`  --nullifier '"${publicSignals[1]}"' \\`);
  console.log(`  --root '"${publicSignals[0]}"' \\`);
  console.log(`  --commitment '"${publicSignals[5]}"' \\`);
  console.log(`  --proof '${proofJson}'`);

  console.log('\nSaved to generated/local_proof_be.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
