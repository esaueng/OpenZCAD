/**
 * What a link visitor's browser does with an encrypted share link's answer
 * (ADR-024 Phase 5; the page is slice 5-11, the check is shared with slice
 * 5-10's tests): `verifySharedSnapshot` in the ADR's order (owner hash,
 * delegation, delegated signer, statement, named author, snapshot
 * signature and project), and only then the version key opened with the
 * share key (`share-version-key`, bound to the snapshot's key epoch, link
 * id and `versionId`, the document version in decimal) and the envelope
 * decrypted as a share snapshot and its document validated.
 */
import {
  fromBase64Url,
  unwrapKey,
  verifySharedSnapshot,
  type EncryptedDocumentBody,
  type VerifiedSharedSnapshot
} from '@openzcad/crypto';
import { assertStorableDocument } from '@openzcad/document-core';
import {
  shareSnapshotVersionId,
  type E2eeSharedSnapshotMetadata,
  type ProjectDocument
} from '@openzcad/shared';
import {
  decodeProjectEnvelopeJob,
  type ProjectEnvelopeDecodeJob,
  type ProjectEnvelopeDecodeResult
} from './decodeJobs';
import type { ShareFragmentParts } from './shareLinkFragment';

export interface OpenedSharedSnapshot {
  readonly verified: VerifiedSharedSnapshot;
  readonly body: EncryptedDocumentBody;
  readonly document: ProjectDocument;
}

/** Verifies, then decrypts, one served share snapshot. */
export async function openSharedSnapshot(input: {
  readonly parts: ShareFragmentParts;
  readonly metadata: E2eeSharedSnapshotMetadata;
  readonly envelope: Uint8Array;
  readonly now: number;
  /** Defaults to decoding in-line; the page passes the decode worker. */
  readonly open?: (
    job: Omit<ProjectEnvelopeDecodeJob, 'type'>
  ) => Promise<ProjectEnvelopeDecodeResult>;
}): Promise<OpenedSharedSnapshot> {
  const { parts, metadata, envelope } = input;
  const verified = await verifySharedSnapshot({
    ownerIdentityKeyHash: parts.ownerIdentityHash,
    shareKey: parts.shareKey,
    ownerIdentityKey: fromBase64Url(metadata.ownerIdentityKey),
    delegation: {
      statement: fromBase64Url(metadata.delegation.statement),
      signature: fromBase64Url(metadata.delegation.signature)
    },
    authority: {
      statement: fromBase64Url(metadata.authority.statement),
      signature: fromBase64Url(metadata.authority.signature)
    },
    snapshot: envelope,
    snapshotSignature: fromBase64Url(metadata.snapshotSignature),
    authorKey: fromBase64Url(metadata.authorKey),
    now: input.now
  });
  const header = verified.header;
  const versionKey = await unwrapKey(
    parts.shareKey,
    fromBase64Url(metadata.wrappedVersionKey),
    {
      purpose: 'share-version-key',
      projectId: verified.projectId,
      keyEpoch: header.keyEpoch,
      shareId: verified.shareId,
      versionId: shareSnapshotVersionId(header.documentVersion)
    }
  );
  const open =
    input.open ??
    ((job) => decodeProjectEnvelopeJob({ type: 'project-envelope', ...job }));
  let result: ProjectEnvelopeDecodeResult;
  try {
    result = await open({
      kind: 'share-snapshot',
      versionKey,
      envelope,
      expect: {
        projectId: verified.projectId,
        documentVersion: header.documentVersion,
        keyEpoch: header.keyEpoch
      }
    });
  } finally {
    versionKey.fill(0);
  }
  const body = result.value as EncryptedDocumentBody;
  const document = assertStorableDocument(body.document);
  if (document.projectId !== verified.projectId) {
    throw new Error('The shared document belongs to another project.');
  }
  return { verified, body, document };
}
