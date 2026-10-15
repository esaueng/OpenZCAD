import { describe, expect, it } from 'vitest';
import {
  importedMeshStl as publicImportedMeshStl,
  importedMeshTriangles as publicImportedMeshTriangles
} from '@openzcad/kernel-adapter';
import {
  encodeImportedMeshPayload,
  toArtifactId,
  type ImportedSourceReference
} from '@openzcad/shared';
import {
  importedMeshStl as legacyImportedMeshStl,
  importedMeshTriangles as legacyImportedMeshTriangles,
  type ImportedMeshFeatureData
} from '../packages/kernel-adapter/src/imported-mesh';
import {
  importedMeshStl,
  importedMeshTriangles
} from '../packages/kernel-adapter/src/imported-mesh-payload';

const vertices = [0.1 / 25.4, -0, 1e-300, 123456.789, -2.5, 7 / 3, 0, 1, 0];
const indices = [0, 1, 2];
const bytes = encodeImportedMeshPayload({ vertices, indices });
const ref: ImportedSourceReference = {
  marker: 'openzcad-source-ref',
  version: 1,
  hashAlgorithm: 'sha256',
  checksumSha256: 'a'.repeat(64),
  logicalBytes: bytes.byteLength
};
const feature: ImportedMeshFeatureData = {
  featureKind: 'imported-mesh',
  artifactId: toArtifactId('artifact_mesh_helpers'),
  sourceName: 'scan.stl',
  triangleCount: 1,
  meshPayloadRef: ref
};

describe('imported mesh payload helper split', () => {
  it('preserves the public and legacy handoff exports', () => {
    expect(publicImportedMeshStl).toBe(importedMeshStl);
    expect(legacyImportedMeshStl).toBe(importedMeshStl);
    expect(publicImportedMeshTriangles).toBe(importedMeshTriangles);
    expect(legacyImportedMeshTriangles).toBe(importedMeshTriangles);
  });

  it('resolves the named payload into exact document-unit typed arrays', () => {
    const decoded = importedMeshTriangles(
      feature,
      new Map([
        ['b'.repeat(64), new Uint8Array()],
        [ref.checksumSha256, bytes]
      ])
    );
    expect(decoded.vertices).toBeInstanceOf(Float64Array);
    expect(decoded.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(decoded.vertices)).toEqual(vertices);
    expect(Object.is(decoded.vertices[1], -0)).toBe(true);
    expect(Array.from(decoded.indices)).toEqual(indices);
    expect(
      importedMeshStl({
        sourceName: feature.sourceName,
        triangleCount: feature.triangleCount,
        ...decoded
      })
    ).toBe(importedMeshStl({ ...feature, vertices, indices }));
  });

  it('keeps embedded triangles ahead of an unavailable payload reference', () => {
    const embedded = importedMeshTriangles(
      { ...feature, vertices, indices },
      new Map()
    );
    expect(embedded.vertices).toBe(vertices);
    expect(embedded.indices).toBe(indices);
  });

  it('names the source when its referenced payload is unavailable', () => {
    expect(() => importedMeshTriangles(feature, new Map())).toThrow(
      'Mesh data for "scan.stl" is not available on this device.'
    );
  });

  it('refuses unreadable payloads and sources with neither mesh form', () => {
    expect(() =>
      importedMeshTriangles(
        feature,
        new Map([[ref.checksumSha256, bytes.subarray(0, bytes.length - 1)]])
      )
    ).toThrow('Imported mesh payload is unreadable.');
    expect(() =>
      importedMeshTriangles(
        { ...feature, meshPayloadRef: undefined },
        new Map()
      )
    ).toThrow('Imported mesh data is malformed or exceeds the import limit.');
  });

  it.each([
    { indices: [0, 1, 3] },
    { indices: [0, 0, 1] },
    { indices: [0, 1, -1] },
    { indices: [0, 1, 1.5] }
  ])(
    'refuses invalid triangle indices $indices after the split',
    ({ indices: invalid }) => {
      expect(() =>
        importedMeshStl({ ...feature, vertices, indices: invalid })
      ).toThrow('Imported mesh contains an invalid triangle index.');
    }
  );

  it('retains the shared handoff checks for counts and finite coordinates', () => {
    expect(() =>
      importedMeshStl({ ...feature, vertices, indices, triangleCount: 2 })
    ).toThrow('Imported mesh data is malformed or exceeds the import limit.');
    expect(() =>
      importedMeshStl({
        ...feature,
        vertices: [NaN, ...vertices.slice(1)],
        indices
      })
    ).toThrow('Imported mesh data is malformed or exceeds the import limit.');
  });
});
