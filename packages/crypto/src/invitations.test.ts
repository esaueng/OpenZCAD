import { describe, expect, it } from 'vitest';
import { concatBytes } from './bytes';
import { publicKeyHash } from './codes';
import { E2eeError, type E2eeErrorCode } from './errors';
import { encodeGroupReset, signStatement } from './devices';
import {
  INVITATION_CLOCK_SKEW_MS,
  MAX_PROJECT_INVITATION_LIFETIME_MS,
  ProjectInvitationError,
  decodeProjectInvitation,
  encodeProjectInvitation,
  invitationEmailHash,
  signProjectInvitation,
  verifyProjectInvitation,
  type InvitationFailure,
  type ProjectInvitation
} from './invitations';
import { exportPublicKey, generateSigningKeyPair } from './keys';
import { patternBytes } from './test-support';

const T = 1_760_000_000_000;
const DAY = 86_400_000;

async function fixture() {
  const device = await generateSigningKeyPair(false);
  const deviceRaw = await exportPublicKey(device.publicKey);
  const value: ProjectInvitation = {
    projectId: 'proj_1',
    invitationId: 'inv_1',
    inviterUserId: 'user_owner',
    inviteeEmailHash: await invitationEmailHash('bob@example.com'),
    role: 'editor',
    issuedAt: T,
    expiresAt: T + 7 * DAY,
    signerDeviceId: 'owner_laptop',
    signerKeyHash: await publicKeyHash(deviceRaw)
  };
  return { device, deviceRaw, value };
}

function throwsCode(task: () => unknown, code: E2eeErrorCode) {
  expect(task).toThrow(
    expect.objectContaining({ name: 'E2eeError', code }) as Error
  );
}

async function refusedWith(
  promise: Promise<unknown>,
  reason: InvitationFailure
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ProjectInvitationError && error.reason === reason
  );
}

describe('owner-signed project invitations (slice 5-3a)', () => {
  it('round-trips canonically and verifies under the signing device', async () => {
    const { device, deviceRaw, value } = await fixture();
    const bytes = encodeProjectInvitation(value);
    expect([...bytes.subarray(0, 4)]).toEqual([0x4f, 0x5a, 0x49, 1]);
    expect(decodeProjectInvitation(bytes)).toEqual(value);
    const signed = await signProjectInvitation(device.privateKey, value);
    const verified = await verifyProjectInvitation(signed, deviceRaw, {
      now: T + DAY,
      expected: {
        projectId: 'proj_1',
        invitationId: 'inv_1',
        inviterUserId: 'user_owner',
        inviteeEmailHash: await invitationEmailHash(' Bob@Example.com ')
      }
    });
    expect(verified).toEqual(value);
    // A CryptoKey works as well as raw bytes.
    await expect(
      verifyProjectInvitation(signed, device.publicKey, { now: T })
    ).resolves.toEqual(value);
  });

  it('hashes the normalized email under its own label', async () => {
    const a = await invitationEmailHash('Bob@Example.com');
    expect(a).toEqual(await invitationEmailHash('  bob@example.com'));
    expect(a).not.toEqual(await invitationEmailHash('bob@example.org'));
    expect(a.byteLength).toBe(32);
    await expect(invitationEmailHash('')).rejects.toMatchObject({
      code: 'invalid-argument'
    });
  });

  it('refuses a forged, re-signed or mismatched statement', async () => {
    const { device, deviceRaw, value } = await fixture();
    const signed = await signProjectInvitation(device.privateKey, value);
    // Another device's signature over the same bytes.
    const intruder = await generateSigningKeyPair(false);
    await refusedWith(
      verifyProjectInvitation(
        {
          statement: signed.statement,
          signature: await signStatement(
            intruder.privateKey,
            'project invitation',
            signed.statement
          )
        },
        deviceRaw,
        { now: T }
      ),
      'signature'
    );
    // A changed role under the original signature.
    await refusedWith(
      verifyProjectInvitation(
        {
          statement: encodeProjectInvitation({ ...value, role: 'viewer' }),
          signature: signed.signature
        },
        deviceRaw,
        { now: T }
      ),
      'signature'
    );
    // The same key's signature with another statement kind's label.
    await refusedWith(
      verifyProjectInvitation(
        {
          statement: signed.statement,
          signature: await signStatement(
            device.privateKey,
            'share link grant',
            signed.statement
          )
        },
        deviceRaw,
        { now: T }
      ),
      'signature'
    );
    // Verified with a key the statement does not name.
    await refusedWith(
      verifyProjectInvitation(
        signed,
        await exportPublicKey(intruder.publicKey),
        { now: T }
      ),
      'signer-mismatch'
    );
    for (const expected of [
      { projectId: 'proj_2' },
      { invitationId: 'inv_2' },
      { inviterUserId: 'user_other' },
      { inviteeEmailHash: await invitationEmailHash('carol@example.com') }
    ]) {
      await refusedWith(
        verifyProjectInvitation(signed, deviceRaw, { now: T, expected }),
        'context-mismatch'
      );
    }
  });

  it('refuses an expired or not yet valid statement', async () => {
    const { device, deviceRaw, value } = await fixture();
    const signed = await signProjectInvitation(device.privateKey, value);
    await refusedWith(
      verifyProjectInvitation(signed, deviceRaw, { now: value.expiresAt }),
      'expired'
    );
    await refusedWith(
      verifyProjectInvitation(signed, deviceRaw, {
        now: T - INVITATION_CLOCK_SKEW_MS - 1
      }),
      'not-yet-valid'
    );
    await expect(
      verifyProjectInvitation(signed, deviceRaw, {
        now: T - INVITATION_CLOCK_SKEW_MS
      })
    ).resolves.toEqual(value);
  });

  it('refuses lifetimes over seven days and non-canonical bytes', async () => {
    const { value } = await fixture();
    throwsCode(
      () =>
        encodeProjectInvitation({
          ...value,
          expiresAt: T + MAX_PROJECT_INVITATION_LIFETIME_MS + 1
        }),
      'invalid-argument'
    );
    throwsCode(
      () => encodeProjectInvitation({ ...value, expiresAt: T }),
      'invalid-argument'
    );
    throwsCode(
      () => encodeProjectInvitation({ ...value, role: 'owner' as never }),
      'invalid-argument'
    );
    throwsCode(
      () => encodeProjectInvitation({ ...value, projectId: 'with space' }),
      'invalid-argument'
    );
    const bytes = encodeProjectInvitation(value);
    throwsCode(
      () => decodeProjectInvitation(concatBytes(bytes, Uint8Array.of(0))),
      'malformed'
    );
    throwsCode(
      () => decodeProjectInvitation(bytes.subarray(0, -1)),
      'malformed'
    );
    // Role byte 3 is no role.
    const roleAt = 4 + 1 + 6 + 1 + 5 + 1 + 10 + 32;
    const badRole = new Uint8Array(bytes);
    expect(badRole[roleAt]).toBe(1);
    badRole[roleAt] = 3;
    throwsCode(() => decodeProjectInvitation(badRole), 'malformed');
    const newer = new Uint8Array(bytes);
    newer[3] = 2;
    throwsCode(() => decodeProjectInvitation(newer), 'unsupported-version');
    // A decoded statement over seven days is refused as malformed.
    const long = new Uint8Array(bytes);
    new DataView(long.buffer).setBigUint64(
      roleAt + 1 + 8,
      BigInt(T + MAX_PROJECT_INVITATION_LIFETIME_MS + 1)
    );
    throwsCode(() => decodeProjectInvitation(long), 'malformed');
  });

  it('is not any other statement', async () => {
    const { value } = await fixture();
    const reset = encodeGroupReset({
      userId: 'user_owner',
      generation: 1,
      entrySequence: 0,
      entryHash: patternBytes(32, 3),
      projectId: 'proj_1',
      priorGroupGeneration: 0,
      priorKeyEpoch: 1,
      issuedAt: T
    });
    throwsCode(() => decodeProjectInvitation(reset), 'malformed');
    expect(encodeProjectInvitation(value)[2]).toBe(0x49);
    expect(() => decodeProjectInvitation(new Uint8Array(0))).toThrow(E2eeError);
  });
});
