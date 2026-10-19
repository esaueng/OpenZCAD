/**
 * Seeded fuzzing of every parser that reads bytes the server hands back:
 * both envelope classes (structure and decryption, one-shot and
 * incremental), wrapped and sealed keys and version signatures. Whatever
 * the input, each call either succeeds or throws an `E2eeError`; never a
 * TypeError, RangeError or a DOMException leaking out of WebCrypto.
 */
import { describe, expect, it } from 'vitest';
import { concatBytes, type Bytes } from './bytes';
import {
  EnvelopeKey,
  createContentBlobReader,
  decryptContentBlob,
  decryptProjectEnvelope,
  encryptContentBlob,
  encryptProjectEnvelope,
  parseEnvelope
} from './envelope';
import { E2eeError } from './errors';
import { generateEncryptionKeyPair, generateSigningKeyPair } from './keys';
import { signProjectEnvelope, verifyProjectEnvelopeSignature } from './signing';
import { patternBytes, seededRandom } from './test-support';
import {
  openSealedKey,
  sealKey,
  unwrapKey,
  wrapKey,
  type SealContext,
  type WrapContext
} from './wrap';

const WRAP_CONTEXT: WrapContext = {
  purpose: 'version-key',
  projectId: 'p',
  keyEpoch: 0,
  kind: 'document',
  versionId: '1'
};
const SEAL_CONTEXT: SealContext = {
  purpose: 'project-key',
  userId: 'u1',
  projectId: 'p',
  keyEpoch: 0
};

type Mutator = (input: Bytes, next: () => number) => Bytes;

const int = (next: () => number, below: number) => Math.floor(next() * below);

const MUTATORS: Mutator[] = [
  // Flip one bit.
  (input, next) => {
    const out = new Uint8Array(input);
    if (out.length) out[int(next, out.length)]! ^= 1 << int(next, 8);
    return out;
  },
  // Overwrite a byte with an extreme value.
  (input, next) => {
    const out = new Uint8Array(input);
    if (out.length) {
      out[int(next, out.length)] = [0x00, 0x01, 0x02, 0x7f, 0x80, 0xff][
        int(next, 6)
      ]!;
    }
    return out;
  },
  // Truncate anywhere.
  (input, next) => input.slice(0, int(next, input.length + 1)),
  // Insert random bytes.
  (input, next) => {
    const at = int(next, input.length + 1);
    const noise = Uint8Array.from({ length: 1 + int(next, 40) }, () =>
      int(next, 256)
    );
    return concatBytes(input.subarray(0, at), noise, input.subarray(at));
  },
  // Delete a range.
  (input, next) => {
    const at = int(next, input.length + 1);
    return concatBytes(
      input.subarray(0, at),
      input.subarray(at + 1 + int(next, 30))
    );
  },
  // Duplicate a range in place.
  (input, next) => {
    const at = int(next, input.length + 1);
    const span = input.subarray(at, at + 1 + int(next, 100));
    return concatBytes(input.subarray(0, at), span, input.subarray(at));
  },
  // Overwrite a 32-bit length-sized field with a large value.
  (input, next) => {
    const out = new Uint8Array(input);
    if (out.length >= 4) {
      const at = int(next, out.length - 3);
      new DataView(out.buffer).setUint32(
        at,
        [0xffffffff, 0x7fffffff, 0x00100001][int(next, 3)]!
      );
    }
    return out;
  },
  // Pure random bytes, sometimes with a valid magic and version.
  (_input, next) => {
    const noise = Uint8Array.from({ length: int(next, 300) }, () =>
      int(next, 256)
    );
    if (noise.length >= 4 && next() < 0.5) noise.set([0x4f, 0x5a, 0x45, 0x01]);
    return noise;
  }
];

async function onlyTypedErrors(task: () => unknown): Promise<string> {
  try {
    await task();
    return 'ok';
  } catch (error) {
    if (error instanceof E2eeError) return error.code;
    throw new Error(`Untyped error escaped: ${String(error)}`, {
      cause: error
    });
  }
}

function mutate(seed: number, input: Bytes): Bytes {
  const next = seededRandom(seed);
  let out = input;
  for (let rounds = 1 + int(next, 3); rounds > 0; rounds -= 1) {
    out = MUTATORS[int(next, MUTATORS.length)]!(out, next);
  }
  return out;
}

describe('parser fuzzing', () => {
  it('envelope parsing and decryption only throw E2eeError', async () => {
    const versionKey = EnvelopeKey.generate();
    const versionKeyBytes = versionKey.bytes;
    const project = await encryptProjectEnvelope(
      versionKey,
      {
        kind: 'document',
        projectId: 'p',
        documentVersion: 1,
        previousVersionHash: patternBytes(32),
        rosterEntryHash: patternBytes(32, 1),
        schemaVersion: 1,
        keyEpoch: 0,
        blobIds: ['a', 'b'],
        chunkSize: 64
      },
      patternBytes(500)
    );
    const blob = await encryptContentBlob(
      EnvelopeKey.generate(),
      'mesh-payload',
      patternBytes(300),
      { compression: 'none', chunkSize: 64 }
    );
    const outcomes = new Map<string, number>();
    const record = (outcome: string) =>
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    for (let seed = 1; seed <= 1500; seed += 1) {
      const isProject = seed % 2 === 0;
      const input = mutate(seed, isProject ? project : blob.envelope);
      record(await onlyTypedErrors(() => parseEnvelope(input)));
      record(
        await onlyTypedErrors(() =>
          isProject
            ? decryptProjectEnvelope(versionKeyBytes, input, {
                maxPlaintextBytes: 1 << 20
              })
            : decryptContentBlob(blob.reference, input)
        )
      );
      record(
        await onlyTypedErrors(async () => {
          const reader = createContentBlobReader(blob.reference);
          for (let at = 0; at < input.length; at += 37) {
            await reader.push(input.subarray(at, at + 37));
          }
          await reader.finish();
        })
      );
    }
    // The corpus reaches the interesting refusals, not just one of them.
    for (const code of [
      'malformed',
      'authentication-failed',
      'unsupported-version'
    ]) {
      expect(outcomes.get(code) ?? 0).toBeGreaterThan(0);
    }
  });

  it('key and signature parsing only throw E2eeError', async () => {
    const kek = patternBytes(32, 0x01);
    const recipient = await generateEncryptionKeyPair();
    const author = await generateSigningKeyPair();
    const symmetric = await wrapKey(kek, patternBytes(32), WRAP_CONTEXT);
    const privateKey = await wrapKey(kek, patternBytes(140), {
      purpose: 'encryption-private-key',
      userId: 'u1',
      keyId: 'k1'
    });
    const sealed = await sealKey(
      recipient.publicKey,
      patternBytes(32),
      SEAL_CONTEXT
    );
    const envelope = await encryptProjectEnvelope(
      EnvelopeKey.generate(),
      {
        kind: 'document',
        projectId: 'p',
        documentVersion: 1,
        previousVersionHash: null,
        rosterEntryHash: patternBytes(32),
        schemaVersion: 1,
        keyEpoch: 0
      },
      patternBytes(10)
    );
    const signature = await signProjectEnvelope(author.privateKey, envelope);
    for (let seed = 1; seed <= 400; seed += 1) {
      await onlyTypedErrors(() =>
        unwrapKey(kek, mutate(seed, symmetric), WRAP_CONTEXT)
      );
      await onlyTypedErrors(() =>
        unwrapKey(kek, mutate(seed, privateKey), {
          purpose: 'encryption-private-key',
          userId: 'u1',
          keyId: 'k1'
        })
      );
      await onlyTypedErrors(() =>
        openSealedKey(recipient, mutate(seed, sealed), SEAL_CONTEXT)
      );
      await onlyTypedErrors(() =>
        verifyProjectEnvelopeSignature(
          author.publicKey,
          envelope,
          mutate(seed, signature)
        )
      );
      await onlyTypedErrors(() =>
        verifyProjectEnvelopeSignature(
          author.publicKey,
          mutate(seed, envelope),
          signature
        )
      );
    }
  });
});
