/**
 * The visitor page of an end-to-end encrypted share link (ADR-024 Phase 5,
 * slice 5-11; roadmap L11): what the app runs for `#share=<token>.<key>.
 * <owner>`, loaded only when such a link is opened.
 *
 * 1. The fragment is parsed (`parseShareFragment`); the server never sees
 *    the key or the owner hash.
 * 2. `GET /api/e2ee/share/:token`, anonymous: a 404 is a link that serves
 *    nothing (unknown, revoked, not published, sharing off), as for
 *    plaintext links.
 * 3. `openSharedSnapshot` checks the ADR's order (owner hash, delegation and
 *    its expiry, delegated signer, statement and its expiry, named author,
 *    snapshot signature and project), opens the version key with the share
 *    key and decrypts the snapshot in the decode worker. No MLS: a visitor
 *    is not a member.
 * 4. Every content blob the verified body names and the document uses (its
 *    imports and pictures) is fetched from `GET /api/e2ee/share/:token/
 *    blobs/:blobId`, decrypted in the decode worker against the body's
 *    reference (key, ciphertext hash, length) and checked against the
 *    document's own checksum before it reaches this device's source store,
 *    where geometry workers and pictures read it. Nothing opens until all of
 *    them have.
 *
 * Every refusal is a `SharedLinkRefusal` with a reason and plain words
 * (`sharedLinkRefusalMessage`); the mode shown (view or tweak) is the
 * verified statement's, never the server's metadata.
 */
import {
  E2eeError,
  ShareLinkError,
  type ContentBlobReference,
  type ShareLinkFailure,
  type ShareLinkMode
} from '@openzcad/crypto';
import {
  createE2eeShareLinksApi,
  documentNodesWithHistory,
  importedSourceReferenceOf,
  referenceImagesWithHistory,
  type E2eeShareLinksApi,
  type ProjectDocument
} from '@openzcad/shared';
import type {
  ContentBlobDecodeJob,
  ContentBlobDecodeResult
} from './decodeJobs';
import type {
  ProjectEnvelopeDecodeJob,
  ProjectEnvelopeDecodeResult
} from './decodeJobs';
import {
  parseShareFragment,
  type ShareFragmentParts
} from './shareLinkFragment';
import {
  DecodeWorkerError,
  createE2eeDecoder,
  type E2eeDecoder
} from './decodeWorker';
import { openSharedSnapshot } from './sharedSnapshot';

/** Why a visitor's link did not open. */
export type SharedLinkRefusalReason =
  /** The owner has not confirmed the link recently (an expired statement or delegation). */
  | 'not-confirmed'
  /** A statement or delegation from the future: this device's clock. */
  | 'not-yet-valid'
  /** The fragment is incomplete or altered (owner hash, share key). */
  | 'wrong-link'
  /** A signature, signer or envelope that does not verify. */
  | 'not-verified'
  /** A content blob that does not match what the snapshot names. */
  | 'file-mismatch'
  /** An import whose file the owner keeps on their device only. */
  | 'file-missing';

export class SharedLinkRefusal extends Error {
  constructor(
    readonly reason: SharedLinkRefusalReason,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'SharedLinkRefusal';
  }
}

export const SHARED_LINK_MESSAGES: Record<SharedLinkRefusalReason, string> = {
  'not-confirmed':
    "The owner hasn't recently confirmed this link, so it can't be opened right now. Ask them to open the project's sharing settings, then try again.",
  'not-yet-valid':
    "This link isn't valid yet. Check that this device's date and time are right, then try again.",
  'wrong-link':
    'This link is incomplete or has been changed. Ask the owner to send it again.',
  'not-verified':
    "This shared model couldn't be verified, so it wasn't opened. Ask the owner to send the link again.",
  'file-mismatch':
    "A file in this shared model couldn't be verified, so it wasn't opened. Ask the owner to send the link again.",
  'file-missing':
    'The owner needs to save the files this model uses to their account before this link can open.'
};

const REASONS: Partial<Record<ShareLinkFailure, SharedLinkRefusalReason>> = {
  'delegation-expired': 'not-confirmed',
  'authority-expired': 'not-confirmed',
  'delegation-not-yet-valid': 'not-yet-valid',
  'authority-not-yet-valid': 'not-yet-valid',
  'owner-mismatch': 'wrong-link',
  'link-mismatch': 'wrong-link'
};

/** The refusal behind an error from opening a snapshot. */
function snapshotRefusal(error: unknown): unknown {
  if (error instanceof SharedLinkRefusal) return error;
  // A stuck or crashed decode worker says nothing about the link.
  if (error instanceof DecodeWorkerError) return error;
  const reason =
    error instanceof ShareLinkError
      ? (REASONS[error.reason] ?? 'not-verified')
      : 'not-verified';
  return new SharedLinkRefusal(reason, SHARED_LINK_MESSAGES[reason], {
    cause: error
  });
}

/**
 * Plain words for any failure while opening an encrypted link: a refusal's
 * own message, or the fallback for what is not one (a network failure).
 */
export function sharedLinkRefusalMessage(
  error: unknown,
  fallback = 'Could not open the share link.'
): string {
  return error instanceof SharedLinkRefusal ? error.message : fallback;
}

export interface EncryptedSharedProject {
  readonly projectId: string;
  readonly shareId: string;
  readonly name: string;
  /** The verified statement's mode. */
  readonly mode: ShareLinkMode;
  readonly document: ProjectDocument;
}

/** What opening a link uses; tests replace the network and the stores. */
export interface SharedSnapshotLoaderDeps {
  readonly fetch?: typeof fetch;
  readonly api?: E2eeShareLinksApi;
  readonly now?: () => number;
  readonly decodeProjectEnvelope?: (
    job: Omit<ProjectEnvelopeDecodeJob, 'type'>
  ) => Promise<ProjectEnvelopeDecodeResult>;
  readonly decodeContentBlob?: (
    job: Omit<ContentBlobDecodeJob, 'type'>
  ) => Promise<ContentBlobDecodeResult>;
  readonly loadSourceBlob?: (checksum: string) => Promise<Uint8Array | null>;
  readonly putSourceBlob?: (bytes: Uint8Array<ArrayBuffer>) => Promise<unknown>;
  /** Download idle budget; tests make it short. */
  readonly idleMs?: number;
}

/** Where a visitor fetches one content blob of the link's snapshot. */
export function sharedBlobUrl(token: string, blobId: string): string {
  return `/api/e2ee/share/${encodeURIComponent(token)}/blobs/${encodeURIComponent(blobId)}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as Uint8Array<ArrayBuffer>
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** The files a document uses: blob id, plaintext checksum and a name. */
function documentFiles(document: ProjectDocument): {
  artifactId: string;
  checksum: string;
  name: string;
  logicalBytes: number | null;
}[] {
  const files = new Map<
    string,
    {
      artifactId: string;
      checksum: string;
      name: string;
      logicalBytes: number | null;
    }
  >();
  for (const node of documentNodesWithHistory(document)) {
    if (node?.kind !== 'feature') continue;
    const ref = importedSourceReferenceOf(node.data);
    const data = node.data as { artifactId?: unknown; sourceName?: unknown };
    if (!ref || typeof data.artifactId !== 'string') continue;
    if (files.has(ref.checksumSha256)) continue;
    files.set(ref.checksumSha256, {
      artifactId: data.artifactId,
      checksum: ref.checksumSha256,
      name: typeof data.sourceName === 'string' ? data.sourceName : 'a file',
      logicalBytes: ref.logicalBytes
    });
  }
  for (const image of referenceImagesWithHistory(document)) {
    const checksum = image?.source?.checksumSha256;
    if (typeof image?.artifactId !== 'string' || typeof checksum !== 'string')
      continue;
    if (files.has(checksum)) continue;
    files.set(checksum, {
      artifactId: image.artifactId,
      checksum,
      name: image.name,
      logicalBytes: image.source.logicalBytes
    });
  }
  return [...files.values()];
}

/** The most ciphertext a reference's blob can take (as for members). */
function maxCiphertextBytes(reference: ContentBlobReference): number {
  return Math.ceil(reference.plaintextLength * 1.3) + 1024 * 1024;
}

/**
 * Puts every file the shared document uses into this device's source store,
 * from the link's blob route, each decrypted against the snapshot body's
 * reference and checked against the document's checksum.
 */
async function preloadSharedBlobs(
  token: string,
  document: ProjectDocument,
  blobs: readonly ContentBlobReference[],
  deps: Required<
    Pick<
      SharedSnapshotLoaderDeps,
      'fetch' | 'decodeContentBlob' | 'loadSourceBlob' | 'putSourceBlob'
    >
  > & { idleMs: number },
  isCurrent: () => boolean
): Promise<void> {
  const { readSharedSourceBytes } = await import('../sharedSourceDownload');
  const references = new Map(
    blobs.map((reference) => [reference.blobId, reference])
  );
  for (const file of documentFiles(document)) {
    if (!isCurrent()) return;
    if (await deps.loadSourceBlob(file.checksum)) continue;
    const reference = references.get(file.artifactId);
    if (!reference) {
      // A device-only file of the owner's, or a name the body does not
      // authenticate: either way there is nothing this link can serve.
      throw new SharedLinkRefusal(
        file.artifactId.startsWith('artifact_local_')
          ? 'file-missing'
          : 'file-mismatch',
        file.artifactId.startsWith('artifact_local_')
          ? SHARED_LINK_MESSAGES['file-missing']
          : SHARED_LINK_MESSAGES['file-mismatch']
      );
    }
    let plaintext: Uint8Array<ArrayBuffer>;
    try {
      const ciphertext = await readSharedSourceBytes(
        sharedBlobUrl(token, reference.blobId),
        file.name,
        deps.fetch,
        maxCiphertextBytes(reference),
        deps.idleMs
      );
      if (!ciphertext) throw new E2eeError('limit-exceeded', 'Too large');
      const result = await deps.decodeContentBlob({
        reference,
        envelope: ciphertext,
        output: 'chunks'
      });
      if (
        !('chunks' in result) ||
        result.byteLength !== reference.plaintextLength
      ) {
        throw new E2eeError('malformed', 'The file did not decode');
      }
      plaintext = new Uint8Array(result.byteLength);
      let offset = 0;
      for (const chunk of result.chunks) {
        plaintext.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch (error) {
      // A stalled or unavailable download keeps its own words.
      if (!(error instanceof E2eeError)) throw error;
      throw new SharedLinkRefusal(
        'file-mismatch',
        SHARED_LINK_MESSAGES['file-mismatch'],
        { cause: error }
      );
    }
    if (
      (file.logicalBytes !== null &&
        plaintext.byteLength !== file.logicalBytes) ||
      (await sha256Hex(plaintext)) !== file.checksum
    ) {
      throw new SharedLinkRefusal(
        'file-mismatch',
        SHARED_LINK_MESSAGES['file-mismatch']
      );
    }
    if (!isCurrent()) return;
    await deps.putSourceBlob(plaintext);
  }
}

/**
 * Opens an encrypted share link (`link` is the fragment's payload,
 * `<token>.<key>.<owner>`): null when the link serves nothing, the verified
 * and decrypted project otherwise, or a `SharedLinkRefusal`.
 */
export async function loadEncryptedSharedProject(
  link: string,
  isCurrent: () => boolean = () => true,
  deps: SharedSnapshotLoaderDeps = {}
): Promise<EncryptedSharedProject | null> {
  const parts: ShareFragmentParts | null = parseShareFragment(`share=${link}`);
  if (!parts) {
    throw new SharedLinkRefusal(
      'wrong-link',
      SHARED_LINK_MESSAGES['wrong-link']
    );
  }
  const fetcher = deps.fetch ?? ((input, init) => fetch(input, init));
  const api = deps.api ?? createE2eeShareLinksApi(fetcher);
  // The decode worker, started on first use and stopped when done.
  const held: { decoder: E2eeDecoder | null } = { decoder: null };
  const worker = (): E2eeDecoder => (held.decoder ??= createE2eeDecoder());
  try {
    const served = await api.shared(parts.token);
    if (!served || !isCurrent()) return null;
    let opened: Awaited<ReturnType<typeof openSharedSnapshot>>;
    try {
      opened = await openSharedSnapshot({
        parts,
        metadata: served.metadata,
        envelope: served.envelope,
        now: (deps.now ?? Date.now)(),
        open:
          deps.decodeProjectEnvelope ??
          ((job) => worker().decodeProjectEnvelope(job))
      });
    } catch (error) {
      throw snapshotRefusal(error);
    }
    if (!isCurrent()) return null;
    const store =
      deps.loadSourceBlob && deps.putSourceBlob
        ? null
        : await import('../localProjectStore');
    await preloadSharedBlobs(
      parts.token,
      opened.document,
      opened.body.blobs,
      {
        fetch: fetcher,
        decodeContentBlob:
          deps.decodeContentBlob ?? ((job) => worker().decodeContentBlob(job)),
        loadSourceBlob:
          deps.loadSourceBlob ??
          ((checksum) => store!.loadSourceBlob(checksum)),
        putSourceBlob:
          deps.putSourceBlob ?? ((bytes) => store!.putSourceBlob(bytes)),
        idleMs: deps.idleMs ?? 30_000
      },
      isCurrent
    );
    return {
      projectId: opened.verified.projectId,
      shareId: opened.verified.shareId,
      name: opened.document.name,
      mode: opened.verified.mode,
      document: opened.document
    };
  } finally {
    held.decoder?.dispose();
  }
}
