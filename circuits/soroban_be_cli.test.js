// Black-box tests for the conversion CLI scripts themselves (#369).
//
// These spawn the exact production artifacts (convert_proof_to_soroban_be.js
// and convert_vkey_to_soroban_be.js) as subprocesses against temp fixtures,
// so a regression cannot hide behind a mismatch between what the test calls
// and what the script actually runs. Expected outputs are the fixed real-run
// vectors from parity-fixtures.js (the comment_v2 proof's Soroban bytes are
// verified on-chain by contracts/zkvote-groth16/tests/comment_v2_real_proof.rs).

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sorobanProofToSnarkjs } = require('./conversion-utils');
const {
    COMMENT_V2_PROOF_SOROBAN,
    COMMENT_V2_PUBLIC_SIGNALS,
    VOTE_VKEY_SNARKJS,
    VOTE_VKEY_SOROBAN,
} = require('./parity-fixtures');

const PROOF_SCRIPT = path.join(__dirname, 'convert_proof_to_soroban_be.js');
const VKEY_SCRIPT = path.join(__dirname, 'convert_vkey_to_soroban_be.js');

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'soroban-be-parity-'));
}

describe('soroban_be parity: convert_proof_to_soroban_be.js (CLI)', () => {
    test('reproduces the on-chain-verified comment_v2 Soroban bytes exactly', () => {
        const dir = tmpdir();
        const proofPath = path.join(dir, 'proof.json');
        const publicPath = path.join(dir, 'public.json');

        // Reconstruct the snarkjs-format proof from the verified Soroban
        // bytes (the reverse helper is itself covered by the round-trip
        // suite); feed it to the real CLI.
        const snarkjsProof = sorobanProofToSnarkjs(COMMENT_V2_PROOF_SOROBAN);
        fs.writeFileSync(proofPath, JSON.stringify(snarkjsProof));
        fs.writeFileSync(publicPath, JSON.stringify(COMMENT_V2_PUBLIC_SIGNALS));

        execFileSync(process.execPath, [PROOF_SCRIPT, proofPath, publicPath], {
            cwd: dir,
            stdio: 'pipe',
        });

        const outputPath = path.join(dir, 'proof_soroban_be.json');
        const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        expect(output).toEqual(COMMENT_V2_PROOF_SOROBAN);
    });

    test('writes the output file next to the input proof with *_soroban_be.json', () => {
        const dir = tmpdir();
        const proofPath = path.join(dir, 'proof.json');
        const publicPath = path.join(dir, 'public.json');
        const snarkjsProof = sorobanProofToSnarkjs(COMMENT_V2_PROOF_SOROBAN);
        fs.writeFileSync(proofPath, JSON.stringify(snarkjsProof));
        fs.writeFileSync(publicPath, JSON.stringify(COMMENT_V2_PUBLIC_SIGNALS));

        execFileSync(process.execPath, [PROOF_SCRIPT, proofPath, publicPath], { cwd: dir });
        expect(fs.existsSync(path.join(dir, 'proof_soroban_be.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'proof_soroban.json'))).toBe(false);
    });
});

describe('soroban_be parity: convert_vkey_to_soroban_be.js (CLI)', () => {
    test('reproduces the committed vote.circom Soroban VK exactly', () => {
        const dir = tmpdir();
        const vkeyPath = path.join(dir, 'verification_key.json');
        const outPath = path.join(dir, 'verification_key_soroban.json');

        fs.writeFileSync(vkeyPath, JSON.stringify(VOTE_VKEY_SNARKJS));

        execFileSync(process.execPath, [VKEY_SCRIPT, vkeyPath, outPath], {
            cwd: dir,
            stdio: 'pipe',
        });

        const output = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(output).toEqual(VOTE_VKEY_SOROBAN);
    });

    test('honors the optional third output-path argument', () => {
        const dir = tmpdir();
        const vkeyPath = path.join(dir, 'verification_key.json');
        const outPath = path.join(dir, 'custom-output.json');

        fs.writeFileSync(vkeyPath, JSON.stringify(VOTE_VKEY_SNARKJS));
        execFileSync(process.execPath, [VKEY_SCRIPT, vkeyPath, outPath], { cwd: dir });

        expect(fs.existsSync(outPath)).toBe(true);
        expect(fs.existsSync(path.join(dir, 'build'))).toBe(false);
    });
});
