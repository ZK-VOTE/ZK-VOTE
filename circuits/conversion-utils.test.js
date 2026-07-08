const {
    toBE32ByteHex,
    convertG1Point,
    convertG2Point,
    convertProofToSoroban,
    convertVKeyToSoroban,
    reverseHexBytes
} = require('./conversion-utils');

describe('BN254 Point Conversion Utilities', () => {
    describe('toBE32ByteHex', () => {
        test('converts small number to 32-byte big-endian hex', () => {
            const result = toBE32ByteHex(1n);
            // Big-endian: most significant byte first, so 1 is at the end
            expect(result).toBe('0000000000000000000000000000000000000000000000000000000000000001');
            expect(result.length).toBe(64); // 32 bytes = 64 hex chars
        });

        test('converts larger number correctly', () => {
            const result = toBE32ByteHex(256n);
            // 256 = 0x100 in big-endian
            expect(result).toBe('0000000000000000000000000000000000000000000000000000000000000100');
        });

        test('converts max value (2^256-1)', () => {
            const maxValue = (1n << 256n) - 1n;
            const result = toBE32ByteHex(maxValue);
            expect(result).toBe('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        });

        test('outputs big-endian format for known value', () => {
            // Input: 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
            // Big-endian output should be the same (direct hex representation)
            const value = BigInt('0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
            const result = toBE32ByteHex(value);
            expect(result).toBe('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
        });

        test('pads to 32 bytes for small values', () => {
            const result = toBE32ByteHex(0x42n);
            expect(result.length).toBe(64);
            // Big-endian: 0x42 at the end, padded with zeros at the front
            expect(result).toBe('0000000000000000000000000000000000000000000000000000000000000042');
        });
    });

    describe('reverseHexBytes', () => {
        test('reverses 2-byte hex string', () => {
            expect(reverseHexBytes('0102')).toBe('0201');
        });

        test('reverses 32-byte hex string', () => {
            const input = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
            const expected = '201f1e1d1c1b1a191817161514131211100f0e0d0c0b0a090807060504030201';
            expect(reverseHexBytes(input)).toBe(expected);
        });

        test('is its own inverse', () => {
            const original = 'deadbeefcafe1234';
            const reversed = reverseHexBytes(original);
            const backToOriginal = reverseHexBytes(reversed);
            expect(backToOriginal).toBe(original);
        });
    });

    describe('convertG1Point', () => {
        test('converts BN254 generator point (1, 2)', () => {
            // BN254 G1 generator: (1, 2)
            const g1Generator = ['1', '2', '1'];
            const result = convertG1Point(g1Generator);

            // Expected: x=1 (BE), y=2 (BE) - big-endian format per CAP-74
            const expectedX = '0000000000000000000000000000000000000000000000000000000000000001';
            const expectedY = '0000000000000000000000000000000000000000000000000000000000000002';
            expect(result).toBe(expectedX + expectedY);
            expect(result.length).toBe(128); // 64 bytes = 128 hex chars
        });

        test('converts arbitrary G1 point', () => {
            // Test with known field elements
            const point = [
                '12345678901234567890',
                '98765432109876543210',
                '1'
            ];
            const result = convertG1Point(point);

            // Should be 128 hex chars (64 bytes)
            expect(result.length).toBe(128);

            // Extract x and y
            const x = result.slice(0, 64);
            const y = result.slice(64, 128);

            // Verify they're different
            expect(x).not.toBe(y);

            // Verify coordinates end with non-zero bytes (big-endian format)
            expect(x.slice(-2)).not.toBe('00'); // Should have non-zero low byte
        });
    });

    describe('convertG2Point', () => {
        test('converts with CAP-74 Fq2 ordering (c1 before c0)', () => {
            // Test point with distinct values for each coordinate
            // snarkjs format: [[c0, c1], [c0, c1]] where c0=real, c1=imaginary
            const point = [
                ['1', '2'],  // x = 1 + 2·u (c0=1, c1=2)
                ['3', '4'],  // y = 3 + 4·u (c0=3, c1=4)
                ['1', '0']   // z = 1 + 0·u (affine)
            ];

            const result = convertG2Point(point);

            // Should be 256 hex chars (128 bytes)
            expect(result.length).toBe(256);

            // CAP-74 format: X.c1 || X.c0 || Y.c1 || Y.c0 (imaginary before real)
            const x_c1 = result.slice(0, 64);   // X imaginary = 2
            const x_c0 = result.slice(64, 128); // X real = 1
            const y_c1 = result.slice(128, 192); // Y imaginary = 4
            const y_c0 = result.slice(192, 256); // Y real = 3

            // Big-endian format
            expect(x_c1).toBe('0000000000000000000000000000000000000000000000000000000000000002');
            expect(x_c0).toBe('0000000000000000000000000000000000000000000000000000000000000001');
            expect(y_c1).toBe('0000000000000000000000000000000000000000000000000000000000000004');
            expect(y_c0).toBe('0000000000000000000000000000000000000000000000000000000000000003');
        });

        test('uses CAP-74 ordering (c1 before c0, imaginary before real)', () => {
            const point = [
                ['100', '200'],  // x = 100 + 200·u (c0=100, c1=200)
                ['300', '400'],  // y = 300 + 400·u (c0=300, c1=400)
                ['1', '0']
            ];

            const result = convertG2Point(point);

            // First 64 chars should be X.c1 (imaginary) = 200, not X.c0 = 100
            const x_c1 = result.slice(0, 64);
            const x_c1Value = BigInt('0x' + x_c1);
            expect(x_c1Value).toBe(200n);
            expect(x_c1Value).not.toBe(100n);
        });

        test('converts BN254 G2 generator coordinates', () => {
            // BN254 G2 generator point (snarkjs format: [[c0, c1], [c0, c1]])
            const g2Generator = [
                [
                    '10857046999023057135944570762232829481370756359578518086990519993285655852781',  // x.c0
                    '11559732032986387107991004021392285783925812861821192530917403151452391805634'   // x.c1
                ],
                [
                    '8495653923123431417604973247489272438418190587263600148770280649306958101930',   // y.c0
                    '4082367875863433681332203403145435568316851327593401208105741076214120093531'    // y.c1
                ],
                ['1', '0']
            ];

            const result = convertG2Point(g2Generator);
            expect(result.length).toBe(256);

            // CAP-74 big-endian format: X.c1 || X.c0 || Y.c1 || Y.c0
            // These are the correct big-endian hex values
            const expectedX_c1 = '198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2';  // x.c1
            const expectedX_c0 = '1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed';  // x.c0
            const expectedY_c1 = '090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b'; // y.c1
            const expectedY_c0 = '12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa';  // y.c0

            expect(result.slice(0, 64)).toBe(expectedX_c1);
            expect(result.slice(64, 128)).toBe(expectedX_c0);
            expect(result.slice(128, 192)).toBe(expectedY_c1);
            expect(result.slice(192, 256)).toBe(expectedY_c0);
        });
    });

    describe('convertProofToSoroban', () => {
        test('converts complete Groth16 proof structure', () => {
            const proof = {
                pi_a: ['1', '2', '1'],
                pi_b: [['3', '4'], ['5', '6'], ['1', '0']],
                pi_c: ['7', '8', '1']
            };

            const result = convertProofToSoroban(proof);

            // Should have a, b, c fields
            expect(result).toHaveProperty('a');
            expect(result).toHaveProperty('b');
            expect(result).toHaveProperty('c');

            // a and c should be G1 (64 bytes = 128 hex)
            expect(result.a.length).toBe(128);
            expect(result.c.length).toBe(128);

            // b should be G2 (128 bytes = 256 hex)
            expect(result.b.length).toBe(256);
        });

        test('matches real proof conversion', () => {
            // Use actual values from our test proof
            const proof = {
                pi_a: [
                    '8002376440479074486643027846934478313476620092854043812485969298002750224980',
                    '20820516206451825778653033949651894732046172821989055316925943878969935646732',
                    '1'
                ],
                pi_b: [
                    [
                        '11559732032986387107991004021392285783925812861821192530917403151452391805625',
                        '21909886534343143487302430567958239346154845577896993866116438261516893516537'
                    ],
                    [
                        '13050022111743750830309270488348950830882797851569133652934823789823961090759',
                        '18687801815239898060635746799867029419031293419798172885813298006652832064351'
                    ],
                    ['1', '0']
                ],
                pi_c: [
                    '1726527621229471947085885673878667768892109341089754997867350690652991348902',
                    '10591065654267356195025133948926746157872961738903991091509743636308030762734',
                    '1'
                ]
            };

            const result = convertProofToSoroban(proof);

            // Verify it produces hex strings of correct length
            expect(typeof result.a).toBe('string');
            expect(typeof result.b).toBe('string');
            expect(typeof result.c).toBe('string');

            expect(result.a.length).toBe(128);
            expect(result.b.length).toBe(256);
            expect(result.c.length).toBe(128);
        });
    });

    describe('convertVKeyToSoroban', () => {
        test('converts verification key structure', () => {
            const vkey = {
                vk_alpha_1: ['1', '2', '1'],
                vk_beta_2: [['3', '4'], ['5', '6'], ['1', '0']],
                vk_gamma_2: [['7', '8'], ['9', '10'], ['1', '0']],
                vk_delta_2: [['11', '12'], ['13', '14'], ['1', '0']],
                IC: [
                    ['15', '16', '1'],
                    ['17', '18', '1'],
                    ['19', '20', '1']
                ]
            };

            const result = convertVKeyToSoroban(vkey);

            // Should have all required fields
            expect(result).toHaveProperty('alpha');
            expect(result).toHaveProperty('beta');
            expect(result).toHaveProperty('gamma');
            expect(result).toHaveProperty('delta');
            expect(result).toHaveProperty('ic');

            // alpha should be G1 (128 hex)
            expect(result.alpha.length).toBe(128);

            // beta, gamma, delta should be G2 (256 hex)
            expect(result.beta.length).toBe(256);
            expect(result.gamma.length).toBe(256);
            expect(result.delta.length).toBe(256);

            // IC should be array of G1 points
            expect(Array.isArray(result.ic)).toBe(true);
            expect(result.ic.length).toBe(3);
            result.ic.forEach(point => {
                expect(point.length).toBe(128);
            });
        });

        test('IC array length matches input', () => {
            const vkey = {
                vk_alpha_1: ['1', '2', '1'],
                vk_beta_2: [['3', '4'], ['5', '6'], ['1', '0']],
                vk_gamma_2: [['7', '8'], ['9', '10'], ['1', '0']],
                vk_delta_2: [['11', '12'], ['13', '14'], ['1', '0']],
                IC: [
                    ['1', '2', '1'],
                    ['3', '4', '1'],
                    ['5', '6', '1'],
                    ['7', '8', '1'],
                    ['9', '10', '1'],
                    ['11', '12', '1']
                ]
            };

            const result = convertVKeyToSoroban(vkey);
            expect(result.ic.length).toBe(6); // Same as input
        });
    });

    describe('Integration: Round-trip conversions', () => {
        test('BE hex conversion is consistent with reversal', () => {
            const originalValue = 12345678901234567890n;
            const beBytesHex = toBE32ByteHex(originalValue);

            // Convert directly back to bigint (BE format)
            const recovered = BigInt('0x' + beBytesHex);

            expect(recovered).toBe(originalValue);
        });

        test('proof conversion produces valid hex strings', () => {
            const proof = {
                pi_a: ['100', '200', '1'],
                pi_b: [['300', '400'], ['500', '600'], ['1', '0']],
                pi_c: ['700', '800', '1']
            };

            const result = convertProofToSoroban(proof);

            // All results should be valid hex
            expect(/^[0-9a-f]+$/.test(result.a)).toBe(true);
            expect(/^[0-9a-f]+$/.test(result.b)).toBe(true);
            expect(/^[0-9a-f]+$/.test(result.c)).toBe(true);
        });
    });

    describe('Edge cases', () => {
        test('handles zero values', () => {
            const result = toBE32ByteHex(0n);
            expect(result).toBe('0000000000000000000000000000000000000000000000000000000000000000');
        });

        test('handles point at infinity representation', () => {
            // Point at infinity typically has z=0
            const pointAtInfinity = ['0', '0', '0'];
            const result = convertG1Point(pointAtInfinity);

            // Should still produce valid 64-byte output
            expect(result.length).toBe(128);
            expect(result).toBe('0000000000000000000000000000000000000000000000000000000000000000' +
                               '0000000000000000000000000000000000000000000000000000000000000000');
        });

        test('handles maximum field element', () => {
            // BN254 field modulus - 1
            const fieldModulusMinus1 = BigInt('0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd46');
            const result = toBE32ByteHex(fieldModulusMinus1);

            // Big-endian output should be the direct hex representation
            expect(result.length).toBe(64);
            expect(result).toBe('30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd46');
        });
    });
});
