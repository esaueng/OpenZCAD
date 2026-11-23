import { describe, expect, it } from 'vitest';
import { ImportedStepCache } from './exact-imported-step-cache';
import {
  ImportedMeshCache,
  importedMeshCacheKey
} from './exact-imported-mesh-cache';

const ref = {
  checksumSha256: 'a'.repeat(64)
} as unknown as Parameters<typeof importedMeshCacheKey>[0]['meshPayloadRef'];

/** A one-triangle reference mesh: 72 + 12 buffer bytes. */
function referenceMesh() {
  return {
    vertices: new Float64Array(9),
    indices: Uint32Array.of(0, 1, 2)
  };
}

describe('imported mesh conversion cache', () => {
  it('keys a referenced payload by checksum and triangle count, never embedded facets', () => {
    expect(
      importedMeshCacheKey({ meshPayloadRef: ref, triangleCount: 12 }, 'mm')
    ).toBe(`${'a'.repeat(64)}:12`);
    expect(
      importedMeshCacheKey({ meshPayloadRef: ref, triangleCount: 13 }, 'mm')
    ).not.toBe(
      importedMeshCacheKey({ meshPayloadRef: ref, triangleCount: 12 }, 'mm')
    );
    expect(
      importedMeshCacheKey(
        {
          vertices: [0, 0, 0],
          indices: [0, 0, 0],
          meshPayloadRef: ref,
          triangleCount: 1
        },
        'mm'
      )
    ).toBeUndefined();
    expect(importedMeshCacheKey({ triangleCount: 1 }, 'mm')).toBeUndefined();
  });

  it('keys a payload read at another scale apart from the unscaled read', () => {
    const unscaled = importedMeshCacheKey(
      { meshPayloadRef: ref, triangleCount: 12 },
      'inch'
    );
    // Naming the document's own unit reads the payload as-is: same entry.
    expect(
      importedMeshCacheKey(
        { meshPayloadRef: ref, triangleCount: 12, payloadUnits: 'inch' },
        'inch'
      )
    ).toBe(unscaled);
    const fromMm = importedMeshCacheKey(
      { meshPayloadRef: ref, triangleCount: 12, payloadUnits: 'mm' },
      'inch'
    );
    const fromCm = importedMeshCacheKey(
      { meshPayloadRef: ref, triangleCount: 12, payloadUnits: 'cm' },
      'inch'
    );
    expect(new Set([unscaled, fromMm, fromCm]).size).toBe(3);
    // The same blob as millimetres in a millimetre document is unscaled.
    expect(
      importedMeshCacheKey(
        { meshPayloadRef: ref, triangleCount: 12, payloadUnits: 'mm' },
        'mm'
      )
    ).toBe(unscaled);
  });

  it('remembers a refused conversion, with its reference mesh, as well as a converted solid', () => {
    const cache = new ImportedMeshCache(1024);
    const solid = {
      kind: 'solid' as const,
      document: new Uint8Array(16),
      advisories: ['Kept the original mesh as a reference.']
    };
    expect(cache.store('solid', solid)).toBe('cached');
    const refused = {
      kind: 'reference' as const,
      message: 'Open shell.',
      mesh: referenceMesh()
    };
    expect(cache.store('refused', refused)).toBe('cached');
    expect(cache.lookup('solid')).toBe(solid);
    // The same mesh object comes back, so its display projection is reused.
    expect(cache.lookup('refused')).toBe(refused);
  });

  it('charges a refused entry for its reference mesh buffers', () => {
    const cache = new ImportedMeshCache(80);
    expect(
      cache.store('mesh', {
        kind: 'reference',
        message: '',
        mesh: referenceMesh()
      })
    ).toBe('budget-exceeded');
  });

  it('charges backing buffers and evicts the oldest entry to stay in budget', () => {
    const cache = new ImportedMeshCache(64);
    const entry = (bytes: number) => ({
      kind: 'solid' as const,
      document: new Uint8Array(bytes),
      advisories: []
    });
    // A small view of a large buffer is charged for the whole buffer.
    expect(
      cache.store('view', {
        kind: 'solid',
        document: new Uint8Array(128).subarray(0, 4),
        advisories: []
      })
    ).toBe('budget-exceeded');
    expect(cache.lookup('view')).toBeUndefined();
    expect(cache.store('a', entry(32))).toBe('cached');
    expect(cache.store('b', entry(32))).toBe('cached');
    expect(cache.store('c', entry(32))).toBe('cached');
    expect(cache.lookup('a')).toBeUndefined();
    expect(cache.lookup('b')).toBeDefined();
    expect(cache.lookup('c')).toBeDefined();
  });

  it('is disabled by a zero budget and cleared with the STEP cache it rides on', () => {
    const disabled = new ImportedMeshCache(0);
    expect(
      disabled.store('x', {
        kind: 'reference',
        message: 'refused',
        mesh: referenceMesh()
      })
    ).toBe('budget-exceeded');
    const meshes = new ImportedMeshCache(1024);
    const steps = new ImportedStepCache(1024, meshes);
    meshes.store('x', {
      kind: 'reference',
      message: 'refused',
      mesh: referenceMesh()
    });
    steps.clear();
    expect(meshes.lookup('x')).toBeUndefined();
  });
});
