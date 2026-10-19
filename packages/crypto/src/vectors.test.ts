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
  deriveAssetDedupeKey,
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
  encodeContactsEntry,
  isVerifiedContact,
  verifyContactsList,
  type ContactsListEntry
} from './contacts';
import {
  deviceListEntryHash,
  encodeDeviceListEntry,
  readDeviceSignature,
  verifyDeviceList,
  type DeviceListEntry
} from './devices';
import { exportPublicKey } from './keys';
import {
  encodeRosterEntry,
  rosterEntryHash,
  verifyRosterChain,
  type RosterEntry
} from './roster';
import { verifyProjectEnvelopeSignature, versionHash } from './signing';
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
  rosterEntryHash: patternBytes(32, 0xc0),
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
      `"4f5a4501000000890101000000004000000017000000010000000000000005000000000000005d20a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f310001203730373137323733373437353736373737383739376137623763376437653766"`
    );
  });

  it('produces the fixed ciphertext', async () => {
    const envelope = await projectVector();
    expect(toHex(envelope)).toMatchInlineSnapshot(
      `"4f5a4501000000890101000000004000000017000000010000000000000005000000000000005d20a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf0570726a5f31000120373037313732373337343735373637373738373937613762376337643765376641ccd0b0ef6fc2f928cdc7437d40fee9b76322365bf54059e5fdc7ecb7d17d193e3a88e669b3fc2656ad0790ada1192b897324950d5130c033c250546440019435e3211fe04b90ed5b85d496d95cf97c0d63da358bfe9a8b630caa878e8d6b0ab4fd9d1bf92e807fc5adbfdc17243db3f74f568329a3951bbb4ad72791"`
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
      `"faf47c226f52bfdcaca387eb1518772e8b616bfd8aa676fd03b1b598fa4be587"`
    );
  });
});

describe('content blob v1 vector', () => {
  it('produces the fixed blob and reference', async () => {
    const { envelope, reference } = await contentVector();
    expect(reference.blobId).toBe(toHex(BLOB_ID_RANDOM));
    expect(toHex(envelope)).toMatchInlineSnapshot(
      `"4f5a4501000000280201000000004020373037313732373337343735373637373738373937613762376337643765376615445516ce2b93eff8eef6855a910d364aa274fbe5629127dec7a9929c1e3209b356d7d85fde4061f0df9abf811bec589adb82e0c43480bf2b9bb7994fae870c0d07db9e1b90fa29bccba73218873ebe1da07ee2684afbdc95606b37e54e8c8264e6724bb2499b526ee40194b9dcf00b33746a559e4bb1d4d91c917645"`
    );
    expect(toHex(reference.ciphertextHash)).toMatchInlineSnapshot(
      `"675c7c82a00d3bbe33f7bae6b07fe1dac6b5b2e0a0fafd2450548e5187b1abc8"`
    );
    expect(await decryptContentBlob(reference, envelope)).toEqual(PLAINTEXT);
  });

  it('re-derives the plaintext and ciphertext hash with raw WebCrypto', async () => {
    const { envelope, reference } = await contentVector();
    const { prefix, chunks } = await rawDecrypt(BLOB_KEY, envelope, 64);
    expect(concatBytes(...chunks)).toEqual(PLAINTEXT);
    const body = envelope.subarray(prefix.byteLength);
    const digests = [prefix, body.subarray(0, 80), body.subarray(80)].map(
      async (part) =>
        new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(part)))
    );
    const hash = await subtle.digest(
      'SHA-256',
      concatBytes(
        utf8('OpenZCAD E2EE v1 content blob hash'),
        ...(await Promise.all(digests))
      )
    );
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

/** Fixed keys: identity, the device that signs, and the encryption key. */
async function fixedUser() {
  const identity = await importFixedPair(TEST_IDENTITY_JWK, 'ECDSA');
  const device = await importFixedPair(TEST_SIGNER_JWK, 'ECDSA');
  const encryption = await importFixedPair(TEST_RECIPIENT_JWK, 'ECDH');
  const deviceKey = await exportPublicKey(device.publicKey);
  const entry: DeviceListEntry = {
    userId: 'usr_1',
    sequence: 0,
    previousEntryHash: null,
    encryptionKey: await exportPublicKey(encryption.publicKey),
    devices: [{ deviceId: 'dev_1', signingKey: deviceKey }],
    cutoffs: []
  };
  return {
    identity,
    device,
    deviceKeyHash: await publicKeyHash(deviceKey),
    entry
  };
}

async function sealedVector(): Promise<Uint8Array> {
  return sealKeyWith(
    (await importFixedPair(TEST_RECIPIENT_JWK, 'ECDH')).publicKey,
    WRAPPED_SECRET,
    {
      purpose: 'project-key',
      userId: 'usr_1',
      projectId: 'prj_1',
      keyEpoch: 1
    },
    await importFixedPair(TEST_EPHEMERAL_JWK, 'ECDH'),
    queuedRandom(patternBytes(12, 0xd0))
  );
}

async function rosterVector(): Promise<RosterEntry> {
  const owner = await importFixedPair(TEST_IDENTITY_JWK, 'ECDSA');
  return {
    type: 'membership',
    projectId: 'prj_1',
    sequence: 0,
    keyEpoch: 1,
    previousEntryHash: null,
    members: [
      {
        userId: 'usr_1',
        identityKeyHash: await publicKeyHash(
          await exportPublicKey(owner.publicKey)
        ),
        role: 'owner'
      },
      {
        userId: 'usr_2',
        identityKeyHash: patternBytes(32, 0xf0),
        role: 'viewer'
      }
    ],
    keyWraps: [
      { userId: 'usr_1', sealedKey: await sealedVector() },
      { userId: 'usr_2', sealedKey: patternBytes(16, 0x20) }
    ]
  };
}

const CONTACTS_ENTRY: ContactsListEntry = {
  ownerUserId: 'usr_1',
  sequence: 0,
  previousEntryHash: null,
  action: 'verify',
  contactUserId: 'usr_2',
  identityKeyHash: patternBytes(32, 0xf0),
  deviceListHead: patternBytes(32, 0x40),
  replacementKeyHash: null
};

describe('device list and signature vectors', () => {
  // ECDSA signatures are randomized, so these are recorded signatures over
  // the fixed inputs that must keep verifying.
  const DEVICE_LIST_SIGNATURE =
    '01ac20e8853739d0d11dc1eac1fdcaf044edfc8270b101ff13dba5c60b7789013252b413cb5b18decc60e9b3826ccb1f3369f905405d86b644b546878e2aba65f3';
  const VERSION_SIGNATURE =
    '01057573725f31000000007c48bdb0d12667c8d36fb0be229cbe23adfe9cc429f0b4820d16b8a5f84c700b00000199c82cc0009d5012c239b88f7447fc858b1b2cd5e8c48860e201c6e3df27c5fca6c6fe7db1a59a9c778842abc982998efa3af0e295796dced3acfc8d6fc43b2336386e9d3d';
  const CONTACTS_SIGNATURE =
    '01581284e4a912f950041a42603fc25c254f4a9d2838eddf3bc20245babc4f7dcd4aa684669fe738ee9c47055f1c162cc39840096d731167a454975207cf41d82d';
  const ROSTER_SIGNATURE =
    '01057573725f31000000007c48bdb0d12667c8d36fb0be229cbe23adfe9cc429f0b4820d16b8a5f84c700b00000199c82cc000901194288c000452e9eb0ce597b7a849eb985d0d867e54942208b20bcc241824f2cac156338eff7d5cbe96437e0fd8d831db6d863af8fd285d7e60a14aad8a28';

  async function verifiedList() {
    const { identity, entry } = await fixedUser();
    return verifyDeviceList(identity.publicKey, [
      {
        entry: encodeDeviceListEntry(entry),
        signature: fromHex(DEVICE_LIST_SIGNATURE)
      }
    ]);
  }

  it('encodes the device-list entry and verifies its identity signature', async () => {
    const { entry } = await fixedUser();
    const bytes = encodeDeviceListEntry(entry);
    expect(toHex(bytes)).toMatchInlineSnapshot(
      `"4f5a44010000000000057573725f3104225fe504ce70d16a207f90da884b5d27f4146b46f240fa00a24cccba32a7a4272a1fbe11a064b88a822775a57aa8d5c81607729fedfe3b9812da1a925999b43a0001056465765f3104e351addbbadcbfe457247313321051979c2d07fe131aa0ba08dcfcbb62301dfcd384557ec129c023cbd4be64d2bfc3ee9c44989c47f13691b9a32832bf8625b40000"`
    );
    expect(toHex(await deviceListEntryHash(bytes))).toMatchInlineSnapshot(
      `"c41e95b7a01036f7c3298e52d69ea31b02e21f292f76e559bf4d9dc48a0abb27"`
    );
    const list = await verifiedList();
    expect(list.devices.map((d) => d.deviceId)).toEqual(['dev_1']);
    expect(toHex(list.identityKeyHash)).toMatchInlineSnapshot(
      `"c5c2ef3d0437209cec6e3da899699f29b09f738851aea7379f589b443c62cba0"`
    );
  });

  it('verifies the recorded version signature against the device list', async () => {
    const signature = fromHex(VERSION_SIGNATURE);
    expect(readDeviceSignature(signature)).toMatchObject({
      userId: 'usr_1',
      deviceListSequence: 0,
      signedAt: 1_760_000_000_000
    });
    expect(
      await verifyProjectEnvelopeSignature(
        await verifiedList(),
        await projectVector(),
        signature
      )
    ).toMatchObject({ deviceId: 'dev_1', signedAt: 1_760_000_000_000 });
  });

  it('encodes the contacts entry and verifies its recorded signature', async () => {
    const { identity } = await fixedUser();
    const entry = encodeContactsEntry(CONTACTS_ENTRY);
    expect(toHex(entry)).toMatchInlineSnapshot(
      `"4f5a43010000000000057573725f3101057573725f32f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff000102030405060708090a0b0c0d0e0f20404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f00"`
    );
    expect(toHex(await contactsEntryHash(entry))).toMatchInlineSnapshot(
      `"a6920b80cd1bb665fbd1f6a2e0707a59356b0c9836e2de051b5a8f86e601d414"`
    );
    const list = await verifyContactsList(identity.publicKey, [
      { entry, signature: fromHex(CONTACTS_SIGNATURE) }
    ]);
    expect(isVerifiedContact(list, 'usr_2', patternBytes(32, 0xf0))).toBe(true);
  });

  it('encodes the roster entry and verifies its recorded signature', async () => {
    const entry = encodeRosterEntry(await rosterVector());
    expect(toHex(entry)).toMatchInlineSnapshot(
      `"4f5a5201010000000000000001000570726a5f310002057573725f31c5c2ef3d0437209cec6e3da899699f29b09f738851aea7379f589b443c62cba001057573725f32f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff000102030405060708090a0b0c0d0e0f030002057573725f31007e010482fb6c30813d84508322c122efce43026e7dcea6f0de9d961a6df375f86fa2e43f13841960e6c63aa427f8e019c41cabc8b60a6ab516b3e8eca9c754e5e8385ed0d1d2d3d4d5d6d7d8d9dadbfe59717957995a878dcf5398e698853d13a567337d4e5c7e8e0877a78da169b507307627a4e44cedc21acb64652ad48d057573725f320010202122232425262728292a2b2c2d2e2f"`
    );
    expect(toHex(await rosterEntryHash(entry))).toMatchInlineSnapshot(
      `"c8bd8364cc0123186c7b48d0cf4f9cab02ef25f07659b0d27f36d56d022f9632"`
    );
    const list = await verifiedList();
    const [verified] = await verifyRosterChain(
      [{ entry, signature: fromHex(ROSTER_SIGNATURE), signedBy: 'device' }],
      () => list
    );
    expect(verified?.signer.device?.deviceId).toBe('dev_1');
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
      `"5baf7fe08f560c97c18eb904441e864d2a1c2996cfb40cfb0b10efcb7567b39f"`
    );
    expect(code).toMatchInlineSnapshot(
      `"17461 04252 71970 27657 76822 67600 47465 39935"`
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
    const dedupeKey = await deriveAssetDedupeKey(patternBytes(32, 0x10));
    expect(
      await assetDedupeHash(dedupeKey, utf8('ISO-10303-21;'))
    ).toMatchInlineSnapshot(
      `"dced290b127ab7fb4c2083915c308a114a55fc6d8bfdeb7b3cb5786f1de724c0"`
    );
  });
});
