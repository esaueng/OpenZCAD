import { savePointReasons } from '@openzcad/document-core';
import {
  documentNodesWithHistory,
  importedSourceReferenceOf,
  type ProjectDocument,
  type RevisionRecord
} from '@openzcad/shared';

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

/** The checkpoint reason `adoptProjectDocument` records. */
export const ADOPTION_CHECKPOINT_REASON = 'Saved to account';

function assertNotFutureTimestamp(value: string, now: number, field: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new SavePointRequestError(`${field} must be an ISO timestamp.`);
  }
  if (time - now > MAX_SAVE_POINT_CLOCK_SKEW_MS) {
    throw new SavePointRequestError(
      `${field} is too far from the server's clock. Check this device's date and time, then save again.`
    );
  }
}

/** Ids the newest checkpoint and revision must not share with older records. */
function assertNewestRecordsUnique(document: ProjectDocument): void {
  const revision = document.revisions.at(-1);
  const checkpoint = document.checkpoints.at(-1);
  if (
    (revision &&
      document.revisions.some(
        (record, index) =>
          record.revisionId === revision.revisionId &&
          index !== document.revisions.length - 1
      )) ||
    (checkpoint &&
      document.checkpoints.some(
        (record, index) =>
          record.checkpointId === checkpoint.checkpointId &&
          index !== document.checkpoints.length - 1
      ))
  ) {
    throw new SavePointRequestError('The save point repeats an earlier id.');
  }
}

/**
 * The identity checks every browser-built new project shares (ADR-024 Phase 1):
 * an id `createId` could have minted, carried by every project node including
 * undo/redo snapshots, owned by the caller, and holding no archived import id
 * of another project — a copy or adoption archives its own sources.
 */
function assertClientProjectIdentity(
  document: ProjectDocument,
  userId: string
): void {
  if (!isClientMintedProjectId(document.projectId)) {
    throw new SavePointRequestError('The new project id is malformed.');
  }
  if (document.ownerUserId !== userId) {
    throw new SavePointRequestError(
      'A new project must belong to its creator.'
    );
  }
  if (
    document.editHistory &&
    (document.editHistory.projectId !== document.projectId ||
      document.editHistory.actorUserId !== userId)
  ) {
    throw new SavePointRequestError(
      'The new project history belongs to another project.'
    );
  }
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind === 'project' && node.projectId !== document.projectId) {
      throw new SavePointRequestError('The new project names another project.');
    }
    if (
      node.kind === 'feature' &&
      importedSourceReferenceOf(node.data) &&
      !(node.data as { artifactId: string }).artifactId.startsWith(
        'artifact_local_'
      )
    ) {
      throw new SavePointRequestError(
        "The new project references another project's import source."
      );
    }
  }
}

/**
 * Checks a duplicate or branch the browser built (ADR-024 Phase 1). The copy
 * ends with the fresh revision and checkpoint `duplicateProjectDocument`
 * mints, and a branch records the requested save state of the requested
 * project. The revision id being unknown to the store, and the project id
 * being free, are the caller's checks.
 */
export function assertClientProjectCopy(
  document: ProjectDocument,
  expected: {
    userId: string;
    sourceProjectId: string;
    revisionId?: string;
    name?: string;
  },
  now = Date.now()
): RevisionRecord {
  assertClientProjectIdentity(document, expected.userId);
  if (expected.name !== undefined && document.name !== expected.name) {
    throw new SavePointRequestError(
      'The new project name does not match the request.'
    );
  }
  const revision = document.revisions.at(-1);
  const checkpoint = document.checkpoints.at(-1);
  const prefix = expected.revisionId ? 'Branched from ' : 'Duplicated from ';
  if (
    !revision ||
    !REVISION_ID.test(revision.revisionId) ||
    !revision.reason.startsWith(prefix) ||
    revision.commandCount !== document.commandLog.length
  ) {
    throw new SavePointRequestError(
      'The copy does not end with its own revision.'
    );
  }
  if (
    !checkpoint ||
    !CHECKPOINT_ID.test(checkpoint.checkpointId) ||
    checkpoint.revisionId !== revision.revisionId ||
    checkpoint.documentVersion !== document.version ||
    checkpoint.reason !== revision.reason
  ) {
    throw new SavePointRequestError(
      'The copy checkpoint does not name its revision.'
    );
  }
  assertNewestRecordsUnique(document);
  assertRecentTimestamp(revision.createdAt, now, 'The revision time');
  assertRecentTimestamp(checkpoint.createdAt, now, 'The checkpoint time');
  if (expected.revisionId) {
    const origin = document.branchedFrom;
    if (
      !origin ||
      origin.projectId !== expected.sourceProjectId ||
      origin.revisionId !== expected.revisionId
    ) {
      throw new SavePointRequestError(
        'The branch does not record the save state it started from.'
      );
    }
    assertRecentTimestamp(origin.branchedAt, now, 'The branch time');
  }
  return revision;
}

/**
 * Checks a device-local project the browser re-homed for its account
 * (ADR-024 Phase 1): `reidentifyProjectDocument` gave it a fresh id and
 * `adoptProjectDocument` its owner, name and closing "Saved to account"
 * checkpoint. That checkpoint may predate this request — adopting an
 * unchanged document twice keeps the first — but never sits in the future.
 */
export function assertClientAdoption(
  document: ProjectDocument,
  expected: { userId: string; name: string; localProjectId: string },
  now = Date.now()
): void {
  assertClientProjectIdentity(document, expected.userId);
  if (document.name !== expected.name) {
    throw new SavePointRequestError(
      'The new project name does not match the request.'
    );
  }
  if (document.projectId === expected.localProjectId) {
    throw new SavePointRequestError(
      'An adopted project needs its own account id.'
    );
  }
  const revision = document.revisions.at(-1);
  if (!revision) return;
  const checkpoint = document.checkpoints.at(-1);
  if (
    !checkpoint ||
    checkpoint.revisionId !== revision.revisionId ||
    checkpoint.documentVersion !== document.version ||
    checkpoint.reason !== ADOPTION_CHECKPOINT_REASON
  ) {
    throw new SavePointRequestError(
      'The adopted project does not end with its "Saved to account" checkpoint.'
    );
  }
  assertNewestRecordsUnique(document);
  assertNotFutureTimestamp(checkpoint.createdAt, now, 'The checkpoint time');
}
