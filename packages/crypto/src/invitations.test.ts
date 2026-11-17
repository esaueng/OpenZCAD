import { describe, expect, it } from 'vitest';
import { concatBytes } from './bytes';
import { publicKeyHash } from './codes';
import { E2eeError, type E2eeErrorCode } from './errors';
import { encodeGroupReset, signStatement } from './devices';
import {
  INVITATION_CLOCK_SKEW_MS,
  MAX_INVITATION_ACCEPTANCE_BYTES,
  MAX_PROJECT_INVITATION_BYTES,
  MAX_PROJECT_INVITATION_LIFETIME_MS,
  PROJECT_INVITATION_VERSION_1,
  PROJECT_INVITATION_VERSION_2,
  PROJECT_INVITATION_VERSION_3,
  ProjectInvitationError,
  decodeInvitationAcceptance,
  decodeProjectInvitation,
  encodeInvitationAcceptance,
  encodeProjectInvitation,
  invitationEmailHash,
  invitationLinkTokenHash,
  invitationStatementHash,
  signInvitationAcceptance,
  signProjectInvitation,
  verifyInvitationAcceptance,
  verifyProjectInvitation,
  type AcceptanceExpectations,
  type InvitationAcceptance,
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

  it('binds the emailed link in version 2, and still verifies version 1', async () => {
    const { device, deviceRaw, value } = await fixture();
    const token = 'A'.repeat(43);
    const linkTokenHash = await invitationLinkTokenHash(token);
    expect(linkTokenHash.byteLength).toBe(32);
    // Its own label: not the email hash, nor a bare SHA-256 of the token.
    expect(linkTokenHash).not.toEqual(await invitationEmailHash(token));
    expect(linkTokenHash).not.toEqual(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
      )
    );
    const linked: ProjectInvitation = { ...value, linkTokenHash };
    const bytes = encodeProjectInvitation(linked);
    expect([...bytes.subarray(0, 4)]).toEqual([
      0x4f,
      0x5a,
      0x49,
      PROJECT_INVITATION_VERSION_2
    ]);
    expect(bytes.byteLength).toBe(
      encodeProjectInvitation(value).byteLength + 32
    );
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_PROJECT_INVITATION_BYTES);
    expect(decodeProjectInvitation(bytes)).toEqual(linked);
    const signed = await signProjectInvitation(device.privateKey, linked);
    await expect(
      verifyProjectInvitation(signed, deviceRaw, {
        now: T,
        expected: { linkTokenHash }
      })
    ).resolves.toEqual(linked);
    // Another link's token, or a version 1 statement, does not match a link.
    await refusedWith(
      verifyProjectInvitation(signed, deviceRaw, {
        now: T,
        expected: {
          linkTokenHash: await invitationLinkTokenHash('B'.repeat(43))
        }
      }),
      'context-mismatch'
    );
    const older = await signProjectInvitation(device.privateKey, value);
    expect(encodeProjectInvitation(value)[3]).toBe(
      PROJECT_INVITATION_VERSION_1
    );
    expect(decodeProjectInvitation(older.statement).linkTokenHash).toBe(
      undefined
    );
    await expect(
      verifyProjectInvitation(older, deviceRaw, { now: T })
    ).resolves.toEqual(value);
    await refusedWith(
      verifyProjectInvitation(older, deviceRaw, {
        now: T,
        expected: { linkTokenHash }
      }),
      'context-mismatch'
    );
    // The hash is signed: dropping or swapping it breaks the signature.
    const swapped = encodeProjectInvitation({
      ...linked,
      linkTokenHash: await invitationLinkTokenHash('B'.repeat(43))
    });
    await refusedWith(
      verifyProjectInvitation(
        { statement: swapped, signature: signed.signature },
        deviceRaw,
        { now: T }
      ),
      'signature'
    );
    await refusedWith(
      verifyProjectInvitation(
        { statement: older.statement, signature: signed.signature },
        deviceRaw,
        { now: T }
      ),
      'signature'
    );
    throwsCode(
      () =>
        encodeProjectInvitation({
          ...value,
          linkTokenHash: new Uint8Array(31)
        }),
      'invalid-argument'
    );
    await expect(invitationLinkTokenHash('')).rejects.toMatchObject({
      code: 'invalid-argument'
    });
  });

  it('binds the invited contact identity in version 3, with or without a link', async () => {
    const { device, deviceRaw, value } = await fixture();
    const inviteeIdentityKeyHash = patternBytes(32, 7);
    const linkTokenHash = await invitationLinkTokenHash('A'.repeat(43));
    const bound: ProjectInvitation = {
      ...value,
      linkTokenHash,
      inviteeIdentityKeyHash
    };
    const bytes = encodeProjectInvitation(bound);
    expect([...bytes.subarray(0, 4)]).toEqual([
      0x4f,
      0x5a,
      0x49,
      PROJECT_INVITATION_VERSION_3
    ]);
    // Identity, link flag, link.
    expect(bytes.byteLength).toBe(
      encodeProjectInvitation(value).byteLength + 32 + 1 + 32
    );
    expect(decodeProjectInvitation(bytes)).toEqual(bound);
    const unlinked: ProjectInvitation = { ...value, inviteeIdentityKeyHash };
    const unlinkedBytes = encodeProjectInvitation(unlinked);
    expect(unlinkedBytes[3]).toBe(PROJECT_INVITATION_VERSION_3);
    expect(unlinkedBytes.byteLength).toBe(
      encodeProjectInvitation(value).byteLength + 33
    );
    expect(decodeProjectInvitation(unlinkedBytes)).toEqual(unlinked);
    // The longest possible statement fits the bound every reader checks.
    const id = 'a'.repeat(128);
    expect(
      encodeProjectInvitation({
        ...bound,
        projectId: id,
        invitationId: id,
        inviterUserId: id,
        signerDeviceId: id
      }).byteLength
    ).toBe(MAX_PROJECT_INVITATION_BYTES);
    const signed = await signProjectInvitation(device.privateKey, bound);
    await expect(
      verifyProjectInvitation(signed, deviceRaw, {
        now: T,
        expected: { linkTokenHash }
      })
    ).resolves.toEqual(bound);
    // The identity is signed: another contact's breaks the signature, and
    // so does dropping it (a version 2 statement of the same fields).
    await refusedWith(
      verifyProjectInvitation(
        {
          statement: encodeProjectInvitation({
            ...bound,
            inviteeIdentityKeyHash: patternBytes(32, 9)
          }),
          signature: signed.signature
        },
        deviceRaw,
        { now: T }
      ),
      'signature'
    );
    await refusedWith(
      verifyProjectInvitation(
        {
          statement: encodeProjectInvitation({ ...value, linkTokenHash }),
          signature: signed.signature
        },
        deviceRaw,
        { now: T }
      ),
      'signature'
    );
    // A link flag other than 0 or 1, or a flag that disagrees with the
    // bytes that follow, is malformed.
    const flagAt = unlinkedBytes.byteLength - 1;
    const badFlag = unlinkedBytes.slice();
    badFlag[flagAt] = 2;
    throwsCode(() => decodeProjectInvitation(badFlag), 'malformed');
    const claimsLink = unlinkedBytes.slice();
    claimsLink[flagAt] = 1;
    throwsCode(() => decodeProjectInvitation(claimsLink), 'malformed');
    throwsCode(
      () =>
        encodeProjectInvitation({
          ...value,
          inviteeIdentityKeyHash: new Uint8Array(31)
        }),
      'invalid-argument'
    );
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
    newer[3] = 4;
    throwsCode(() => decodeProjectInvitation(newer), 'unsupported-version');
    // A version 1 body relabelled version 2 lacks its link token hash.
    const relabelled = new Uint8Array(bytes);
    relabelled[3] = 2;
    throwsCode(() => decodeProjectInvitation(relabelled), 'malformed');
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

describe('invitee-signed invitation acceptances', () => {
  async function acceptance() {
    const owner = await fixture();
    const invitation = await signProjectInvitation(
      owner.device.privateKey,
      owner.value
    );
    const device = await generateSigningKeyPair(false);
    const deviceRaw = await exportPublicKey(device.publicKey);
    const value: InvitationAcceptance = {
      projectId: 'proj_1',
      invitationId: 'inv_1',
      invitationHash: await invitationStatementHash(invitation.statement),
      inviteeUserId: 'user_bob',
      inviteeIdentityKeyHash: patternBytes(32),
      inviteeEmailHash: owner.value.inviteeEmailHash,
      acceptedAt: T + DAY,
      signerDeviceId: 'bob_laptop',
      signerKeyHash: await publicKeyHash(deviceRaw)
    };
    const expected: AcceptanceExpectations = {
      projectId: 'proj_1',
      invitationId: 'inv_1',
      invitationHash: value.invitationHash,
      inviteeEmailHash: await invitationEmailHash('bob@example.com'),
      inviteeUserId: 'user_bob',
      inviteeIdentityKeyHash: patternBytes(32)
    };
    return { invitation, device, deviceRaw, value, expected };
  }

  it('round-trips canonically and verifies under the signing device', async () => {
    const { device, deviceRaw, value, expected } = await acceptance();
    const bytes = encodeInvitationAcceptance(value);
    expect([...bytes.subarray(0, 4)]).toEqual([0x4f, 0x5a, 0x4a, 1]);
    expect(decodeInvitationAcceptance(bytes)).toEqual(value);
    const signed = await signInvitationAcceptance(device.privateKey, value);
    await expect(
      verifyInvitationAcceptance(signed, deviceRaw, expected)
    ).resolves.toEqual(value);
    // The server's check, without an identity hash, and with a CryptoKey.
    const { inviteeIdentityKeyHash: _, ...withoutIdentity } = expected;
    await expect(
      verifyInvitationAcceptance(signed, device.publicKey, withoutIdentity)
    ).resolves.toEqual(value);
    const longest = encodeInvitationAcceptance({
      ...value,
      projectId: 'p'.repeat(128),
      invitationId: 'i'.repeat(128),
      inviteeUserId: 'u'.repeat(128),
      signerDeviceId: 'd'.repeat(128)
    });
    expect(longest.byteLength).toBe(MAX_INVITATION_ACCEPTANCE_BYTES);
  });

  it('refuses a forged, missing-key or another device’s acceptance', async () => {
    const { device, deviceRaw, value, expected } = await acceptance();
    const signed = await signInvitationAcceptance(device.privateKey, value);
    const intruder = await generateSigningKeyPair(false);
    // Another device's signature over the same bytes.
    await refusedWith(
      verifyInvitationAcceptance(
        {
          statement: signed.statement,
          signature: await signStatement(
            intruder.privateKey,
            'invitation acceptance',
            signed.statement
          )
        },
        deviceRaw,
        expected
      ),
      'signature'
    );
    // The same signature under another label (an invitation's).
    await refusedWith(
      verifyInvitationAcceptance(
        {
          statement: signed.statement,
          signature: await signStatement(
            device.privateKey,
            'project invitation',
            signed.statement
          )
        },
        deviceRaw,
        expected
      ),
      'signature'
    );
    // Checked under a key the statement does not name.
    await refusedWith(
      verifyInvitationAcceptance(
        signed,
        await exportPublicKey(intruder.publicKey),
        expected
      ),
      'signer-mismatch'
    );
    // A changed account under the original signature.
    await refusedWith(
      verifyInvitationAcceptance(
        {
          statement: encodeInvitationAcceptance({
            ...value,
            inviteeUserId: 'user_carol'
          }),
          signature: signed.signature
        },
        deviceRaw,
        { ...expected, inviteeUserId: 'user_carol' }
      ),
      'signature'
    );
    await expect(
      verifyInvitationAcceptance(
        { statement: signed.statement, signature: new Uint8Array() },
        deviceRaw,
        expected
      )
    ).rejects.toBeInstanceOf(E2eeError);
  });

  it('accepts only the exact invitation, account, identity and email', async () => {
    const { invitation, device, deviceRaw, value, expected } =
      await acceptance();
    const signed = await signInvitationAcceptance(device.privateKey, value);
    const changed = new Uint8Array(invitation.statement);
    changed[changed.length - 1]! ^= 1;
    for (const other of [
      { projectId: 'proj_2' },
      { invitationId: 'inv_2' },
      { invitationHash: await invitationStatementHash(changed) },
      { inviteeUserId: 'user_carol' },
      { inviteeIdentityKeyHash: patternBytes(32, 7) },
      { inviteeEmailHash: await invitationEmailHash('carol@example.com') }
    ]) {
      await refusedWith(
        verifyInvitationAcceptance(signed, deviceRaw, {
          ...expected,
          ...other
        }),
        'context-mismatch'
      );
    }
  });

  it('refuses malformed and non-canonical bytes', async () => {
    const { value } = await acceptance();
    const bytes = encodeInvitationAcceptance(value);
    throwsCode(
      () => decodeInvitationAcceptance(bytes.subarray(0, bytes.length - 1)),
      'malformed'
    );
    throwsCode(
      () => decodeInvitationAcceptance(concatBytes(bytes, Uint8Array.of(0))),
      'malformed'
    );
    const version = new Uint8Array(bytes);
    version[3] = 2;
    throwsCode(
      () => decodeInvitationAcceptance(version),
      'unsupported-version'
    );
    // An invitation's bytes are not an acceptance.
    const { value: invitation } = await fixture();
    throwsCode(
      () => decodeInvitationAcceptance(encodeProjectInvitation(invitation)),
      'malformed'
    );
    throwsCode(
      () =>
        encodeInvitationAcceptance({
          ...value,
          signerKeyHash: patternBytes(31)
        }),
      'invalid-argument'
    );
  });
});
