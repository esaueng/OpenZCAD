// Node-only shim for mls-rs-crypto-webcrypto.
//
// The provider derives P-256 HPKE key pairs (RFC 9180 DeriveKeyPair) by
// importing a PKCS#8 key that omits the public key and exporting it again,
// relying on the engine to recompute the public point. Chromium does;
// Node's WebCrypto does not, so every Commit fails with KeyDerivationError.
// This shim completes such keys with node:crypto before import. Browsers
// run the provider unmodified.

import { createECDH } from 'node:crypto';

const PREFIX = Buffer.from([0x02, 0x01, 0x01, 0x04, 0x20]); // INTEGER 1, OCTET STRING(32)

export function installNodeWebCryptoShim() {
  const subtle = globalThis.crypto.subtle;
  if (subtle.__mlsSpikeShim) return;
  const importKey = subtle.importKey.bind(subtle);
  subtle.importKey = async (format, data, algorithm, extractable, usages) => {
    if (format === 'pkcs8' && algorithm?.namedCurve === 'P-256') {
      const der = Buffer.from(
        data instanceof ArrayBuffer ? new Uint8Array(data) : data
      );
      const at = der.indexOf(PREFIX);
      const afterScalar = at + PREFIX.length + 32;
      // No [1] publicKey after the scalar: compute it.
      if (at >= 0 && der.indexOf(0xa1, afterScalar) === -1) {
        const d = der.subarray(at + PREFIX.length, afterScalar);
        const ecdh = createECDH('prime256v1');
        ecdh.setPrivateKey(d);
        const pub = ecdh.getPublicKey(); // 0x04 || x || y
        const jwk = {
          kty: 'EC',
          crv: 'P-256',
          d: d.toString('base64url'),
          x: pub.subarray(1, 33).toString('base64url'),
          y: pub.subarray(33, 65).toString('base64url'),
          ext: true
        };
        return importKey('jwk', jwk, algorithm, extractable, usages);
      }
    }
    return importKey(format, data, algorithm, extractable, usages);
  };
  subtle.__mlsSpikeShim = true;
}
