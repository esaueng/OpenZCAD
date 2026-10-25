/**
 * The content blob references this page holds (ADR-024 Phase 4, content
 * blobs). A reference is a blob's id, kind, random key, ciphertext hash and
 * plaintext length; it comes from the verified encrypted documents this page
 * opened (their bodies' `blobs` tables) and from the blobs it uploaded. The
 * key never reaches the server, so a blob opens only with a reference held
 * here.
 *
 * Loads no crypto: the source resolver and the backup writer ask it whether
 * an artifact id is an encrypted blob before falling back to the plaintext
 * download, and the page reader registered by `encryptedProjects.ts` (the
 * decode worker) decrypts it.
 */
import type { ContentBlobReference } from '@openzcad/crypto';
import { getKeySessionRevision, isCurrentKeySession } from './keySession';

export interface HeldBlobReference {
  readonly reference: ContentBlobReference;
  /**
   * The plaintext's SHA-256 (lowercase hex) when this page knows it: from
   * the document's import or picture that names the blob, or from its own
   * upload. A dedupe hit is trusted only against it.
   */
  readonly checksumSha256: string | null;
}

export interface BlobReferenceRegistry {
  remember(
    projectId: string,
    reference: ContentBlobReference,
    checksumSha256?: string | null
  ): void;
  get(projectId: string, blobId: string): HeldBlobReference | null;
  /** The project a blob id belongs to, when this page holds its reference. */
  projectOf(blobId: string): string | null;
  clear(): void;
}

export function createBlobReferenceRegistry(): BlobReferenceRegistry {
  const byProject = new Map<string, Map<string, HeldBlobReference>>();
  const projects = new Map<string, string>();
  return {
    remember(projectId, reference, checksumSha256 = null) {
      let held = byProject.get(projectId);
      if (!held) {
        held = new Map<string, HeldBlobReference>();
        byProject.set(projectId, held);
      }
      const known = held.get(reference.blobId);
      held.set(reference.blobId, {
        reference,
        checksumSha256: checksumSha256 ?? known?.checksumSha256 ?? null
      });
      projects.set(reference.blobId, projectId);
    },
    get: (projectId, blobId) => byProject.get(projectId)?.get(blobId) ?? null,
    projectOf: (blobId) => projects.get(blobId) ?? null,
    clear() {
      byProject.clear();
      projects.clear();
    }
  };
}

/** This page's references, dropped with the key session. */
export const pageBlobReferences = createBlobReferenceRegistry();

/** The key session a view is bound to (`keySession.ts`; tests pass their own). */
export interface KeySessionFence {
  revision(): number;
  isCurrent(revision: number): boolean;
}

const pageKeySession: KeySessionFence = {
  revision: getKeySessionRevision,
  isCurrent: isCurrentKeySession
};

/** A late result's reference outlived the key session it was made in. */
export class KeySessionEndedError extends Error {
  constructor() {
    super(
      'Encryption was locked before this finished. Unlock it and try again.'
    );
    this.name = 'KeySessionEndedError';
  }
}

/**
 * `registry` as the key session current now sees it. Once that session
 * ends (sign-out, lock, another account) the view keeps nothing: an upload
 * or a read finishing late has its reference's key wiped and refused rather
 * than stored in the page registry the next session reads, and lookups
 * find nothing.
 */
export function sessionBoundReferences(
  registry: BlobReferenceRegistry,
  fence: KeySessionFence = pageKeySession
): BlobReferenceRegistry {
  const revision = fence.revision();
  const live = () => fence.isCurrent(revision);
  return {
    remember(projectId, reference, checksumSha256) {
      if (!live()) {
        reference.key.fill(0);
        throw new KeySessionEndedError();
      }
      registry.remember(projectId, reference, checksumSha256);
    },
    get: (projectId, blobId) =>
      live() ? registry.get(projectId, blobId) : null,
    projectOf: (blobId) => (live() ? registry.projectOf(blobId) : null),
    clear: () => registry.clear()
  };
}

/** Downloads and decrypts one blob (the decode worker in a page). */
export type EncryptedBlobReader = (
  projectId: string,
  blobId: string,
  signal?: AbortSignal,
  /** Called as ciphertext arrives, for a caller's idle timer. */
  onProgress?: () => void
) => Promise<Uint8Array<ArrayBuffer>>;

let pageReader: EncryptedBlobReader | null = null;

/** Installed by `encryptedProjects.ts` while a key session is open. */
export function setEncryptedBlobReader(reader: EncryptedBlobReader | null) {
  pageReader = reader;
}

/**
 * How to read an artifact id as an encrypted blob of this page, or null
 * when it is not one (a plaintext artifact, or a page without the keys).
 */
export function encryptedBlobSource(artifactId: string): {
  projectId: string;
  read(
    signal?: AbortSignal,
    onProgress?: () => void
  ): Promise<Uint8Array<ArrayBuffer>>;
} | null {
  const projectId = pageBlobReferences.projectOf(artifactId);
  const reader = pageReader;
  if (!projectId || !reader) return null;
  return {
    projectId,
    read: (signal, onProgress) =>
      reader(projectId, artifactId, signal, onProgress)
  };
}
