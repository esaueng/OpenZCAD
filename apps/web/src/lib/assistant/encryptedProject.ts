import {
  PROJECT_STORAGE_FORMAT_PLAINTEXT,
  type ProjectSummary
} from '@openzcad/shared';

export const ENCRYPTED_PROJECT_ASSISTANT_NOTICE =
  'The assistant is off for end-to-end encrypted projects for now. Nothing from this project is sent to it.';

/**
 * Why the assistant is off for the open project, or null when it may run
 * (ADR-024 decision D7). It cannot work on ciphertext, and sending an
 * encrypted project's model digest needs the per-project consent of Phase 6,
 * so until then every entry point is disabled on an encrypted project. The
 * Worker refuses such a request too; this keeps the browser from asking.
 */
export function assistantDisabledReason(
  project: Pick<ProjectSummary, 'storageFormat'> | undefined
): string | null {
  const format = project?.storageFormat ?? PROJECT_STORAGE_FORMAT_PLAINTEXT;
  return format === PROJECT_STORAGE_FORMAT_PLAINTEXT
    ? null
    : ENCRYPTED_PROJECT_ASSISTANT_NOTICE;
}
