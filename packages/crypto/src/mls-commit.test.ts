import { beforeAll, describe, expect, it } from 'vitest';
import { exportPublicKey, generateSigningKeyPair } from './index';
import { signStatement } from './devices';
import {
  mlsCommitSubmissionStatement,
  signMlsCommitSubmission,
  verifyMlsCommitSubmission,
  type MlsCommitSubmission
} from './mls-commit';

const submission: MlsCommitSubmission = {
  userId: 'usr_owner',
  projectId: 'prj_test',
  deviceId: 'owner_laptop',
  kind: 'commit',
  epoch: 4,
  keyEpoch: 5,
  message: Uint8Array.of(0, 1, 0, 1, 9, 9),
  groupInfo: Uint8Array.of(0, 1, 0, 4, 7)
};

let device: CryptoKeyPair;
let other: CryptoKeyPair;
let devicePublic: Uint8Array;
beforeAll(async () => {
  device = await generateSigningKeyPair();
  other = await generateSigningKeyPair();
  devicePublic = await exportPublicKey(device.publicKey);
});

describe('MLS commit submission signatures', () => {
  it('verifies with the signing device key, raw or imported', async () => {
    const signature = await signMlsCommitSubmission(
      device.privateKey,
      submission
    );
    expect(signature).toHaveLength(65);
    expect(signature[0]).toBe(1);
    expect(
      await verifyMlsCommitSubmission(devicePublic, submission, signature)
    ).toBe(true);
    expect(
      await verifyMlsCommitSubmission(device.publicKey, submission, signature)
    ).toBe(true);
  });

  it('refuses another device’s key', async () => {
    const signature = await signMlsCommitSubmission(
      other.privateKey,
      submission
    );
    expect(
      await verifyMlsCommitSubmission(devicePublic, submission, signature)
    ).toBe(false);
  });

  it.each([
    ['userId', { userId: 'usr_other' }],
    ['projectId', { projectId: 'prj_other' }],
    ['deviceId', { deviceId: 'owner_desktop' }],
    ['kind', { kind: 'external' as const }],
    ['epoch', { epoch: 5 }],
    ['keyEpoch', { keyEpoch: 6 }],
    ['message', { message: Uint8Array.of(0, 1, 0, 1, 9, 8) }],
    ['groupInfo', { groupInfo: Uint8Array.of(0, 1, 0, 4, 8) }]
  ])('binds %s', async (_, change) => {
    const signature = await signMlsCommitSubmission(
      device.privateKey,
      submission
    );
    expect(
      await verifyMlsCommitSubmission(
        devicePublic,
        { ...submission, ...change },
        signature
      )
    ).toBe(false);
  });

  it('is domain-separated from other device statements', async () => {
    const statement = await mlsCommitSubmissionStatement(submission);
    const foreign = await signStatement(
      device.privateKey,
      'MLS authority trust',
      statement
    );
    expect(
      await verifyMlsCommitSubmission(devicePublic, submission, foreign)
    ).toBe(false);
  });

  it('throws for a malformed signature or submission', async () => {
    await expect(
      verifyMlsCommitSubmission(devicePublic, submission, new Uint8Array(64))
    ).rejects.toMatchObject({ code: 'malformed' });
    const wrongVersion = new Uint8Array(65);
    wrongVersion[0] = 2;
    await expect(
      verifyMlsCommitSubmission(devicePublic, submission, wrongVersion)
    ).rejects.toMatchObject({ code: 'unsupported-version' });
    await expect(
      signMlsCommitSubmission(device.privateKey, {
        ...submission,
        message: new Uint8Array()
      })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      signMlsCommitSubmission(device.privateKey, {
        ...submission,
        epoch: -1
      })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
