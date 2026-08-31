// Parity tests for the snarkjs -> Soroban big-endian conversion (#369).
//
// What is pinned here:
//   1. FIXED VECTORS from real circuit runs (see parity-fixtures.js): the
//      snarkjs vote.circom VK must convert to EXACTLY the committed Soroban
//      output, and the on-chain-verified comment_v2 proof/VK (which was
//      produced by these exact scripts and passes the production BN254
//      pairing check on Soroban) must survive a full decode->re-encode cycle
//      byte-for-byte. A fixed vector catches a *symmetric* bug that a pure
//      round-trip test would miss.
//   2. ROUND-TRIPS: Soroban -> snarkjs -> Soroban and snarkjs -> Soroban ->
//      snarkjs both reproduce the original bytes/field elements exactly.
//   3. FORMAT SEMANTICS: G1 = be32(X)||be32(Y); G2 = be32(X.c1)||be32(X.c0)||
//      be32(Y.c1)||be32(Y.c0) -- i.e. the only transformation is swapping the
//      real/imaginary limb order within each G2 coordinate pair, at per-limb
//      granularity, with NO whole-buffer reversal.

const {
    toBE32ByteHex,
    convertProofToSoroban,
    convertVKeyToSoroban,
    sorobanProofToSnarkjs,
    sorobanVKeyToSnarkjs,
    sorobanG2ToSnarkjs,
} = require('./conversion-utils');

const {
    COMMENT_V2_PROOF_SOROBAN,
    COMMENT_V2_VK_SOROBAN,
    COMMENT_V2_PUBLIC_SIGNALS,
    VOTE_VKEY_SNARKJS,
    VOTE_VKEY_SOROBAN,
} = require('./parity-fixtures');

const HEX_RE = /^[0-9a-f]{128}$|^[0-9a-f]{256}$/;

describe('soroban_be parity: fixed vector format sanity', () => {
    test('proof hex strings have the correct byte lengths', () => {
        expect(COMMENT_V2_PROOF_SOROBAN.a.length).toBe(128); // G1 = 64 bytes
        expect(COMMENT_V2_PROOF_SOROBAN.b.length).toBe(256); // G2 = 128 bytes
        expect(COMMENT_V2_PROOF_SOROBAN.c.length).toBe(128); // G1 = 64 bytes
        for (const hex of Object.values(COMMENT_V2_PROOF_SOROBAN)) {
            expect(HEX_RE.test(hex)).toBe(true);
        }
    });

    test('vkey hex strings have the correct byte lengths', () => {
        expect(COMMENT_V2_VK_SOROBAN.alpha.length).toBe(128);
        expect(COMMENT_V2_VK_SOROBAN.beta.length).toBe(256);
        expect(COMMENT_V2_VK_SOROBAN.gamma.length).toBe(256);
        expect(COMMENT_V2_VK_SOROBAN.delta.length).toBe(256);
        COMMENT_V2_VK_SOROBAN.ic.forEach(point => expect(point.length).toBe(128));

        expect(VOTE_VKEY_SOROBAN.alpha.length).toBe(128);
        expect(VOTE_VKEY_SOROBAN.beta.length).toBe(256);
        expect(VOTE_VKEY_SOROBAN.gamma.length).toBe(256);
        expect(VOTE_VKEY_SOROBAN.delta.length).toBe(256);
        VOTE_VKEY_SOROBAN.ic.forEach(point => expect(point.length).toBe(128));
    });

    test('comment_v2 IC length matches its 7 public signals (8 = 7 + 1)', () => {
        expect(COMMENT_V2_VK_SOROBAN.ic.length).toBe(COMMENT_V2_PUBLIC_SIGNALS.length + 1);
    });

    test('vote vkey IC length matches its nPublic (6 = 5 + 1)', () => {
        expect(VOTE_VKEY_SNARKJS.nPublic).toBe(5);
        expect(VOTE_VKEY_SOROBAN.ic.length).toBe(VOTE_VKEY_SNARKJS.nPublic + 1);
    });
});

describe('soroban_be parity: fixed snarkjs -> Soroban vectors', () => {
    test('vote.circom snarkjs VK converts to EXACTLY the committed Soroban output', () => {
        const converted = convertVKeyToSoroban(VOTE_VKEY_SNARKJS);
        // Field-by-field so a regression message names the specific key.
        expect(converted.alpha).toBe(VOTE_VKEY_SOROBAN.alpha);
        expect(converted.beta).toBe(VOTE_VKEY_SOROBAN.beta);
        expect(converted.gamma).toBe(VOTE_VKEY_SOROBAN.gamma);
        expect(converted.delta).toBe(VOTE_VKEY_SOROBAN.delta);
        expect(converted.ic).toEqual(VOTE_VKEY_SOROBAN.ic);
    });

    test('vote.circom VK conversion is not a simple byte-reversal', () => {
        // Guard the G1 layout explicitly: be32(X)||be32(Y), MSB-first.
        const { vk_alpha_1 } = VOTE_VKEY_SNARKJS;
        const expected = toBE32ByteHex(BigInt(vk_alpha_1[0])) + toBE32ByteHex(BigInt(vk_alpha_1[1]));
        expect(convertVKeyToSoroban(VOTE_VKEY_SNARKJS).alpha).toBe(expected);
        // And it must NOT equal the little-endian (byte-reversed) rendering,
        // which would silently break on-chain verification.
        const reversed =
            toBE32ByteHex(BigInt(vk_alpha_1[1])).match(/.{2}/g).reverse().join('') +
            toBE32ByteHex(BigInt(vk_alpha_1[0])).match(/.{2}/g).reverse().join('');
        expect(convertVKeyToSoroban(VOTE_VKEY_SNARKJS).alpha).not.toBe(reversed);
    });

    test('G2 encoding swaps real/imaginary limbs, nothing else', () => {
        // x0/x1 (real/imag) and y0/y1 must each be 32-byte big-endian with the
        // imaginary limb first — not whole-buffer reversed.
        const x0 = 3n, x1 = 4n, y0 = 5n, y1 = 6n;
        // Build the Soroban hex by hand per the documented layout.
        const soroban = toBE32ByteHex(x1) + toBE32ByteHex(x0) + toBE32ByteHex(y1) + toBE32ByteHex(y0);
        const decoded = sorobanG2ToSnarkjs(soroban);
        expect(decoded).toEqual([['3', '4'], ['5', '6'], ['1', '0']]);
        // The reverse layout (real-first) must decode differently — the
        // ordering matters.
        const realFirst = toBE32ByteHex(x0) + toBE32ByteHex(x1) + toBE32ByteHex(y0) + toBE32ByteHex(y1);
        expect(sorobanG2ToSnarkjs(realFirst)).toEqual([['4', '3'], ['6', '5'], ['1', '0']]);
    });
});

describe('soroban_be parity: round-trip Soroban -> snarkjs -> Soroban', () => {
    test('comment_v2 proof (on-chain verified) round-trips byte-for-byte', () => {
        const snarkjs = sorobanProofToSnarkjs(COMMENT_V2_PROOF_SOROBAN);
        const reencoded = convertProofToSoroban(snarkjs);
        expect(reencoded.a).toBe(COMMENT_V2_PROOF_SOROBAN.a);
        expect(reencoded.b).toBe(COMMENT_V2_PROOF_SOROBAN.b);
        expect(reencoded.c).toBe(COMMENT_V2_PROOF_SOROBAN.c);
    });

    test('comment_v2 vk (on-chain verified) round-trips byte-for-byte', () => {
        const snarkjs = sorobanVKeyToSnarkjs(COMMENT_V2_VK_SOROBAN);
        const reencoded = convertVKeyToSoroban(snarkjs);
        expect(reencoded.alpha).toBe(COMMENT_V2_VK_SOROBAN.alpha);
        expect(reencoded.beta).toBe(COMMENT_V2_VK_SOROBAN.beta);
        expect(reencoded.gamma).toBe(COMMENT_V2_VK_SOROBAN.gamma);
        expect(reencoded.delta).toBe(COMMENT_V2_VK_SOROBAN.delta);
        expect(reencoded.ic).toEqual(COMMENT_V2_VK_SOROBAN.ic);
    });

    test('vote.circom VK round-trips byte-for-byte', () => {
        const snarkjs = sorobanVKeyToSnarkjs(VOTE_VKEY_SOROBAN);
        const reencoded = convertVKeyToSoroban(snarkjs);
        expect(reencoded).toEqual(VOTE_VKEY_SOROBAN);
    });
});



describe('soroban_be parity: round-trip snarkjs -> Soroban -> snarkjs', () => {
    test('vote.circom VK field elements are recovered exactly', () => {
        const soroban = convertVKeyToSoroban(VOTE_VKEY_SNARKJS);
        const decoded = sorobanVKeyToSnarkjs(soroban);

        // alpha (G1)
        expect(decoded.vk_alpha_1.slice(0, 2)).toEqual(VOTE_VKEY_SNARKJS.vk_alpha_1.slice(0, 2));
        // beta/gamma/delta (G2) — compare the four coordinates each
        for (const field of ['vk_beta_2', 'vk_gamma_2', 'vk_delta_2']) {
            const orig = VOTE_VKEY_SNARKJS[field];
            const dec = decoded[field];
            expect([dec[0][0], dec[0][1]]).toEqual([orig[0][0], orig[0][1]]);
            expect([dec[1][0], dec[1][1]]).toEqual([orig[1][0], orig[1][1]]);
        }
        // IC (G1)
        expect(decoded.IC.map(p => p.slice(0, 2))).toEqual(VOTE_VKEY_SNARKJS.IC.map(p => p.slice(0, 2)));
    });

    test('decoded comment_v2 proof coordinates are BN254 field elements', () => {
        // G1 coords live in Fq, G2 coords in Fq2; nothing may exceed the
        // BN254 base-field modulus after a decode (a corruption would likely
        // show up as an out-of-range or non-canonical value).
        const p = BigInt('21888242871839275222246405745257275088696311157297823662689037894645226208583');
        const proof = sorobanProofToSnarkjs(COMMENT_V2_PROOF_SOROBAN);
        const g1 = [proof.pi_a[0], proof.pi_a[1], proof.pi_c[0], proof.pi_c[1]];
        for (const coord of g1) {
            const v = BigInt(coord);
            expect(v).toBeGreaterThan(0n);
            expect(v).toBeLessThan(p);
        }
        const g2 = [proof.pi_b[0][0], proof.pi_b[0][1], proof.pi_b[1][0], proof.pi_b[1][1]];
        for (const coord of g2) {
            const v = BigInt(coord);
            expect(v).toBeGreaterThan(0n);
            expect(v).toBeLessThan(p);
        }
    });

    test('decoded proof does not depend on the z-coordinate (affine)', () => {
        // snarkjs includes z="1"/z=["1","0"]; conversion must only consume
        // x/y coordinates, so a round trip ignores z.
        const snarkjs = sorobanProofToSnarkjs(COMMENT_V2_PROOF_SOROBAN);
        expect(snarkjs.pi_a[2]).toBe('1');
        expect(snarkjs.pi_b[2]).toEqual(['1', '0']);
        expect(snarkjs.pi_c[2]).toBe('1');
    });
});
