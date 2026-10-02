import type { CachedImportedStep, ImportedStepStore } from './exact-build-loop';
import type { ImportedStepDiagnostics } from './exact-types';

/** Bounded optional reuse of the translator's existing exact arena bytes. */
export class ImportedStepCache implements ImportedStepStore {
  private readonly entries = new Map<string, CachedImportedStep>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  lookup(checksum: string): CachedImportedStep | undefined {
    return this.entries.get(checksum);
  }

  store(
    checksum: string,
    document: Uint8Array,
    acceptedDeclaredIndices: number[],
    diagnostics: ImportedStepDiagnostics,
    pinned: ReadonlySet<string>
  ): 'cached' | 'budget-exceeded' | 'rejected-roots' {
    // Restoring a whole arena would also restore rejected roots. The kernel
    // preserves retired handle slots, so do not replay that geometry from a
    // cache. These imports keep the normal exact source-recovery path.
    if (diagnostics.rejections.length > 0) return 'rejected-roots';
    // Charge the backing allocation too: a tiny view must not retain an
    // arbitrarily large buffer. No serialization or copying precedes this gate.
    const bytes = document.buffer.byteLength;
    if (
      !Number.isFinite(this.maxBytes) ||
      this.maxBytes <= 0 ||
      bytes > this.maxBytes
    ) {
      return 'budget-exceeded';
    }
    const previous = this.entries.get(checksum);
    const previousBytes = previous?.document.buffer.byteLength ?? 0;
    let available = this.maxBytes - (this.bytes - previousBytes);
    for (const [key, entry] of this.entries) {
      if (key !== checksum && !pinned.has(key)) {
        available += entry.document.buffer.byteLength;
      }
    }
    // Never evict a prefetched hit: its source bytes were deliberately skipped.
    // Refuse admission before any mutation when protected entries leave no room.
    if (bytes > available) {
      return 'budget-exceeded';
    }
    for (const [key, entry] of this.entries) {
      if (this.bytes - previousBytes + bytes <= this.maxBytes) break;
      if (key === checksum || pinned.has(key)) continue;
      this.entries.delete(key);
      this.bytes -= entry.document.buffer.byteLength;
    }
    this.entries.set(checksum, {
      document,
      acceptedDeclaredIndices,
      diagnostics
    });
    this.bytes += bytes - previousBytes;
    return 'cached';
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}
