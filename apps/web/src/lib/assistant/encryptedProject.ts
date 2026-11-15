import {
  PROJECT_STORAGE_FORMAT_PLAINTEXT,
  type ProjectSummary
} from '@openzcad/shared';

export const ENCRYPTED_PROJECT_ASSISTANT_NOTICE =
  'The assistant is off for end-to-end encrypted projects for now. Nothing from this project is sent to it.';

/**
 * A project this device holds as encrypted but not as a settled encrypted
 * project: its switch to encryption did not finish here, another tab reset
 * it, this device's encryption records cannot be read or saved, or it came
 * from an encrypted project and the account does not hold it encrypted.
 */
export const UNSETTLED_ENCRYPTED_PROJECT_ASSISTANT_NOTICE =
  'The assistant is off for this project until its encryption is settled on this device. Nothing from this project is sent to it.';

/** A settled encrypted project's request without this device's grant. */
export const ENCRYPTED_PROJECT_ASSISTANT_NOT_ALLOWED =
  'The assistant is not allowed for this encrypted project on this device, so nothing was sent. Allow it for this project to use it.';

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
