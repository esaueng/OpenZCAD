/**
 * Share snapshots written straight to the Worker (ADR-024 slice 8-C1): a
 * share-snapshot envelope of the project's head, signed by a device of
 * `d`'s account and sent to `PUT …/share-links/:shareId/snapshot` as an
 * encrypted-project frame. The Worker checks only what it can (the header,
 * the signer, the key epoch, the version), so the envelope's keys are
 * random here: what matters is its size (inline or R2) and the blobs its
 * header names.
 */
import { randomBytes } from 'node:crypto';
import {
  signProjectEnvelope,
  toBase64Url,
  type ContentBlobReference
} from '@openzcad/crypto';
import {
  E2EE_FRAME_CONTENT_TYPE,
  encodeE2eeFrame,
  type ProjectDocument
} from '@openzcad/shared';
import { sealSnapshot } from '../../apps/web/src/lib/e2ee/shareLinks';
import type { Device, Server } from './e2ee-documents';
import { head, serverKeyEpoch } from './e2ee-members';

export interface RawSnapshot {
  readonly envelope: Uint8Array<ArrayBuffer>;
  readonly metadata: Record<string, string>;
}

/** Above the Worker's inline size (256 KiB), so the body goes to R2. */
export const R2_PADDING = 300 * 1024;

export async function sealRawSnapshot(
  srv: Server,
  d: Device,
  projectId: string,
  shareId: string,
  options: {
    readonly document: ProjectDocument;
    /** Random bytes carried in the body (base64url), defeating compression. */
    readonly padding?: number;
    readonly blobs?: readonly ContentBlobReference[];
    readonly deviceId?: string;
  }
): Promise<RawSnapshot> {
  const current = head(srv, projectId);
  const deviceId = options.deviceId ?? d.deviceId!;
  const signer = d.account.devices.get(deviceId)!;
  const document = {
    ...options.document,
    ...(options.padding
      ? { padding: toBase64Url(randomBytes(options.padding)) }
      : {})
  } as ProjectDocument;
  const sealed = await sealSnapshot({
    projectId,
    shareId,
    keyEpoch: serverKeyEpoch(srv, projectId),
    projectKey: randomBytes(32),
    authenticator: randomBytes(32),
    shareKey: randomBytes(32),
    head: { version: current.document_version, hash: current.version_hash },
    document,
    blobs: options.blobs ?? [],
    sign: (envelope) => signProjectEnvelope(signer.signing.privateKey, envelope)
  });
  return {
    envelope: new Uint8Array(sealed.envelope),
    metadata: {
      signature: toBase64Url(sealed.signature),
      signerDeviceId: deviceId,
      wrappedForLinkVisitors: toBase64Url(sealed.forLinkVisitors),
      wrappedForMembers: toBase64Url(sealed.forMembers)
    }
  };
}

export function putRawSnapshot(
  srv: Server,
  d: Device,
  projectId: string,
  shareId: string,
  snapshot: RawSnapshot
): Promise<Response> {
  return srv.call(
    'PUT',
    `/api/e2ee/projects/${projectId}/share-links/${shareId}/snapshot`,
    {
      user: d.account.userId,
      raw: new Uint8Array(encodeE2eeFrame(snapshot.metadata, snapshot.envelope)),
      contentType: E2EE_FRAME_CONTENT_TYPE
    }
  );
}

/** The R2 snapshot objects of a project, in key order. */
export function snapshotObjects(srv: Server, projectId: string): string[] {
  return [...srv.bucket.objects.keys()]
    .filter((key) => key.startsWith(`e2ee/${projectId}/s/`))
    .sort();
}
