import type { ImportedMeshFeatureData } from './imported-mesh';

/**
 * What converting one referenced mesh payload produced. Either way the
 * payload checksum determines it: the conversion reads nothing else.
 *
 * - `solid`: the converted (sewn, or kept-as-is) solid, serialized, plus the
 *   advisories the conversion raised, which a restore raises again.
 * - `reference`: the translator refused the facets, so the feature falls back
 *   to a mesh reference. Remembering the verdict stops every rebuild from
 *   regenerating the STL text and retrying a conversion known to fail. The
 *   reference mesh itself is kept and handed out again: shapes treat it as
 *   immutable, and the same object lets the display projection of it be
 *   reused rather than re-derived on every sync.
 */
export type CachedImportedMesh =
  | { kind: 'solid'; document: Uint8Array; advisories: readonly string[] }
  | {
      kind: 'reference';
      message: string;
      mesh: { vertices: Float64Array; indices: Uint32Array };
    };

export interface ImportedMeshStore {
  lookup(key: string): CachedImportedMesh | undefined;
  store(key: string, entry: CachedImportedMesh): 'cached' | 'budget-exceeded';
}

/**
 * The cache key for a referenced payload, or undefined for embedded facets,
 * which have no content address to key on. The triangle count is part of the
 * key because the builder validates the payload against it.
 */
export function importedMeshCacheKey(
  data: Pick<
    ImportedMeshFeatureData,
    'vertices' | 'indices' | 'meshPayloadRef' | 'triangleCount'
  >
): string | undefined {
  if (data.vertices && data.indices) return undefined;
  const checksum = data.meshPayloadRef?.checksumSha256;
  return checksum ? `${checksum}:${data.triangleCount}` : undefined;
}

function entryBytes(entry: CachedImportedMesh): number {
  // Charge the backing allocation, as the STEP cache does, so a small view
  // cannot retain an arbitrarily large buffer.
  const text =
    entry.kind === 'solid' ? entry.advisories.join('') : entry.message;
  const buffers =
    entry.kind === 'solid'
      ? entry.document.buffer.byteLength
      : entry.mesh.vertices.buffer.byteLength +
        entry.mesh.indices.buffer.byteLength;
  return buffers + text.length * 2;
}

/** Bounded least-recently-stored reuse of converted mesh payloads. */
export class ImportedMeshCache implements ImportedMeshStore {
  private readonly entries = new Map<string, CachedImportedMesh>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  lookup(key: string): CachedImportedMesh | undefined {
    return this.entries.get(key);
  }

  store(key: string, entry: CachedImportedMesh): 'cached' | 'budget-exceeded' {
    const bytes = entryBytes(entry);
    if (
      !Number.isFinite(this.maxBytes) ||
      this.maxBytes <= 0 ||
      bytes > this.maxBytes
    ) {
      return 'budget-exceeded';
    }
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= entryBytes(previous);
    }
    for (const [oldest, old] of this.entries) {
      if (this.bytes + bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.bytes -= entryBytes(old);
    }
    this.entries.set(key, entry);
    this.bytes += bytes;
    return 'cached';
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
