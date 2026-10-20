/**
 * Test-only helpers: deterministic randomness and fixed P-256 keys. These
 * keys were generated for the test vectors and protect nothing.
 */
import type { Bytes } from './bytes';
import type { RandomSource } from './primitives';

/** Bytes `start, start+1, …` (mod 256) on every call. */
export function patternBytes(length: number, start = 0): Bytes {
  return Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);
}

/** A random source that returns the queued values, then fails loudly. */
export function queuedRandom(...values: Uint8Array[]): RandomSource {
  return (length) => {
    const next = values.shift();
    if (!next || next.byteLength !== length) {
      throw new Error(`Test random source has no ${length}-byte value queued`);
    }
    return new Uint8Array(next);
  };
}

/** Mulberry32: a seeded generator for reproducible fuzzing. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FixedJwk {
  readonly x: string;
  readonly y: string;
  readonly d: string;
}

export const TEST_RECIPIENT_JWK: FixedJwk = {
  x: 'Il_lBM5w0Wogf5DaiEtdJ_QUa0byQPoAokzMujKnpCc',
  y: 'Kh--EaBkuIqCJ3WleqjVyBYHcp_t_juYEtoaklmZtDo',
  d: 'I0MKUV9N7yNf296BIyojD3mftIcW3RYlANrYKjrN_6w'
};

export const TEST_EPHEMERAL_JWK: FixedJwk = {
  x: 'gvtsMIE9hFCDIsEi785DAm59zqbw3p2WGm3zdfhvouQ',
  y: 'PxOEGWDmxjqkJ_jgGcQcq8i2Cmq1FrPo7KnHVOXoOF4',
  d: 'UOiZwiJEwRoOBQdOknIS5tZdGnNzwP8pB2oatR_u-Gs'
};

/** A fixed identity key for the code vectors. */
export const TEST_IDENTITY_JWK: FixedJwk = {
  x: 'mv7B6kH6r7HXt4KYmwnKX_W-nrsGsRIqDlF3bvwZqJQ',
  y: 'QSBhdzfch7ycvgF0bsH6RKDKTiVHWIYySYz49P3Z9qU',
  d: '06ysBq-UkYBxen6Yq03bGC-WwFLiB0kW1L4lCn3nBjI'
};

/** A fixed device signing key for the signature vectors. */
export const TEST_SIGNER_JWK: FixedJwk = {
  x: '41Gt27rcv-RXJHMTMhBRl5wtB_4TGqC6CNz8u2IwHfw',
  y: '04RVfsEpwCPL1L5k0r_D7pxEmJxH8TaRuaMoMr-GJbQ',
  d: 'JmONwfHRPZHOzFmnywsOqRKPX_FZqn_8B-9WCVxtvd8'
};

export async function importFixedPair(
  jwk: FixedJwk,
  algorithm: 'ECDH' | 'ECDSA'
): Promise<CryptoKeyPair> {
  const base = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  const params = { name: algorithm, namedCurve: 'P-256' };
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey(
      'jwk',
      { ...base, d: jwk.d },
      params,
      false,
      algorithm === 'ECDH' ? ['deriveBits'] : ['sign']
    ),
    crypto.subtle.importKey(
      'jwk',
      base,
      params,
      true,
      algorithm === 'ECDH' ? [] : ['verify']
    )
  ]);
  return { privateKey, publicKey };
}
