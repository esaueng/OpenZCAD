/** Raw plaintext storage transport, decoded only by the browser (ADR-024 8-3). */
export const LEGACY_PROJECT_FRAME_CONTENT_TYPE =
  'application/vnd.openzcad.legacy-project-frame';

export interface LegacySourceAlias {
  projectId: string;
  kind: 'step-import' | 'mesh-payload';
  checksumSha256: string;
  logicalBytes: number;
  artifactId: string;
}

export interface LegacyProjectStorageMetadata {
  version: 1;
  projectId: string;
  kind: 'inline' | 'snapshot';
  /** Raw payload bytes, before decompression. */
  storedBytes: number;
  logicalBytes: number;
  checksumSha256: string | null;
  aliases: readonly LegacySourceAlias[];
}
