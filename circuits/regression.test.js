// Regression tests for actual proof and verification key conversions
// These tests ensure the conversion scripts produce the exact output
// that is currently working in the Soroban contracts

const fs = require('fs');
const path = require('path');
const { convertProofToSoroban, convertVKeyToSoroban } = require('./conversion-utils');

describe('Regression Tests: Actual Proof and VK Files', () => {
    describe('Real Proof Conversion', () => {
        let proof, expectedSorobanProof;

        beforeAll(() => {
            // Load the actual proof files
            proof = JSON.parse(fs.readFileSync('proof_real_test.json', 'utf8'));
            expectedSorobanProof = JSON.parse(fs.readFileSync('proof_real_test_soroban_le.json', 'utf8'));
        });

        test('proof file exists and is valid', () => {
            expect(proof).toHaveProperty('pi_a');
            expect(proof).toHaveProperty('pi_b');
            expect(proof).toHaveProperty('pi_c');
        });

        test('converts proof to exact expected format', () => {
            const result = convertProofToSoroban(proof);

            // Should match the working Soroban proof exactly
            expect(result.a).toBe(expectedSorobanProof.a);
            expect(result.b).toBe(expectedSorobanProof.b);
            expect(result.c).toBe(expectedSorobanProof.c);
        });

        test('proof A (G1) has correct structure', () => {
            const result = convertProofToSoroban(proof);

            // G1 point should be 64 bytes (128 hex chars)
            expect(result.a.length).toBe(128);
            expect(/^[0-9a-f]+$/.test(result.a)).toBe(true);
        });

        test('proof B (G2) has correct structure and Fq2 ordering', () => {
            const result = convertProofToSoroban(proof);

            // G2 point should be 128 bytes (256 hex chars)
            expect(result.b.length).toBe(256);
            expect(/^[0-9a-f]+$/.test(result.b)).toBe(true);

            // Should NOT start with the value we had when Fq2 was reversed
            // Old (wrong) value started with: f9f5e66c...
            // New (correct) value starts with: f59ab459...
            expect(result.b.slice(0, 8)).toBe('f59ab459');
            expect(result.b.slice(0, 8)).not.toBe('f9f5e66c');
        });

        test('proof C (G1) has correct structure', () => {
            const result = convertProofToSoroban(proof);

            // G1 point should be 64 bytes (128 hex chars)
            expect(result.c.length).toBe(128);
            expect(/^[0-9a-f]+$/.test(result.c)).toBe(true);
        });

        test('converted proof matches test snapshot', () => {
            const result = convertProofToSoroban(proof);

            // These are the values that successfully verified on-chain
            expect(result.a).toBe(
                '54f558fca3ae990d199f05f1351f7909fa4a5540936d705a6c153628fe5ab6110c12c592108e4c4d5eac2c33eddd9d3d5c568647abe791136d19f33ca3669620'
            );
            expect(result.b).toBe(
                'f59ab459228fa9f302e67621923bcb6bf2f5d4615def50c4b45b9c1e46c9b814f9f5e66cf599e13630ab3b7ddbdae67082f771cd5cc4bd13d0abcbcc65a02a0bc77bf2141857569cfac2acea49cfa9309954ba844018fdb3b8bf636bb8f7ea29cf2ddc1a07d0a5aa0b994aa0f3a7cfbc2fedd59ea783416758eadab66c473c1d'
            );
            expect(result.c).toBe(
                'a46962366b50a0c9a27e69511ae2d183bb462f43dd213ca32c8e74a86f1a3903ee2656a4bf4943f3c2efcf7b0c431aeffb80362fd7f48e33974a1b8ee5564b17'
            );
        });
    });

    describe('Verification Key Conversion', () => {
        let vkey, expectedSorobanVK;

        beforeAll(() => {
            // Load the actual VK files
            vkey = JSON.parse(fs.readFileSync('build/verification_key.json', 'utf8'));
            expectedSorobanVK = JSON.parse(fs.readFileSync('build/verification_key_soroban_le.json', 'utf8'));
        });

        test('VK file exists and is valid', () => {
            expect(vkey).toHaveProperty('vk_alpha_1');
            expect(vkey).toHaveProperty('vk_beta_2');
            expect(vkey).toHaveProperty('vk_gamma_2');
            expect(vkey).toHaveProperty('vk_delta_2');
            expect(vkey).toHaveProperty('IC');
        });

        test('converts VK to exact expected format', () => {
            const result = convertVKeyToSoroban(vkey);

            // Should match the working Soroban VK exactly
            expect(result.alpha).toBe(expectedSorobanVK.alpha);
            expect(result.beta).toBe(expectedSorobanVK.beta);
            expect(result.gamma).toBe(expectedSorobanVK.gamma);
            expect(result.delta).toBe(expectedSorobanVK.delta);
            expect(result.ic).toEqual(expectedSorobanVK.ic);
        });

        test('VK alpha (G1) has correct structure', () => {
            const result = convertVKeyToSoroban(vkey);
            expect(result.alpha.length).toBe(128);
            expect(/^[0-9a-f]+$/.test(result.alpha)).toBe(true);
        });

        test('VK beta (G2) has correct Fq2 ordering', () => {
            const result = convertVKeyToSoroban(vkey);

            expect(result.beta.length).toBe(256);

            // Should use natural Fq2 ordering (NOT reversed)
            // Old (wrong) value started with: 0c06f33b...
            // New (correct) value starts with: abb73dc1...
            expect(result.beta.slice(0, 8)).toBe('abb73dc1');
            expect(result.beta.slice(0, 8)).not.toBe('0c06f33b');
        });

        test('VK gamma (G2) has correct structure', () => {
            const result = convertVKeyToSoroban(vkey);
            expect(result.gamma.length).toBe(256);
            expect(/^[0-9a-f]+$/.test(result.gamma)).toBe(true);
        });

        test('VK delta (G2) has correct structure', () => {
            const result = convertVKeyToSoroban(vkey);
            expect(result.delta.length).toBe(256);
            expect(/^[0-9a-f]+$/.test(result.delta)).toBe(true);
        });

        test('VK IC array has correct length', () => {
            const result = convertVKeyToSoroban(vkey);

            // Should have 6 IC points (for 5 public inputs + constant term)
            expect(result.ic.length).toBe(6);
            expect(vkey.IC.length).toBe(6);
        });

        test('VK IC points are all valid G1 points', () => {
            const result = convertVKeyToSoroban(vkey);

            result.ic.forEach((point, i) => {
                expect(point.length).toBe(128); // G1 = 64 bytes
                expect(/^[0-9a-f]+$/.test(point)).toBe(true);
            });
        });

        test('converted VK beta matches snapshot (natural Fq2 order)', () => {
            const result = convertVKeyToSoroban(vkey);

            // This is the value that successfully verified on-chain
            expect(result.beta).toBe(
                'abb73dc17fbc13021e2471e0c08bd67d8401f52b73d6d07483794cad4778180e0c06f33bbc4c79a9cadef253a68084d382f17788f885c9afd176f7cb2f036709c8ced07a54067fd5a905ea3ec6b796f892912f4dd2233131c7a857a4b1c13917a74623114d9aa69d370d7a6bc4defdaa3c8c3fd947e8f5994a708ae0d1fb4c30'
            );
        });
    });

    describe('Fq2 Ordering Regression Tests', () => {
        test('G2 points use natural Fq2 ordering, not reversed', () => {
            // This test documents the critical bug we fixed
            const testG2Point = [
                ['100', '200'],  // x = 100 + 200·u
                ['300', '400'],  // y = 300 + 400·u
                ['1', '0']
            ];

            const { convertG2Point } = require('./conversion-utils');
            const result = convertG2Point(testG2Point);

            // Extract first 32 bytes (should be x1, not x2)
            const firstElement = result.slice(0, 64);

            // Convert back to check value
            const { reverseHexBytes } = require('./conversion-utils');
            const firstValue = BigInt('0x' + reverseHexBytes(firstElement));

            // Should be 100 (x1), NOT 200 (x2)
            expect(firstValue).toBe(100n);
            expect(firstValue).not.toBe(200n);
        });

        test('proof B field starts with natural-ordered x1 element', () => {
            const proof = JSON.parse(fs.readFileSync('proof_real_test.json', 'utf8'));
            const result = convertProofToSoroban(proof);

            // The first 64 hex chars should be x1 (proof.pi_b[0][0]), not x2 (proof.pi_b[0][1])
            const x1_expected = 'f59ab459228fa9f302e67621923bcb6bf2f5d4615def50c4b45b9c1e46c9b814';
            expect(result.b.slice(0, 64)).toBe(x1_expected);

            // Should NOT be the old (wrong) reversed value
            const x2_wrong = 'f9f5e66cf599e13630ab3b7ddbdae67082f771cd5cc4bd13d0abcbcc65a02a0b';
            expect(result.b.slice(0, 64)).not.toBe(x2_wrong);
        });
    });
});
