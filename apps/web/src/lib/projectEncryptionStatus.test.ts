import { describe, expect, it } from 'vitest';
import {
  PROJECT_STORAGE_FORMAT_E2EE_V1,
  PROJECT_STORAGE_FORMAT_PLAINTEXT
} from '@openzcad/shared';
import { projectEncryptionStatus } from './projectEncryptionStatus';

const idle = { migrating: false, inAccount: true };

describe('projectEncryptionStatus', () => {
  it('reports an end-to-end encrypted project', () => {
    expect(
      projectEncryptionStatus(
        { storageFormat: PROJECT_STORAGE_FORMAT_E2EE_V1 },
        idle
      )
    ).toMatchObject({ state: 'encrypted', label: 'End-to-end encrypted' });
  });

  it('reports an encrypted project as encrypted even mid-migration', () => {
    expect(
      projectEncryptionStatus(
        { storageFormat: PROJECT_STORAGE_FORMAT_E2EE_V1 },
        { ...idle, migrating: true }
      ).state
    ).toBe('encrypted');
  });

  it('reports a plaintext project being encrypted in this tab', () => {
    expect(
      projectEncryptionStatus(
        { storageFormat: PROJECT_STORAGE_FORMAT_PLAINTEXT },
        { ...idle, migrating: true }
      )
    ).toMatchObject({ state: 'encrypting', label: 'Being encrypted' });
  });

  it('says where a plaintext project is stored', () => {
    expect(
      projectEncryptionStatus(
        { storageFormat: PROJECT_STORAGE_FORMAT_PLAINTEXT },
        idle
      )
    ).toMatchObject({
      state: 'plaintext',
      label: 'Not end-to-end encrypted',
      detail: 'It is stored in your account as plaintext.'
    });
    expect(
      projectEncryptionStatus({}, { ...idle, inAccount: false })
    ).toMatchObject({
      state: 'plaintext',
      label: 'Not encrypted',
      detail: 'It is stored on this device as plaintext.'
    });
  });

  it('does not guess at a format this build cannot read', () => {
    expect(projectEncryptionStatus({ storageFormat: 99 }, idle)).toMatchObject({
      state: 'unreadable',
      label: 'Stored in a newer format'
    });
  });
});
