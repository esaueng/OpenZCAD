import type { ArtifactId, ImportedSourceReference } from '@openzcad/shared';

import { loadSourceBlob, putSourceBlob } from './localProjectStore';

/**
 * Resolves reference-form exact imports in any browser geometry worker.
 *
 * Local bytes win. A successful archive fallback is content-verified by the
 * blob store before it is accepted, so a wrong download cannot satisfy the
 * document's checksum.
 */
export async function resolveExactSourceBytes(
  ref: ImportedSourceReference,
  context: { artifactId: ArtifactId; sourceName: string }
): Promise<Uint8Array> {
  const local = await loadSourceBlob(ref.checksumSha256);
  if (local) {
    return local;
  }
  if (!context.artifactId.startsWith('artifact_local_')) {
    const response = await fetch(
      `/api/artifacts/${context.artifactId}/download`
    );
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const stored = await putSourceBlob(bytes);
      if (stored.checksumSha256 === ref.checksumSha256) {
        return bytes;
      }
    }
  }
  throw new Error(
    `Import source for "${context.sourceName}" is not in local storage and could not be fetched.`
  );
}
