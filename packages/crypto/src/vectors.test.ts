/**
 * Fixed test vectors. Every input (keys, blob ids, IVs, ephemeral keys,
 * timestamps) is injected, so each output is a constant. A change to any of
 * these strings is a storage-format change: it needs a new version byte,
 * not an updated vector.
 *
 * The nonce layout, the envelope and content-blob formats and the wrap are
 * also re-derived here with nothing but raw WebCrypto calls, so the format
 * matches the README specification and not merely this implementation.
 */
import { describe, expect, it } from 'vitest';
import { concatBytes, fromHex, toHex } from './bytes';
import {
  assetDedupeHash,
  commitDeviceApprovalWith,
  contactVerificationCode,
  importAssetDedupeSecret,
  deviceApprovalCode,
  formatComparisonCode,
  formatRecoveryKey,
  identityFingerprint,
  projectStateCode,
  publicKeyHash
} from './codes';
import {
  chunkNonce,
  decryptContentBlob,
  decryptProjectEnvelope,
  encryptContentBlobWith,
  encryptProjectEnvelope,
  envelopeKeyFromBytes,
  parseEnvelope
} from './envelope';
import type { ProjectEnvelopeHeaderInit } from './header';
import {
  contactsEntryHash,
  decodeContactsEntry,
  encodeContactsEntry,
  verifyContactsList
} from './contacts';
import {
  accountKeyCommitment,
  deviceListEntryHash,
  encodeDeviceListEntry,
  encodeRevocationCutoffs
} from './devices';
import { exportPublicKey } from './keys';
import { verifyProjectEnvelopeSignature, versionHash } from './signing';
import {
  decodeEncryptedDocumentBody,
  encodeEncryptedDocumentBody,
  encodeKeyArchiveBody
} from './bodies';
import {
  decodeShareAuthority,
  decodeShareDelegation,
  decodeShareLinkGrant,
  decodeShareLinkTombstone,
  encodeShareAuthority,
  encodeShareDelegation,
  encodeShareLinkGrant,
  encodeShareLinkTombstone,
  shareKeyHash,
  verifyShareAuthority,
  verifyShareDelegation,
  verifyShareLinkSet
} from './share-links';
import { epochBinding } from './codes';
import {
  decodeVersionLogRecord,
  encodeVersionLogRecord,
  verifyVersionLog,
  versionLogRecord
} from './version-log';
import {
  TEST_EPHEMERAL_JWK,
  TEST_IDENTITY_JWK,
  TEST_RECIPIENT_JWK,
  TEST_SIGNER_JWK,
  importFixedPair,
  patternBytes,
  queuedRandom
} from './test-support';
import {
  encodeWrapContext,
  openSealedKey,
  sealKeyWith,
  unwrapKey,
  wrapKey,
  wrapKeyWith,
  type WrapContext
} from './wrap';

const subtle = crypto.subtle;
const utf8 = (text: string) => new TextEncoder().encode(text);

const VERSION_KEY = patternBytes(32, 0x00);
const BLOB_KEY = patternBytes(32, 0x40);
const BLOB_ID_RANDOM = patternBytes(16, 0x70);
const PLAINTEXT = utf8('OpenZCAD envelope test vector. '.repeat(3));
const HEADER: ProjectEnvelopeHeaderInit = {
  kind: 'document',
  projectId: 'prj_1',
  documentVersion: 5,
  previousVersionHash: patternBytes(32, 0xa0),
  epochBindingHash: patternBytes(32, 0xc0),
  schemaVersion: 23,
  keyEpoch: 1,
  blobIds: ['707172737475767778797a7b7c7d7e7f'],
  compression: 'none',
  chunkSize: 64
};

async function projectVector(): Promise<Uint8Array> {
  return encryptProjectEnvelope(
    envelopeKeyFromBytes(VERSION_KEY),
    HEADER,
    PLAINTEXT
  );
}

async function contentVector() {
  return encryptContentBlobWith(
    envelopeKeyFromBytes(BLOB_KEY),
    'import-source',
    PLAINTEXT,
    { compression: 'none', chunkSize: 64 },
    queuedRandom(BLOB_ID_RANDOM)
  );
}

/** Decrypts every chunk with raw WebCrypto, following the README. */
async function rawDecrypt(
  key: Uint8Array,
  envelope: Uint8Array,
  chunkSize: number
) {
  const headerLength = new DataView(
    envelope.buffer,
    envelope.byteOffset
  ).getUint32(4);
  const prefix = envelope.subarray(0, 8 + headerLength);
  const aesKey = await subtle.importKey(
    'raw',
    new Uint8Array(key),
    'AES-GCM',
    false,
    ['decrypt']
  );
  const body = envelope.subarray(prefix.byteLength);
  const cipherSize = chunkSize + 16;
  const chunks: Uint8Array[] = [];
  for (
    let at = 0, index = 0;
    at < body.byteLength;
    at += cipherSize, index += 1
  ) {
    const last = at + cipherSize >= body.byteLength;
    // uint88_be(index) || last
    const nonce = new Uint8Array(12);
    for (
      let i = 10, value = index;
      i >= 0;
      i -= 1, value = Math.floor(value / 256)
    ) {
      nonce[i] = value % 256;
    }
    nonce[11] = last ? 1 : 0;
    const indexBytes = new Uint8Array(4);
    new DataView(indexBytes.buffer).setUint32(0, index);
    chunks.push(
      new Uint8Array(
        await subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: nonce,
            additionalData: concatBytes(prefix, indexBytes)
          },
          aesKey,
          new Uint8Array(body.subarray(at, at + cipherSize))
        )
      )
    );
  }
  return { prefix, chunks };
}

describe('nonce layout', () => {
  it('is uint88_be(index) followed by the last-chunk byte', () => {
    expect(toHex(chunkNonce(0, true))).toBe('000000000000000000000001');
    expect(toHex(chunkNonce(0, false))).toBe('000000000000000000000000');
    expect(toHex(chunkNonce(1, true))).toBe('000000000000000000000101');
    expect(toHex(chunkNonce(0x01020304, false))).toBe(
      '000000000000000102030400'
    );
  });
});

describe('project envelope v1 vector', () => {
  it('serializes the documented prefix', async () => {
    const { prefix } = parseEnvelope(await projectVector());
    expect(toHex(prefix)).toMatchInlineSnapshot(
      `"4f5a45010000008901010000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f310001203730373137323733373437353736373737383739376137623763376437653766"`
    );
  });

  it('produces the fixed ciphertext', async () => {
    const envelope = await projectVector();
    expect(toHex(envelope)).toMatchInlineSnapshot(
      `"4f5a45010000008901010000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f31000120373037313732373337343735373637373738373937613762376337643765376641ccd0b0ef6fc2f928cdc7437d40fee9b76322365bf54059e5fdc7ecb7d17d193e3a88e669b3fc2656ad0790ada1192b897324950d5130c033c2505464400194ac79cc8557d0b73b6fc145fe380a6b410d63da358bfe9a8b630caa878e8d6b0ab4fd9d1bf92e807fc5adbfdc173f6d67e029e68a4601b6ec9d72a5c44d"`
    );
    expect(
      (await decryptProjectEnvelope(VERSION_KEY, envelope)).plaintext
    ).toEqual(PLAINTEXT);
  });

  it('decrypts with raw WebCrypto following the specification', async () => {
    const { chunks } = await rawDecrypt(VERSION_KEY, await projectVector(), 64);
    expect(chunks).toHaveLength(2);
    expect(concatBytes(...chunks)).toEqual(PLAINTEXT);
  });

  it('has a fixed version hash', async () => {
    expect(
      toHex(await versionHash(await projectVector()))
    ).toMatchInlineSnapshot(
      `"319935295d2b281ed58c71760f5936274f3bb923762e0e9c6c4f8cb7cc2e1426"`
    );
  });
});

describe('content blob v1 vector', () => {
  it('produces the fixed blob and reference', async () => {
    const { envelope, reference } = await contentVector();
    expect(reference.blobId).toBe(toHex(BLOB_ID_RANDOM));
    expect(toHex(envelope)).toMatchInlineSnapshot(
      `"4f5a45010000003002010000000040000000000000005d20373037313732373337343735373637373738373937613762376337643765376615445516ce2b93eff8eef6855a910d364aa274fbe5629127dec7a9929c1e3209b356d7d85fde4061f0df9abf811bec589adb82e0c43480bf2b9bb7994fae870c3c6678cc54e1a26b1b13cffda038bb701da07ee2684afbdc95606b37e54e8c8264e6724bb2499b526ee40194b96ea6dc153d7c19ea9d129bbaee38697a"`
    );
    expect(toHex(reference.ciphertextHash)).toMatchInlineSnapshot(
      `"45cd73f5fe1e124aca36d61fcaa78d6e20a7ad2393bc43e4ddac1e1e97637483"`
    );
    expect(await decryptContentBlob(reference, envelope)).toEqual(PLAINTEXT);
  });

  it('re-derives the plaintext and ciphertext hash with raw WebCrypto', async () => {
    const { envelope, reference } = await contentVector();
    const { prefix, chunks } = await rawDecrypt(BLOB_KEY, envelope, 64);
    expect(concatBytes(...chunks)).toEqual(PLAINTEXT);
    const body = envelope.subarray(prefix.byteLength);
    // h0 = SHA-256(label); h = SHA-256(h | SHA-256(part)) over the prefix
    // and each chunk in order.
    const sha = async (data: Uint8Array) =>
      new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(data)));
    let hash = await sha(utf8('OpenZCAD E2EE v1 content blob hash'));
    for (const part of [prefix, body.subarray(0, 80), body.subarray(80)]) {
      hash = await sha(concatBytes(hash, await sha(part)));
    }
    expect(new Uint8Array(hash)).toEqual(reference.ciphertextHash);
  });
});

const KEK = patternBytes(32, 0x10);
const WRAPPED_SECRET = patternBytes(32, 0x30);
const VERSION_CONTEXT: WrapContext = {
  purpose: 'version-key',
  projectId: 'prj_1',
  keyEpoch: 1,
  kind: 'document',
  versionId: '5'
};

describe('wrap v1 vector', () => {
  it('encodes the context canonically', () => {
    expect(toHex(encodeWrapContext(VERSION_CONTEXT))).toMatchInlineSnapshot(
      `"086b657945706f6368020000000000000001046b696e64010008646f63756d656e740970726f6a656374496401000570726a5f3107707572706f736501000b76657273696f6e2d6b65790976657273696f6e496401000135"`
    );
  });

  it('produces the fixed AES-KW wrap and opens with raw WebCrypto', async () => {
    const wrapped = await wrapKey(KEK, WRAPPED_SECRET, VERSION_CONTEXT);
    expect(toHex(wrapped)).toMatchInlineSnapshot(
      `"02bbbd0963d86843d8312990b54c24a975feb9cbf435334efaba7d1078736e81400335de6fcee2946f"`
    );
    // KEK = HKDF-SHA256(parent, empty salt, label | canonical context).
    const base = await subtle.importKey('raw', KEK, 'HKDF', false, [
      'deriveKey'
    ]);
    const kek = await subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(),
        info: concatBytes(
          utf8('OpenZCAD E2EE v1 kw version-key'),
          encodeWrapContext(VERSION_CONTEXT)
        )
      },
      base,
      { name: 'AES-KW', length: 256 },
      false,
      ['unwrapKey']
    );
    const opened = await subtle.unwrapKey(
      'raw',
      wrapped.slice(1),
      kek,
      'AES-KW',
      'AES-GCM',
      true,
      ['encrypt']
    );
    expect(new Uint8Array(await subtle.exportKey('raw', opened))).toEqual(
      WRAPPED_SECRET
    );
    expect(await unwrapKey(KEK, wrapped, VERSION_CONTEXT)).toEqual(
      WRAPPED_SECRET
    );
  });

  it('produces the fixed AES-GCM private-key wrap', async () => {
    const context: WrapContext = {
      purpose: 'encryption-private-key',
      userId: 'usr_1',
      keyId: 'k1'
    };
    const wrapped = await wrapKeyWith(
      KEK,
      patternBytes(40, 0x01),
      context,
      queuedRandom(patternBytes(12, 0xc0))
    );
    expect(toHex(wrapped)).toMatchInlineSnapshot(
      `"01c0c1c2c3c4c5c6c7c8c9cacb5e48a0622c8158b29517a3e35785d2293491c4d5dc99ebbb88365c71eecc9bbd0705c78fe77bc01a7d9625d664061e61bd0f0fe67a5a3d0b"`
    );
    expect(await unwrapKey(KEK, wrapped, context)).toEqual(
      patternBytes(40, 0x01)
    );
  });
});

describe('seal v1 vector', () => {
  const CONTEXT: WrapContext = {
    purpose: 'project-key',
    userId: 'usr_1',
    projectId: 'prj_1',
    keyEpoch: 1
  };

  it('produces the fixed seal for a fixed ephemeral key', async () => {
    const recipient = await importFixedPair(TEST_RECIPIENT_JWK, 'ECDH');
    const ephemeral = await importFixedPair(TEST_EPHEMERAL_JWK, 'ECDH');
    const sealed = await sealKeyWith(
      recipient.publicKey,
      WRAPPED_SECRET,
      CONTEXT,
      ephemeral,
      queuedRandom(patternBytes(12, 0xd0))
    );
    expect(toHex(sealed)).toMatchInlineSnapshot(
      `"010482fb6c30813d84508322c122efce43026e7dcea6f0de9d961a6df375f86fa2e43f13841960e6c63aa427f8e019c41cabc8b60a6ab516b3e8eca9c754e5e8385ed0d1d2d3d4d5d6d7d8d9dadbfe59717957995a878dcf5398e698853d13a567337d4e5c7e8e0877a78da169b507307627a4e44cedc21acb64652ad48d"`
    );
    expect(await openSealedKey(recipient, sealed, CONTEXT)).toEqual(
      WRAPPED_SECRET
    );
  });
});

// ECDSA signatures are randomized, so this is a recorded signature over the
// project envelope vector that must keep verifying.
const VERSION_SIGNATURE =
  '0100000199c82cc000490ad620f6a014d8a29e34a5fa46571999c909682e86ee4331409a368d23954ad4448a3983dcc657f7fcb29d6b74602bd37919179b2ed6f9206b243c54fe9464';

describe('version signature vector', () => {
  it('verifies the recorded signature and its timestamp', async () => {
    const signer = await importFixedPair(TEST_SIGNER_JWK, 'ECDSA');
    expect(
      await verifyProjectEnvelopeSignature(
        signer.publicKey,
        await projectVector(),
        fromHex(VERSION_SIGNATURE)
      )
    ).toEqual({ signedAt: 1_760_000_000_000 });
  });
});

describe('codes vectors', () => {
  it('hashes the fixed keys and shows the comparison code', async () => {
    const recipient = await importFixedPair(TEST_RECIPIENT_JWK, 'ECDH');
    const signer = await importFixedPair(TEST_SIGNER_JWK, 'ECDSA');
    const enc = await exportPublicKey(recipient.publicKey);
    const sig = await exportPublicKey(signer.publicKey);
    const identity = await publicKeyHash([enc, sig]);
    expect(toHex(await publicKeyHash(enc))).toMatchInlineSnapshot(
      `"776c2b0b033ea95265bda9af372d22bb62a27d2df23e079dfb59b0791e824708"`
    );
    expect(toHex(identity)).toMatchInlineSnapshot(
      `"0b08f9eff713bfe2f7bbd1534aefc483b165066bde471315de512301d232029b"`
    );
    expect(formatComparisonCode(identity)).toMatchInlineSnapshot(
      `"81811 68810 73342 14597 72229 99059 52365 94331"`
    );
    const fingerprint = await identityFingerprint(
      await exportPublicKey(
        (await importFixedPair(TEST_IDENTITY_JWK, 'ECDSA')).publicKey
      )
    );
    expect(fingerprint.code).toMatchInlineSnapshot(
      `"49834 55245 75749 62008 12420 82151 47782 33760"`
    );
  });

  it('derives the fixed contact verification code', async () => {
    const identity = await importFixedPair(TEST_IDENTITY_JWK, 'ECDSA');
    const { hash, code } = await contactVerificationCode(
      await exportPublicKey(identity.publicKey),
      patternBytes(32, 0x40)
    );
    expect(toHex(hash)).toMatchInlineSnapshot(
      `"2445255f7ec36d5af96cc407ba203bd678a08583df9fbfdc3a5d4fed2103153a"`
    );
    expect(code).toMatchInlineSnapshot(
      `"91660 43329 26261 93816 97604 51675 88935 65242"`
    );
  });

  it('derives the fixed project state code', async () => {
    const { hash, code } = await projectStateCode({
      versionHash: await versionHash(await projectVector()),
      documentVersion: 5,
      signerKeyHash: patternBytes(32, 0xe0)
    });
    expect(toHex(hash)).toMatchInlineSnapshot(
      `"89cf27110c7a15970ce26142a49c6fbc6a94ed9b66486317068a6b2f50fcbfc8"`
    );
    expect(code).toMatchInlineSnapshot(
      `"78789 04918 71313 44369 02699 23274 65283 58344"`
    );
  });

  it('derives the fixed approval commitment and code', async () => {
    const newDevicePublicKey = await exportPublicKey(
      (await importFixedPair(TEST_RECIPIENT_JWK, 'ECDH')).publicKey
    );
    const approverPublicKey = await exportPublicKey(
      (await importFixedPair(TEST_EPHEMERAL_JWK, 'ECDH')).publicKey
    );
    const { nonce, commitment } = await commitDeviceApprovalWith(
      newDevicePublicKey,
      queuedRandom(patternBytes(32, 0x60))
    );
    expect(toHex(commitment)).toMatchInlineSnapshot(
      `"1f2379c5a706d06fe5152e7bd52a1786bc9924387e11a2f9a19af0b3392f51b2"`
    );
    expect(
      await deviceApprovalCode({
        newDevicePublicKey,
        approverPublicKey,
        newDeviceNonce: nonce,
        approverNonce: patternBytes(32, 0x80)
      })
    ).toMatchInlineSnapshot(`"603 435"`);
  });

  it('formats the fixed recovery key and dedupe hash', async () => {
    expect(
      await formatRecoveryKey(patternBytes(32, 0x90))
    ).toMatchInlineSnapshot(
      `"J28S-54WM-JPB9-F64S-KADS-S7CY-KYGA-38N3-MJJT-D9X8-N6NA-QB5D-NTQJ-ZEYT"`
    );
    const dedupeKey = await importAssetDedupeSecret(patternBytes(32, 0x10));
    expect(
      await assetDedupeHash(dedupeKey, utf8('ISO-10303-21;'))
    ).toMatchInlineSnapshot(
      `"2773f97b7a136acc8879dec921294696f276e2a87a3a8956d727420795058483"`
    );
  });
});

describe('device list v1 vector', () => {
  it('encodes a fixed first entry and its paired approval commitment', async () => {
    const raw = async (
      jwk: typeof TEST_SIGNER_JWK,
      algorithm: 'ECDH' | 'ECDSA'
    ) => exportPublicKey((await importFixedPair(jwk, algorithm)).publicKey);
    const signingKey = await raw(TEST_SIGNER_JWK, 'ECDSA');
    const unlockKey = await raw(TEST_RECIPIENT_JWK, 'ECDH');
    const entry = encodeDeviceListEntry({
      userId: 'user_vector',
      sequence: 0,
      previousEntryHash: null,
      issuedAt: 1_760_000_000_000,
      previousIdentityKeyHash: null,
      encryptionKey: await raw(TEST_IDENTITY_JWK, 'ECDH'),
      accountKeyCommitment: await accountKeyCommitment(patternBytes(32, 0xa0)),
      devices: [
        {
          deviceId: 'dev_vector',
          label: 'Vector device',
          signingKey,
          unlockKey,
          addedAt: 1_760_000_000_000
        }
      ],
      unlockTargets: [
        {
          kind: 'recovery-key',
          targetId: 'rk_vector',
          publicKey: await raw(TEST_EPHEMERAL_JWK, 'ECDH'),
          addedAt: 1_760_000_000_000
        }
      ],
      revoked: []
    });
    expect(entry.byteLength).toMatchInlineSnapshot(`380`);
    expect(toHex(await deviceListEntryHash(entry))).toMatchInlineSnapshot(
      `"204a3f11c0f7482a9b193bf696dbec5190b6c5820766dbd7ec21955df10b14e8"`
    );
    const { commitment } = await commitDeviceApprovalWith(
      [signingKey, unlockKey],
      queuedRandom(patternBytes(32, 0x60))
    );
    expect(toHex(commitment)).toMatchInlineSnapshot(
      `"44b678e45f8953d389ae09934a82073cd891376a15c0c6e4a0ddd1548b184466"`
    );
  });
});

describe('device list v2 vector', () => {
  it('encodes a fixed removal that names its replacement', async () => {
    const raw = async (
      jwk: typeof TEST_SIGNER_JWK,
      algorithm: 'ECDH' | 'ECDSA'
    ) => exportPublicKey((await importFixedPair(jwk, algorithm)).publicKey);
    const entry = encodeDeviceListEntry({
      userId: 'user_vector',
      sequence: 1,
      // The hash of the device list v1 vector above.
      previousEntryHash: fromHex(
        '204a3f11c0f7482a9b193bf696dbec5190b6c5820766dbd7ec21955df10b14e8'
      ),
      issuedAt: 1_760_000_000_001,
      previousIdentityKeyHash: null,
      encryptionKey: await raw(TEST_IDENTITY_JWK, 'ECDH'),
      accountKeyCommitment: await accountKeyCommitment(patternBytes(32, 0xb0)),
      devices: [
        {
          deviceId: 'dev_vector',
          label: 'Vector device',
          signingKey: await raw(TEST_SIGNER_JWK, 'ECDSA'),
          unlockKey: await raw(TEST_RECIPIENT_JWK, 'ECDH'),
          addedAt: 1_760_000_000_000
        }
      ],
      unlockTargets: [
        {
          kind: 'recovery-key',
          targetId: 'rk_vector',
          publicKey: await raw(TEST_EPHEMERAL_JWK, 'ECDH'),
          addedAt: 1_760_000_000_000
        }
      ],
      revoked: [{ kind: 'device', id: 'dev_stolen', replacedBy: 'dev_vector' }]
    });
    expect(entry[3]).toBe(2);
    expect(entry.byteLength).toMatchInlineSnapshot(`435`);
    // u16 1 | u8 1 device | u8 10 "dev_stolen" | u8 10 "dev_vector"
    expect(toHex(entry.subarray(entry.byteLength - 25))).toMatchInlineSnapshot(
      `"0001010a6465765f73746f6c656e0a6465765f766563746f72"`
    );
    expect(toHex(await deviceListEntryHash(entry))).toMatchInlineSnapshot(
      `"3da3ad170d4d7c138cf3a0d8de935523f2679126eac150a449bce9cea298a442"`
    );
  });
});

// A recorded signature by the fixed signer key, standing in for an
// identity key, over the revocation cutoffs vector.
const CUTOFFS_SIGNATURE =
  '01b1d731b20a337b19caa34dad68fb1cdbc293f2132be6b3a7b79747543785f1ae09b4989e4d412d20456e391afa567d516b6356a6df16d5f1057bc8a55d632984';

describe('revocation cutoffs v1 vector', () => {
  const value = {
    userId: 'user_vector',
    generation: 1,
    entrySequence: 1,
    entryHash: patternBytes(32, 0xe0),
    issuedAt: 1_760_000_000_001,
    cutoffs: [
      { projectId: 'prj_2', cutoffEpoch: 9 },
      { projectId: 'prj_1', cutoffEpoch: 4 }
    ]
  };

  it('encodes fixed cutoffs and verifies a recorded signature with raw WebCrypto', async () => {
    const statement = encodeRevocationCutoffs(value);
    expect(toHex(statement)).toMatchInlineSnapshot(
      `"4f5a52010b757365725f766563746f720000000100000001e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff00000199c82cc00100020570726a5f3100000000000000040570726a5f320000000000000009"`
    );
    const signer = await importFixedPair(TEST_SIGNER_JWK, 'ECDSA');
    const signature = fromHex(CUTOFFS_SIGNATURE);
    expect(signature[0]).toBe(1);
    // ECDSA P-256 SHA-256 over label "v1 revocation cutoffs signature" | statement.
    expect(
      await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        signer.publicKey,
        signature.subarray(1),
        concatBytes(
          utf8('OpenZCAD E2EE v1 revocation cutoffs signature'),
          statement
        )
      )
    ).toBe(true);
  });
});

describe('project data vectors', () => {
  const kindVector = (kind: 'project-info' | 'key-archive') =>
    encryptProjectEnvelope(
      envelopeKeyFromBytes(VERSION_KEY),
      { ...HEADER, kind, blobIds: [] },
      PLAINTEXT
    );

  it('codes a project-info envelope as kind 5', async () => {
    const envelope = await kindVector('project-info');
    // Byte 9 is the kind; the rest follows the document layout.
    expect(envelope[9]).toBe(5);
    expect(toHex(parseEnvelope(envelope).prefix)).toMatchInlineSnapshot(
      `"4f5a45010000006801050000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f310000"`
    );
    expect(toHex(envelope)).toMatchInlineSnapshot(
      `"4f5a45010000006801050000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f31000041ccd0b0ef6fc2f928cdc7437d40fee9b76322365bf54059e5fdc7ecb7d17d193e3a88e669b3fc2656ad0790ada1192b897324950d5130c033c2505464400194776bcad4256c4db45b779b3c3dac06030d63da358bfe9a8b630caa878e8d6b0ab4fd9d1bf92e807fc5adbfdc17420a162bf7d0bd70235a77252ccec385"`
    );
  });

  it('codes a key-archive envelope as kind 6', async () => {
    const envelope = await kindVector('key-archive');
    expect(envelope[9]).toBe(6);
    expect(toHex(parseEnvelope(envelope).prefix)).toMatchInlineSnapshot(
      `"4f5a45010000006801060000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f310000"`
    );
    expect(toHex(envelope)).toMatchInlineSnapshot(
      `"4f5a45010000006801060000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f31000041ccd0b0ef6fc2f928cdc7437d40fee9b76322365bf54059e5fdc7ecb7d17d193e3a88e669b3fc2656ad0790ada1192b897324950d5130c033c2505464400194155cbc930acb3d774f4c0ec70fe121ee0d63da358bfe9a8b630caa878e8d6b0ab4fd9d1bf92e807fc5adbfdc1718c6fb69b64616260745e55619cbc461"`
    );
  });

  it('derives the fixed epoch binding, re-derived with raw WebCrypto', async () => {
    const authenticator = patternBytes(32, 0xb0);
    const binding = await epochBinding('prj_1', 1, authenticator);
    expect(toHex(binding)).toMatchInlineSnapshot(
      `"66840854760abafa110678ea0ee957f609007ea80cff13b4e56a05940881a2b6"`
    );
    // SHA-256(label | u8 len + project id | u32 key epoch | u8 len + authenticator)
    const raw = new Uint8Array(
      await subtle.digest(
        'SHA-256',
        concatBytes(
          utf8('OpenZCAD E2EE v1 epoch binding'),
          Uint8Array.of(5),
          utf8('prj_1'),
          Uint8Array.of(0, 0, 0, 1),
          Uint8Array.of(32),
          authenticator
        )
      )
    );
    expect(raw).toEqual(binding);
  });

  const wrapVector = async (context: WrapContext) => {
    const wrapped = await wrapKey(KEK, WRAPPED_SECRET, context);
    expect(await unwrapKey(KEK, wrapped, context)).toEqual(WRAPPED_SECRET);
    return { context: toHex(encodeWrapContext(context)), wrap: toHex(wrapped) };
  };

  it('produces the fixed rejoin-psk wrap', async () => {
    expect(
      await wrapVector({
        purpose: 'rejoin-psk',
        userId: 'usr_1',
        projectId: 'prj_1',
        keyEpoch: 7
      })
    ).toMatchInlineSnapshot(`
      {
        "context": "086b657945706f63680200000000000000070970726f6a656374496401000570726a5f3107707572706f736501000a72656a6f696e2d70736b067573657249640100057573725f31",
        "wrap": "02e5bdafb70e3f87ac40825cfdf1683742463c197250ef54a277dfd4685f112b4b86be5a3fa2840753",
      }
    `);
  });

  it('produces the fixed archived-project-key wrap', async () => {
    expect(
      await wrapVector({
        purpose: 'archived-project-key',
        projectId: 'prj_1',
        archivedEpoch: 0,
        underEpoch: 1
      })
    ).toMatchInlineSnapshot(`
      {
        "context": "0d617263686976656445706f63680200000000000000000970726f6a656374496401000570726a5f3107707572706f736501001461726368697665642d70726f6a6563742d6b65790a756e64657245706f6368020000000000000001",
        "wrap": "028b0f51b06b7da52ce55e781f3fb455343965288158275e8a68894be1afd1ce7c592502faf85c499c",
      }
    `);
  });

  it('produces the fixed previous-account-key wrap', async () => {
    expect(
      await wrapVector({
        purpose: 'previous-account-key',
        userId: 'usr_1',
        generation: 1,
        keySequence: 2
      })
    ).toMatchInlineSnapshot(`
      {
        "context": "0a67656e65726174696f6e0200000000000000010b6b657953657175656e636502000000000000000207707572706f736501001470726576696f75732d6163636f756e742d6b6579067573657249640100057573725f31",
        "wrap": "02074482bb3f13c74326b5d84666116da1a3fb53382684e8a90f074a4fa7f72370f85068e749d51f07",
      }
    `);
  });

  it('encodes the fixed version log record of the envelope vector', async () => {
    const record = await versionLogRecord(
      await projectVector(),
      fromHex(VERSION_SIGNATURE)
    );
    const encoded = encodeVersionLogRecord(record);
    // "OZV" | 1 | u32 prefix length | prefix | version hash | u8 73 | signature
    expect(toHex(encoded)).toMatchInlineSnapshot(
      `"4f5a5601000000914f5a45010000008901010000000040000000000000005d0000001700000001000000000000000520a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f310001203730373137323733373437353736373737383739376137623763376437653766319935295d2b281ed58c71760f5936274f3bb923762e0e9c6c4f8cb7cc2e1426490100000199c82cc000490ad620f6a014d8a29e34a5fa46571999c909682e86ee4331409a368d23954ad4448a3983dcc657f7fcb29d6b74602bd37919179b2ed6f9206b243c54fe9464"`
    );
    expect(toHex(record.versionHash)).toBe(
      '319935295d2b281ed58c71760f5936274f3bb923762e0e9c6c4f8cb7cc2e1426'
    );
    const signer = await importFixedPair(TEST_SIGNER_JWK, 'ECDSA');
    const log = await verifyVersionLog([decodeVersionLogRecord(encoded)], {
      pinnedVersionHash: record.versionHash,
      resolveSigningKey: () => signer.publicKey
    });
    expect(log.head.signedAt).toBe(1_760_000_000_000);
  });

  it('encodes a fixed key archive body', () => {
    const body = encodeKeyArchiveBody(
      {
        previousKeys: [{ keyEpoch: 0, key: patternBytes(32, 0x00) }],
        dedupeSecret: patternBytes(32, 0x20),
        epochRecord: patternBytes(8, 0x40),
        epochAuthenticator: patternBytes(32, 0x60)
      },
      { kind: 'key-archive', keyEpoch: 1, blobIds: [] }
    );
    expect(new TextDecoder().decode(body)).toMatchInlineSnapshot(
      `"{"version":1,"previousKeys":[{"keyEpoch":0,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}],"dedupeSecret":"ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8","epochRecord":"QEFCQ0RFRkc","epochAuthenticator":"YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8"}"`
    );
  });
});

// A recorded signature by the fixed identity key over the contacts entry
// vector below.
const CONTACTS_SIGNATURE =
  '0117f76fc521ccfa9d3d245522ac35b0b64a6bf5034d15adfac02b6f7b87ed5dc069f69665f5a4d0ac62d75b45a23009f3f5c3f6894395c953188593e165f0278e';

describe('contacts entry v1 vector', () => {
  it('encodes a fixed verification and checks a recorded signature with raw WebCrypto', async () => {
    const signer = await importFixedPair(TEST_SIGNER_JWK, 'ECDSA');
    const contactIdentity = await publicKeyHash(
      await exportPublicKey(signer.publicKey)
    );
    const entry = encodeContactsEntry({
      userId: 'user_vector',
      sequence: 1,
      previousEntryHash: patternBytes(32, 0xa0),
      issuedAt: 1_760_000_000_002,
      action: 'verify',
      contactUserId: 'user_contact',
      identityKeyHash: contactIdentity,
      // The hash of the device list v1 vector above.
      deviceListHead: {
        sequence: 0,
        entryHash: fromHex(
          '204a3f11c0f7482a9b193bf696dbec5190b6c5820766dbd7ec21955df10b14e8'
        )
      }
    });
    // "OZK" | 1 | u32 1 | u8 32 + previous | u8 11 "user_vector" | u64
    // issuedAt | u8 1 verify | u8 12 "user_contact" | identity key hash |
    // u32 0 | device-list entry hash
    expect(toHex(entry)).toMatchInlineSnapshot(
      `"4f5a4b010000000120a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf0b757365725f766563746f7200000199c82cc002010c757365725f636f6e746163747c48bdb0d12667c8d36fb0be229cbe23adfe9cc429f0b4820d16b8a5f84c700b00000000204a3f11c0f7482a9b193bf696dbec5190b6c5820766dbd7ec21955df10b14e8"`
    );
    expect(toHex(await contactsEntryHash(entry))).toMatchInlineSnapshot(
      `"ae661f9ec22df754dfdd8cb254504a200bd1f3c626fde6f7386bbffee41d72c3"`
    );
    expect(decodeContactsEntry(entry).contactUserId).toBe('user_contact');
    const identity = await importFixedPair(TEST_IDENTITY_JWK, 'ECDSA');
    const signature = fromHex(CONTACTS_SIGNATURE);
    expect(signature[0]).toBe(1);
    // ECDSA P-256 SHA-256 over label "v1 contacts list signature" | entry.
    expect(
      await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        identity.publicKey,
        signature.subarray(1),
        concatBytes(utf8('OpenZCAD E2EE v1 contacts list signature'), entry)
      )
    ).toBe(true);
    // The entry is second in its list, so the recorded signature verifies
    // as part of a chain only after its predecessor; alone it is refused.
    await expect(
      verifyContactsList(identity.publicKey, [{ entry, signature }])
    ).rejects.toMatchObject({ code: 'chain-broken' });
  });
});

// Recorded signatures over the share-link vectors below: the delegation by
// the fixed identity key, the others by the fixed device key as the owner's
// device.
const SHARE_DELEGATION_SIGNATURE =
  '0167b5d38a6ac7c7520ff66b07ee2b0d205054be8f5880885c288fa1f4c51b2a4eb19e9e514e9b5918d06131261ccca06b16a48bca29b47286772846cb28fef224';
const SHARE_AUTHORITY_SIGNATURE =
  '01a615b3f4eb7a1c9068cfadb0dea7b1e42ed9917badb5f04d3a6aff1d227e4db1e72f47440e297b566ef1c710b88e68e68d824897eaf68c3a1935fd573c2025b1';
const SHARE_GRANT_SIGNATURE =
  '01cf05e0dd7c94295359ef80cd88cc0fe070c14c5c33491cb0dbd1f02f4c184e43d91550cb3f59dff3f4d4cb84715d9851b292ce0bed5c7a948d1f9d0ad97832cc';
const SHARE_TOMBSTONE_SIGNATURE =
  '012aaff8f7367e986fbbbfae00cab7fb4df8b4795faa9145a946b099009d9c3381acb4136ed2d2844853d01f13c401e5a2454318a84e059527a804edad6430a654';

describe('share-link v1 vectors', () => {
  const T = 1_760_000_000_000;
  const DAY = 86_400_000;
  const SHARE_KEY = patternBytes(32, 0x50);

  async function fixed() {
    const identity = await importFixedPair(TEST_IDENTITY_JWK, 'ECDSA');
    const device = await importFixedPair(TEST_SIGNER_JWK, 'ECDSA');
    const identityRaw = await exportPublicKey(identity.publicKey);
    const deviceRaw = await exportPublicKey(device.publicKey);
    return {
      identity,
      device,
      identityRaw,
      deviceRaw,
      identityHash: await publicKeyHash(identityRaw),
      deviceHash: await publicKeyHash(deviceRaw),
      keyHash: await shareKeyHash(SHARE_KEY)
    };
  }

  const ecdsaValid = (
    key: CryptoKey,
    signature: string,
    kind: string,
    statement: Uint8Array
  ) =>
    subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      fromHex(signature).subarray(1),
      concatBytes(utf8(`OpenZCAD E2EE v1 ${kind} signature`), statement)
    );

  it('hashes a share key, re-derived with raw WebCrypto', async () => {
    const hash = await shareKeyHash(SHARE_KEY);
    expect(toHex(hash)).toMatchInlineSnapshot(
      `"c18b83d57c941eb5c441e32d0d32ee75ad9ee594487864f707708a7028743a95"`
    );
    const raw = new Uint8Array(
      await subtle.digest(
        'SHA-256',
        concatBytes(utf8('OpenZCAD E2EE v1 share key hash'), SHARE_KEY)
      )
    );
    expect(raw).toEqual(hash);
  });

  it('encodes a fixed delegation and checks a recorded identity signature with raw WebCrypto', async () => {
    const f = await fixed();
    const statement = encodeShareDelegation({
      identityKeyHash: f.identityHash,
      sequence: 1,
      issuedAt: T,
      expiresAt: T + 30 * DAY,
      deviceKeys: [f.deviceRaw]
    });
    // "OZS" | 1 | identity key hash | u32 1 | u64 issuedAt | u64 expiresAt |
    // u8 1 + 65-byte device key
    expect(toHex(statement)).toMatchInlineSnapshot(
      `"4f5a5301c5c2ef3d0437209cec6e3da899699f29b09f738851aea7379f589b443c62cba00000000100000199c82cc0000000019a62ab88000104e351addbbadcbfe457247313321051979c2d07fe131aa0ba08dcfcbb62301dfcd384557ec129c023cbd4be64d2bfc3ee9c44989c47f13691b9a32832bf8625b4"`
    );
    expect(decodeShareDelegation(statement).deviceKeys).toEqual([f.deviceRaw]);
    expect(
      await ecdsaValid(
        f.identity.publicKey,
        SHARE_DELEGATION_SIGNATURE,
        'share delegation',
        statement
      )
    ).toBe(true);
    await verifyShareDelegation(
      { statement, signature: fromHex(SHARE_DELEGATION_SIGNATURE) },
      f.identityRaw,
      { now: T + DAY, ownerIdentityKeyHash: f.identityHash }
    );
  });

  it('encodes a fixed share-authority statement and checks a recorded signature with raw WebCrypto', async () => {
    const f = await fixed();
    const statement = encodeShareAuthority({
      projectId: 'prj_1',
      shareId: 'shr_1',
      shareKeyHash: f.keyHash,
      mode: 'view',
      ownerIdentityKeyHash: f.identityHash,
      sequence: 2,
      issuedAt: T,
      expiresAt: T + 7 * DAY,
      signerKeyHash: f.deviceHash,
      authorKeyHashes: [f.deviceHash, patternBytes(32, 0xc0)]
    });
    // "OZA" | 1 | u8 5 "prj_1" | u8 5 "shr_1" | share key hash | u8 1 view |
    // owner identity key hash | u32 2 | u64 issuedAt | u64 expiresAt |
    // signer key hash | u16 2 + sorted author key hashes
    expect(toHex(statement)).toMatchInlineSnapshot(
      `"4f5a41010570726a5f31057368725f31c18b83d57c941eb5c441e32d0d32ee75ad9ee594487864f707708a7028743a9501c5c2ef3d0437209cec6e3da899699f29b09f738851aea7379f589b443c62cba00000000200000199c82cc00000000199ec3944007c48bdb0d12667c8d36fb0be229cbe23adfe9cc429f0b4820d16b8a5f84c700b00027c48bdb0d12667c8d36fb0be229cbe23adfe9cc429f0b4820d16b8a5f84c700bc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf"`
    );
    expect(decodeShareAuthority(statement).mode).toBe('view');
    expect(
      await ecdsaValid(
        f.device.publicKey,
        SHARE_AUTHORITY_SIGNATURE,
        'share authority',
        statement
      )
    ).toBe(true);
    const delegation = decodeShareDelegation(
      encodeShareDelegation({
        identityKeyHash: f.identityHash,
        sequence: 1,
        issuedAt: T,
        expiresAt: T + 30 * DAY,
        deviceKeys: [f.deviceRaw]
      })
    );
    const verified = await verifyShareAuthority(
      { statement, signature: fromHex(SHARE_AUTHORITY_SIGNATURE) },
      delegation,
      { now: T + DAY, expected: { shareKeyHash: f.keyHash } }
    );
    expect(verified.shareId).toBe('shr_1');
  });

  it('encodes a fixed grant and tombstone and checks recorded signatures with raw WebCrypto', async () => {
    const f = await fixed();
    const grant = encodeShareLinkGrant({
      projectId: 'prj_1',
      shareId: 'shr_1',
      shareKeyHash: f.keyHash,
      mode: 'view',
      keyEpoch: 1,
      issuedAt: T,
      signerKeyHash: f.deviceHash
    });
    // "OZL" | 1 | u8 5 "prj_1" | u8 5 "shr_1" | share key hash | u8 1 view |
    // u32 1 | u64 issuedAt | signer key hash
    expect(toHex(grant)).toMatchInlineSnapshot(
      `"4f5a4c010570726a5f31057368725f31c18b83d57c941eb5c441e32d0d32ee75ad9ee594487864f707708a7028743a95010000000100000199c82cc0007c48bdb0d12667c8d36fb0be229cbe23adfe9cc429f0b4820d16b8a5f84c700b"`
    );
    const tombstone = encodeShareLinkTombstone({
      projectId: 'prj_1',
      shareId: 'shr_0',
      keyEpoch: 1,
      issuedAt: T,
      signerKeyHash: f.deviceHash
    });
    // "OZY" | 1 | u8 5 "prj_1" | u8 5 "shr_0" | u32 1 | u64 issuedAt |
    // signer key hash
    expect(toHex(tombstone)).toMatchInlineSnapshot(
      `"4f5a59010570726a5f31057368725f300000000100000199c82cc0007c48bdb0d12667c8d36fb0be229cbe23adfe9cc429f0b4820d16b8a5f84c700b"`
    );
    expect(decodeShareLinkGrant(grant).keyEpoch).toBe(1);
    expect(decodeShareLinkTombstone(tombstone).shareId).toBe('shr_0');
    expect(
      await ecdsaValid(
        f.device.publicKey,
        SHARE_GRANT_SIGNATURE,
        'share link grant',
        grant
      )
    ).toBe(true);
    expect(
      await ecdsaValid(
        f.device.publicKey,
        SHARE_TOMBSTONE_SIGNATURE,
        'share link tombstone',
        tombstone
      )
    ).toBe(true);
    // The same set in a fixed version 2 document body.
    const set = {
      grants: [{ statement: grant, signature: fromHex(SHARE_GRANT_SIGNATURE) }],
      tombstones: [
        { statement: tombstone, signature: fromHex(SHARE_TOMBSTONE_SIGNATURE) }
      ]
    };
    const header = { kind: 'document' as const, keyEpoch: 1, blobIds: [] };
    const body = encodeEncryptedDocumentBody(
      {
        document: { name: 'n' },
        blobs: [],
        revisionVersionHashes: new Map(),
        shareLinks: set
      },
      header
    );
    expect(new TextDecoder().decode(body)).toMatchInlineSnapshot(
      `"{"version":2,"document":{"name":"n"},"blobs":[],"revisionVersionHashes":{},"shareLinks":{"grants":[{"grant":"T1pMAQVwcmpfMQVzaHJfMcGLg9V8lB61xEHjLQ0y7nWtnuWUSHhk9wdwinAodDqVAQAAAAEAAAGZyCzAAHxIvbDRJmfI02-wviKcviOt_pzEKfC0gg0WuKX4THAL","signature":"Ac8F4N18lClTWe-AzYjMD-BwwUxcM0kcsNvR8C9MGE5D2RVQyz9Z3_P01MuEcV2YUbKSzgvtXHqUjR-dCtl4Msw"}],"tombstones":[{"tombstone":"T1pZAQVwcmpfMQVzaHJfMAAAAAEAAAGZyCzAAHxIvbDRJmfI02-wviKcviOt_pzEKfC0gg0WuKX4THAL","signature":"ASqv-Pc2fphvu7-uAMq3-034tHlfqpFFqUawmQCdnDOBrLQTbtLShEhT0B8TxAHlokVDGKhOBZUnqATtrWQwplQ"}]}}"`
    );
    const verified = await verifyShareLinkSet(
      decodeEncryptedDocumentBody(body, header).shareLinks!,
      {
        projectId: 'prj_1',
        keyEpoch: 1,
        resolveOwnerKey: () => f.deviceRaw
      }
    );
    expect(verified.links[0]!.shareKeyHash).toEqual(f.keyHash);
  });

  it('produces the fixed share-key and share-version-key wraps', async () => {
    const vector = async (context: WrapContext) => {
      const wrapped = await wrapKey(KEK, WRAPPED_SECRET, context);
      expect(await unwrapKey(KEK, wrapped, context)).toEqual(WRAPPED_SECRET);
      return {
        context: toHex(encodeWrapContext(context)),
        wrap: toHex(wrapped)
      };
    };
    expect(
      await vector({
        purpose: 'share-key',
        projectId: 'prj_1',
        keyEpoch: 1,
        shareId: 'shr_1'
      })
    ).toMatchInlineSnapshot(`
      {
        "context": "086b657945706f63680200000000000000010970726f6a656374496401000570726a5f3107707572706f736501000973686172652d6b657907736861726549640100057368725f31",
        "wrap": "0210e19205f8c6fd633d02ad5d8d23bf9e3b99446135e145730c019ae834211b167d4797fc18f72920",
      }
    `);
    expect(
      await vector({
        purpose: 'share-version-key',
        projectId: 'prj_1',
        keyEpoch: 1,
        shareId: 'shr_1',
        versionId: '9'
      })
    ).toMatchInlineSnapshot(`
      {
        "context": "086b657945706f63680200000000000000010970726f6a656374496401000570726a5f3107707572706f736501001173686172652d76657273696f6e2d6b657907736861726549640100057368725f310976657273696f6e496401000139",
        "wrap": "02ea30abedd7dd2e8bf1d9ceebd445f89013fc23cb2ee70759b4a9f99006c267ce18e57e37d41c5fcd",
      }
    `);
  });
});
