import { describe, expect, it } from 'vitest';
import { encodeQr, finalCodewords, reedSolomon } from './qrCode';

describe('QR code encoder', () => {
  it('matches the reference HELLO WORLD codewords (version 1-M)', () => {
    const { version, codewords } = finalCodewords('HELLO WORLD');
    expect(version).toBe(1);
    expect(codewords.slice(0, 16)).toEqual([
      32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17
    ]);
    expect(codewords.slice(16)).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23
    ]);
  });

  it('produces Reed–Solomon codewords whose syndromes vanish', () => {
    // The EC block makes data‖ec a multiple of the generator: evaluating the
    // codeword polynomial at every root αⁱ gives zero.
    const data = Array.from({ length: 44 }, (_, i) => (i * 37 + 11) & 0xff);
    const ec = reedSolomon(data, 26);
    const word = [...data, ...ec];
    const exp = [1];
    for (let i = 1; i < 26; i += 1) {
      let next = exp[i - 1]! << 1;
      if (next & 0x100) next ^= 0x11d;
      exp.push(next);
    }
    const mul = (a: number, b: number) => {
      let out = 0;
      while (b) {
        if (b & 1) out ^= a;
        a <<= 1;
        if (a & 0x100) a ^= 0x11d;
        b >>= 1;
      }
      return out;
    };
    for (const root of exp) {
      let value = 0;
      for (const coefficient of word) value = mul(value, root) ^ coefficient;
      expect(value).toBe(0);
    }
  });

  it('fits the device scan code in version 3 with finder and timing patterns', () => {
    const code = `OZD1:${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'.repeat(2).slice(0, 52)}`;
    const matrix = encodeQr(code);
    expect(matrix).toHaveLength(29);
    // Finder corners: a dark 7×7 ring with a dark 3×3 centre.
    for (const [x0, y0] of [
      [0, 0],
      [22, 0],
      [0, 22]
    ] as const) {
      expect(matrix[y0]![x0]).toBe(true);
      expect(matrix[y0 + 1]![x0 + 1]).toBe(false);
      expect(matrix[y0 + 3]![x0 + 3]).toBe(true);
    }
    // Timing pattern alternates along row 6.
    for (let x = 8; x < 21; x += 1) expect(matrix[6]![x]).toBe(x % 2 === 0);
    // The dark module.
    expect(matrix[29 - 8]![8]).toBe(true);
  });

  it('switches to byte mode for lowercase text and refuses what does not fit', () => {
    expect(encodeQr('hello').length).toBe(21);
    expect(() => encodeQr('x'.repeat(200))).toThrow();
  });
});
