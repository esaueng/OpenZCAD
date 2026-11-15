import { describe, expect, it } from 'vitest';
import {
  PROJECT_STORAGE_FORMAT_E2EE_V1,
  PROJECT_STORAGE_FORMAT_PLAINTEXT
} from '@openzcad/shared';
import { projectEncryptionStatus } from './projectEncryptionStatus';

const encrypted = {
  storageFormat: PROJECT_STORAGE_FORMAT_E2EE_V1,
  inAccount: true
};
const plaintext = {
  storageFormat: PROJECT_STORAGE_FORMAT_PLAINTEXT,
  inAccount: true
};

describe('projectEncryptionStatus', () => {
  it('reports an end-to-end encrypted project', () => {
    expect(projectEncryptionStatus(encrypted, null)).toMatchObject({
      state: 'encrypted',
      label: 'End-to-end encrypted'
    });
  });

  it('trusts the stored format over a lingering migration lock', () => {
    expect(projectEncryptionStatus(encrypted, 'paused').state).toBe(
      'encrypted'
    );
  });

  it('reports a plaintext project this page is encrypting', () => {
    expect(projectEncryptionStatus(plaintext, 'here')).toMatchObject({
      state: 'encrypting',
      label: 'Being encrypted'
    });
  });

  it('reports a plaintext project another tab or device is encrypting', () => {
    expect(projectEncryptionStatus(plaintext, 'elsewhere')).toMatchObject({
      state: 'encrypting',
      label: 'Being encrypted elsewhere'
    });
  });

  /**
   * A paused or stopped run keeps the plaintext locked; it is not making
   * progress, so it must not read as "being encrypted".
   */
  it('does not call a paused or stopped run progress', () => {
    const status = projectEncryptionStatus(plaintext, 'paused');
    expect(status).toMatchObject({
      state: 'paused',
      label: 'Encryption not finished'
    });
    expect(status.detail).not.toMatch(/until encryption finishes/);
  });

  it('says where a plaintext project is stored', () => {
    expect(projectEncryptionStatus(plaintext, null)).toMatchObject({
      state: 'plaintext',
      label: 'Not end-to-end encrypted',
      detail: 'It is stored in your account as plaintext.'
    });
    expect(
      projectEncryptionStatus(
        { storageFormat: undefined, inAccount: false },
        null
      )
    ).toMatchObject({
      state: 'plaintext',
      label: 'Not encrypted',
      detail: 'It is stored on this device as plaintext.'
    });
  });

  it('does not guess at a format this build cannot read', () => {
    expect(
      projectEncryptionStatus({ storageFormat: 99, inAccount: true }, null)
    ).toMatchObject({ state: 'unreadable', label: 'Stored in a newer format' });
  });
});
