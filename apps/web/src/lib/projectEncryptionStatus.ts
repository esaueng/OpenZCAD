import {
  PROJECT_STORAGE_FORMAT_E2EE_V1,
  type ProjectSummary
} from '@openzcad/shared';
import { projectNeedsUpdate } from './projectShelf';

export interface EncryptionFacts {
  /** Being encrypted in this tab, or paused with its plaintext locked. */
  migrating: boolean;
  /** The account listing holds this project. */
  inAccount: boolean;
}

export interface ProjectEncryptionStatus {
  state: 'encrypted' | 'encrypting' | 'plaintext' | 'unreadable';
  label: string;
  detail: string;
}

/**
 * How a project is stored, for Project properties (ADR-024). This uses the
 * same facts as the start screen's card marks, but it states every case:
 * the card marks only the exception.
 */
export function projectEncryptionStatus(
  project: Pick<ProjectSummary, 'storageFormat'>,
  context: EncryptionFacts
): ProjectEncryptionStatus {
  if (projectNeedsUpdate(project)) {
    return {
      state: 'unreadable',
      label: 'Stored in a newer format',
      detail:
        'This version of OpenZCAD cannot read how it is stored. Update OpenZCAD to open it.'
    };
  }
  if (project.storageFormat === PROJECT_STORAGE_FORMAT_E2EE_V1) {
    return {
      state: 'encrypted',
      label: 'End-to-end encrypted',
      // The workspace indicator's sentence (EncryptionIndicator.tsx).
      detail: 'Encrypted on this device before it is saved.'
    };
  }
  if (context.migrating) {
    return {
      state: 'encrypting',
      label: 'Being encrypted',
      detail: 'It opens read-only until encryption finishes.'
    };
  }
  return context.inAccount
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
