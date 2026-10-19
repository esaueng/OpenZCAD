import { savePointReasons } from '@openzcad/document-core';
import type { ProjectDocument, RevisionRecord } from '@openzcad/shared';

/**
 * How far a browser-minted save point's timestamps may sit from the server's
 * clock (ADR-024 Phase 1). Generous on purpose: a device whose clock is a few
 * minutes out must still save, while a revision dated days away is refused
 * rather than reordering the project's history for everyone.
 */
export const MAX_SAVE_POINT_CLOCK_SKEW_MS = 60 * 60 * 1000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REVISION_ID = new RegExp(`^rev_${UUID}$`);
const CHECKPOINT_ID = new RegExp(`^checkpoint_${UUID}$`);
const PROJECT_ID = new RegExp(`^proj_${UUID}$`);

/** A browser-minted record the server will not store. Never retryable as is. */
export class SavePointRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavePointRequestError';
  }
}

/** Whether `value` is an id `createId('proj')` could have minted. */
export function isClientMintedProjectId(value: string): boolean {
  return PROJECT_ID.test(value);
}

function assertRecentTimestamp(value: string, now: number, field: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new SavePointRequestError(`${field} must be an ISO timestamp.`);
  }
  if (Math.abs(time - now) > MAX_SAVE_POINT_CLOCK_SKEW_MS) {
    throw new SavePointRequestError(
      `${field} is too far from the server's clock. Check this device's date and time, then save again.`
    );
  }
}

/**
 * Checks the save point a browser appended before sending (ADR-024 Phase 1):
 * the newest revision is the one the request names and was minted for this
 * reason, and the newest checkpoint names that revision at the document's
 * version. Ids must be `createId` output, unique within the document, and
 * dated near the server's clock. Whether the account already stores the
 * revision id — a replay — is the caller's check against its own store, and
 * is answered with `RevisionIdCollisionError`.
 */
export function assertClientSavePoint(
  document: ProjectDocument,
  expected: { revisionId: string; reason: string },
  now = Date.now()
): RevisionRecord {
  const revision = document.revisions.at(-1);
  const checkpoint = document.checkpoints.at(-1);
  if (!revision || revision.revisionId !== expected.revisionId) {
    throw new SavePointRequestError(
      'The newest revision is not the save point this request names.'
    );
  }
  if (!REVISION_ID.test(revision.revisionId)) {
    throw new SavePointRequestError('The save point revision id is malformed.');
  }
  const reasons = savePointReasons(expected.reason);
  if (
    revision.reason !== reasons.revision ||
    revision.commandCount !== document.commandLog.length
  ) {
    throw new SavePointRequestError(
      'The save point revision does not match this request.'
    );
  }
  if (
    !checkpoint ||
    !CHECKPOINT_ID.test(checkpoint.checkpointId) ||
    checkpoint.revisionId !== revision.revisionId ||
    checkpoint.documentVersion !== document.version ||
    checkpoint.reason !== reasons.checkpoint
  ) {
    throw new SavePointRequestError(
      'The save point checkpoint does not name its revision.'
    );
  }
  if (
    document.revisions.some(
      (record, index) =>
        record.revisionId === revision.revisionId &&
        index !== document.revisions.length - 1
    ) ||
    document.checkpoints.some(
      (record, index) =>
        record.checkpointId === checkpoint.checkpointId &&
        index !== document.checkpoints.length - 1
    )
  ) {
    throw new SavePointRequestError('The save point repeats an earlier id.');
  }
  assertRecentTimestamp(revision.createdAt, now, 'The revision time');
  assertRecentTimestamp(checkpoint.createdAt, now, 'The checkpoint time');
  return revision;
}
