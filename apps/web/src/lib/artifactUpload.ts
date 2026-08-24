import {
  ARTIFACT_UPLOAD_PART_BYTES,
  type CompleteMultipartUploadRequest,
  type UploadedArtifactPart
} from '@openzcad/shared';

/**
 * The subset of the API client an artifact upload needs. Injected so the
 * chunking, retry, and abort behavior is testable without a network.
 */
export interface ArtifactUploadTransport {
  uploadArtifact(uploadUrl: string, body: Blob): Promise<void>;
  createMultipartUpload(uploadSessionId: string): Promise<{ uploadId: string }>;
  uploadArtifactPart(
    uploadSessionId: string,
    uploadId: string,
    partNumber: number,
    body: Blob
  ): Promise<UploadedArtifactPart>;
  completeMultipartUpload(
    uploadSessionId: string,
    payload: CompleteMultipartUploadRequest
  ): Promise<void>;
  abortMultipartUpload(
    uploadSessionId: string,
    uploadId: string
  ): Promise<void>;
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
 */
export async function uploadArtifactBody(
  transport: ArtifactUploadTransport,
  session: { uploadSessionId: string; uploadUrl: string },
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
  }
): Promise<void> {
  const partBytes = options?.partBytes ?? ARTIFACT_UPLOAD_PART_BYTES;
  const onProgress = options?.onProgress;
  if (body.size <= partBytes) {
    await transport.uploadArtifact(session.uploadUrl, body);
    onProgress?.(body.size, body.size);
    return;
  }
  const retryDelay =
    options?.retryDelay ??
    ((attempt: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, attempt * 1000)));
  const { uploadId } = await transport.createMultipartUpload(
    session.uploadSessionId
  );
  try {
    const parts: UploadedArtifactPart[] = [];
    for (const plan of planUploadParts(body.size, partBytes)) {
      parts.push(
        await uploadPartWithRetry(
          transport,
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
    await transport.completeMultipartUpload(session.uploadSessionId, {
      uploadId,
      parts
    });
  } catch (error) {
    await transport
      .abortMultipartUpload(session.uploadSessionId, uploadId)
      .catch(() => undefined);
    throw error;
  }
}

async function uploadPartWithRetry(
  transport: ArtifactUploadTransport,
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
        body
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
