import {
  ARTIFACT_UPLOAD_PART_BYTES,
  type CompleteMultipartUploadRequest,
  type UploadedArtifactPart
} from '@openzcad/shared';
import type { ProjectRequestContext } from './projectWriteGate';

/**
 * The subset of the API client an artifact upload needs. Injected so the
 * chunking, retry, and abort behavior is testable without a network.
 *
 * Every method takes the request's context (`projectWriteGate.ts`): the
 * session's routes name no project, so each request carries the project
 * it writes and whether its body is plaintext or encrypted, and the gate
 * checks that immediately before the request is sent.
 */
export interface ArtifactUploadTransport {
  uploadArtifact(
    uploadUrl: string,
    body: Blob,
    context: ProjectRequestContext
  ): Promise<void>;
  createMultipartUpload(
    uploadSessionId: string,
    context: ProjectRequestContext
  ): Promise<{ uploadId: string }>;
  uploadArtifactPart(
    uploadSessionId: string,
    uploadId: string,
    partNumber: number,
    body: Blob,
    context: ProjectRequestContext
  ): Promise<UploadedArtifactPart>;
  completeMultipartUpload(
    uploadSessionId: string,
    payload: CompleteMultipartUploadRequest,
    context: ProjectRequestContext
  ): Promise<void>;
  abortMultipartUpload(
    uploadSessionId: string,
    uploadId: string,
    context: ProjectRequestContext
  ): Promise<void>;
}

/**
 * An upload session as its opener holds it: the project the opener asked
 * the session for (never taken from the account's answer), whether the
 * body it uploads is plaintext or encrypted, and the session id and
 * upload URL the account answered with.
 */
export interface ArtifactUploadSession {
  projectId: string;
  payload: 'plaintext' | 'encrypted';
  uploadSessionId: string;
  uploadUrl: string;
}

/**
 * The session's upload URL, if it is this application's own content route
 * for that same session: a root-relative `/api/uploads/<id>/content`.
 * Anything else the account answers with (another origin, another
 * session, another route) is refused before a byte is sent.
 */
export function verifiedUploadUrl(session: {
  uploadSessionId: string;
  uploadUrl: string;
}): string {
  const path = uploadContentPath(session.uploadUrl);
  if (!path || path.sessionId !== session.uploadSessionId) {
    throw new Error(
      'The account answered with an upload address for something else. Nothing was sent.'
    );
  }
  return path.pathname;
}

/** A root-relative content route's path and session, or null. */
function uploadContentPath(
  uploadUrl: string
): { pathname: string; sessionId: string } | null {
  const base = 'http://upload.invalid';
  if (!uploadUrl.startsWith('/') || uploadUrl.startsWith('//')) return null;
  try {
    const url = new URL(uploadUrl, base);
    if (url.origin !== base || url.search || url.hash) return null;
    const segment = /^\/api\/uploads\/([^/]+)\/content$/.exec(
      url.pathname
    )?.[1];
    return segment
      ? { pathname: url.pathname, sessionId: decodeURIComponent(segment) }
      : null;
  } catch {
    return null;
  }
}

/** One initial try plus two retries per part before the upload is aborted. */
export const ARTIFACT_PART_UPLOAD_ATTEMPTS = 3;

export interface UploadPartPlan {
  partNumber: number;
  /** Byte offset of the part's first byte. */
  start: number;
  /** Exclusive end offset; `Blob.slice` clamps the final part. */
  end: number;
}

/**
 * Fixed-size slicing for a chunked upload. Every part except the last is
 * exactly `partBytes`; R2 requires equal-size non-final parts.
 */
export function planUploadParts(
  totalBytes: number,
  partBytes: number = ARTIFACT_UPLOAD_PART_BYTES
): UploadPartPlan[] {
  const parts: UploadPartPlan[] = [];
  for (
    let partNumber = 1, start = 0;
    start < totalBytes;
    partNumber += 1, start += partBytes
  ) {
    parts.push({
      partNumber,
      start,
      end: Math.min(start + partBytes, totalBytes)
    });
  }
  return parts;
}

/**
 * Uploads one artifact body into an upload session. Bodies at or below the
 * part size go up as the original single PUT; anything larger is chunked so
 * each request stays under the Worker's per-request body cap. Each part is
 * retried a bounded number of times; when the upload still fails, the
 * multipart state is aborted (best-effort — the expired-session purge is the
 * backstop) before the error propagates to the caller.
 *
 * Every request carries the session's project and payload as its context,
 * so the write gate checks them immediately before each one is sent.
 */
export async function uploadArtifactBody(
  transport: ArtifactUploadTransport,
  session: ArtifactUploadSession,
  body: Blob,
  options?: {
    partBytes?: number;
    /** Test seam; defaults to a short real delay between retry attempts. */
    retryDelay?: (attempt: number) => Promise<void>;
    /**
     * Bytes accepted so far, after each part lands. A single-PUT body reports
     * once, on completion — there is no progress inside one request to report.
     */
    onProgress?: (uploaded: number, total: number) => void;
    /**
     * Stops the upload between parts. A chunked upload that stops this way
     * still aborts its multipart state on the way out, so no partial upload is
     * left occupying the session.
     */
    signal?: AbortSignal;
  }
): Promise<void> {
  const partBytes = options?.partBytes ?? ARTIFACT_UPLOAD_PART_BYTES;
  const uploadUrl = verifiedUploadUrl(session);
  const context: ProjectRequestContext = {
    projectId: session.projectId,
    payload: session.payload
  };
  const onProgress = options?.onProgress;
  const signal = options?.signal;
  signal?.throwIfAborted();
  if (body.size <= partBytes) {
    await transport.uploadArtifact(uploadUrl, body, context);
    onProgress?.(body.size, body.size);
    return;
  }
  const retryDelay =
    options?.retryDelay ??
    ((attempt: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, attempt * 1000)));
  const { uploadId } = await transport.createMultipartUpload(
    session.uploadSessionId,
    context
  );
  try {
    const parts: UploadedArtifactPart[] = [];
    for (const plan of planUploadParts(body.size, partBytes)) {
      // Between parts. Mid-request there is nothing to stop, and the `catch`
      // below turns this into the same abort-and-rethrow a failed part gets.
      signal?.throwIfAborted();
      parts.push(
        await uploadPartWithRetry(
          transport,
          context,
          session.uploadSessionId,
          uploadId,
          plan.partNumber,
          body.slice(plan.start, plan.end),
          retryDelay
        )
      );
      // `plan.end` is the exact byte the store has now accepted, so this is
      // measured rather than a part count scaled to look like bytes.
      onProgress?.(plan.end, body.size);
    }
    await transport.completeMultipartUpload(
      session.uploadSessionId,
      { uploadId, parts },
      context
    );
  } catch (error) {
    await transport
      .abortMultipartUpload(session.uploadSessionId, uploadId, context)
      .catch(() => undefined);
    throw error;
  }
}

async function uploadPartWithRetry(
  transport: ArtifactUploadTransport,
  context: ProjectRequestContext,
  uploadSessionId: string,
  uploadId: string,
  partNumber: number,
  body: Blob,
  retryDelay: (attempt: number) => Promise<void>
): Promise<UploadedArtifactPart> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ARTIFACT_PART_UPLOAD_ATTEMPTS; attempt++) {
    try {
      return await transport.uploadArtifactPart(
        uploadSessionId,
        uploadId,
        partNumber,
        body,
        context
      );
    } catch (error) {
      lastError = error;
      if (attempt < ARTIFACT_PART_UPLOAD_ATTEMPTS) {
        await retryDelay(attempt);
      }
    }
  }
  throw lastError;
}
