import {
  PROJECT_STORAGE_FORMAT_E2EE_V1,
  type ProjectSummary
} from '@openzcad/shared';
import { projectNeedsUpdate } from './projectShelf';

/** What the start screen knows about how a project is stored right now. */
export interface EncryptionFacts {
  /** From the current listing, not a snapshot taken when a dialog opened. */
  storageFormat: ProjectSummary['storageFormat'];
  /** The account listing holds this project. */
  inAccount: boolean;
}

/**
 * Where a move to encrypted storage stands (`migrationStatus.ts`): this
 * page's run is encrypting it, another tab or device is, or a run paused
 * or stopped with its plaintext still locked.
 */
export type EncryptionMigration = 'here' | 'elsewhere' | 'paused' | null;

export interface ProjectEncryptionStatus {
  state: 'encrypted' | 'encrypting' | 'paused' | 'plaintext' | 'unreadable';
  label: string;
  detail: string;
}

/**
 * How a project is stored, for Project properties (ADR-024). This uses the
 * same facts as the start screen's card marks, but it states every case:
 * the card marks only the exception. It never claims progress a paused run
 * is not making.
 */
export function projectEncryptionStatus(
  facts: EncryptionFacts,
  migration: EncryptionMigration
): ProjectEncryptionStatus {
  if (projectNeedsUpdate(facts)) {
    return {
      state: 'unreadable',
      label: 'Stored in a newer format',
      detail:
        'This version of OpenZCAD cannot read how it is stored. Update OpenZCAD to open it.'
    };
  }
  if (facts.storageFormat === PROJECT_STORAGE_FORMAT_E2EE_V1) {
    return {
      state: 'encrypted',
      label: 'End-to-end encrypted',
      // The workspace indicator's sentence (EncryptionIndicator.tsx).
      detail: 'Encrypted on this device before it is saved.'
    };
  }
  if (migration === 'here') {
    return {
      state: 'encrypting',
      label: 'Being encrypted',
      detail: 'It opens read-only until encryption finishes.'
    };
  }
  if (migration === 'elsewhere') {
    return {
      state: 'encrypting',
      label: 'Being encrypted elsewhere',
      detail:
        'Another tab or device is encrypting it. It opens read-only until that finishes.'
    };
  }
  if (migration === 'paused') {
    return {
      state: 'paused',
      label: 'Encryption not finished',
      detail:
        'Encrypting it paused or stopped before it finished, so it opens read-only. Settings › Encryption shows what it needs.'
    };
  }
  return facts.inAccount
    ? {
        state: 'plaintext',
        label: 'Not end-to-end encrypted',
        detail: 'It is stored in your account as plaintext.'
      }
    : {
        state: 'plaintext',
        label: 'Not encrypted',
        detail: 'It is stored on this device as plaintext.'
      };
}
