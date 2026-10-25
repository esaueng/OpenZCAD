import {
  PROJECT_STORAGE_FORMAT_PLAINTEXT,
  type ProjectSummary
} from '@openzcad/shared';

export const ENCRYPTED_PROJECT_ASSISTANT_NOTICE =
  'The assistant is off for end-to-end encrypted projects for now. Nothing from this project is sent to it.';

/** The part of a consent gate (`consentGate.ts`) this decision reads. */
export interface AssistantDisabledGate {
  readonly status: { readonly kind: string; readonly reason?: string };
}

/**
 * Why the assistant is off for the open project, or null when it may run
 * (ADR-024 decision D7, lifted per project by Phase 6). It cannot work on
 * ciphertext, so an encrypted project's model digest leaves the device only
 * with that project's consent. Without a consent gate every entry point
 * stays disabled on an encrypted project, as before; with one, the
 * assistant is off only while the gate says consent cannot be stored or
 * read here, and otherwise asks before the first request. The Worker
 * refuses such a request too; this keeps the browser from asking.
 */
export function assistantDisabledReason(
  project: Pick<ProjectSummary, 'storageFormat'> | undefined,
  gate?: AssistantDisabledGate | null
): string | null {
  const format = project?.storageFormat ?? PROJECT_STORAGE_FORMAT_PLAINTEXT;
  if (format === PROJECT_STORAGE_FORMAT_PLAINTEXT) return null;
  if (!gate) return ENCRYPTED_PROJECT_ASSISTANT_NOTICE;
  return gate.status.kind === 'unavailable'
    ? gate.status.reason || ENCRYPTED_PROJECT_ASSISTANT_NOTICE
    : null;
}
