import {
  ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE,
  ENCRYPTED_PROJECTS_REQUIRED_CODE,
  PROJECT_FORMAT_UNSUPPORTED_CODE,
  PROJECT_FORMAT_UNSUPPORTED_MESSAGE,
  PROJECT_MIGRATING_CODE,
  PROJECT_STORAGE_FORMAT_PLAINTEXT
} from '@openzcad/shared';

/**
 * ADR-024 Phase 4: the server keeps a project storage format per project
 * (1 plaintext, 2 end-to-end encrypted). Until the encrypted read and write
 * paths exist, every route that reads or writes a document, its revisions,
 * measurements, view state or the room refuses an encrypted project instead
 * of treating its ciphertext as a document.
 */
export class ProjectFormatUnsupportedError extends Error {
  readonly code = PROJECT_FORMAT_UNSUPPORTED_CODE;
  constructor(readonly projectId: string) {
    super(PROJECT_FORMAT_UNSUPPORTED_MESSAGE);
    this.name = 'ProjectFormatUnsupportedError';
  }
}

/** Invitations, share links and member access refused on an encrypted project. */
export class EncryptedProjectSharingError extends Error {
  readonly code = ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE;
  constructor(readonly projectId: string) {
    super(
      'Sharing an end-to-end encrypted project is not available yet. Only the owner can open it.'
    );
    this.name = 'EncryptedProjectSharingError';
  }
}

/** Decision D2: an account that opted in may not store new plaintext projects. */
export class EncryptedProjectsRequiredError extends Error {
  readonly code = ENCRYPTED_PROJECTS_REQUIRED_CODE;
  /** ADR-024 slice 8-1 passes its own message under E2EE_DEFAULT_ON. */
  constructor(
    message = 'This account encrypts new projects. Update OpenZCAD to create encrypted projects, or turn off "Encrypt new projects" in Settings › Encryption.'
  ) {
    super(message);
    this.name = 'EncryptedProjectsRequiredError';
  }
}

/**
 * ADR-024 slice 7-1: a plaintext project staged for encryption takes no
 * plaintext writes until the move finishes or is abandoned; reads keep
 * working.
 */
export class ProjectMigratingError extends Error {
  readonly code = PROJECT_MIGRATING_CODE;
  constructor(readonly projectId: string) {
    super(
      'This project is being moved to encrypted storage. It opens read-only until that finishes.'
    );
    this.name = 'ProjectMigratingError';
  }
}

/** A storage format a project row may carry; anything unreadable counts as not plaintext. */
export function isPlaintextStorageFormat(format: unknown): boolean {
  // Absent only from stores that predate formats (the in-memory store, and
  // rows read through an older column list): those hold plaintext.
  return (
    format === undefined ||
    format === null ||
    format === PROJECT_STORAGE_FORMAT_PLAINTEXT
  );
}

/**
 * The one guard every document route uses. Call it only after access has
 * been resolved, so a caller without access still sees the opaque 404.
 */
export function assertPlaintextProject(access: {
  projectId: string;
  storageFormat?: number;
}): void {
  if (!isPlaintextStorageFormat(access.storageFormat)) {
    throw new ProjectFormatUnsupportedError(access.projectId);
  }
}

/** Sharing is refused on any project that is not plaintext. */
export function assertShareableProject(access: {
  projectId: string;
  storageFormat?: number;
}): void {
  if (!isPlaintextStorageFormat(access.storageFormat)) {
    throw new EncryptedProjectSharingError(access.projectId);
  }
}
