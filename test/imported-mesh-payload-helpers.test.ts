import { describe, expect, it } from 'vitest';
import {
  importedMeshStl as publicImportedMeshStl,
  importedMeshTriangles as publicImportedMeshTriangles
} from '@openzcad/kernel-adapter';
import {
  decodeImportedMeshPayload,
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
  importedMeshPayloadScale,
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
      ]),
      'mm'
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

  it('reads a payload with no payloadUnits as document units in every unit', () => {
    // Characterization: before v153 every payload was in document units, and
    // an absent field must keep reading it exactly so, bit for bit.
    for (const units of ['mm', 'cm', 'm', 'inch'] as const) {
      const decoded = importedMeshTriangles(
        feature,
        new Map([[ref.checksumSha256, bytes]]),
        units
      );
      expect(Array.from(decoded.vertices)).toEqual(vertices);
      expect(
        importedMeshTriangles(
          { ...feature, payloadUnits: units },
          new Map([[ref.checksumSha256, bytes]]),
          units
        ).vertices
      ).toEqual(decoded.vertices);
    }
  });

  it.each([
    ['mm', 'inch', 1 / 25.4],
    ['cm', 'inch', 10 / 25.4],
    ['inch', 'mm', 25.4],
    ['mm', 'cm', 0.1],
    ['m', 'mm', 1000]
  ] as const)(
    'scales a %s payload into a %s document',
    (payloadUnits, units, factor) => {
      const payloads = new Map([[ref.checksumSha256, bytes]]);
      const scaled = importedMeshTriangles(
        { ...feature, payloadUnits },
        payloads,
        units
      );
      expect(importedMeshPayloadScale({ payloadUnits }, units)).toBeCloseTo(
        factor,
        12
      );
      Array.from(scaled.vertices).forEach((value, index) =>
        expect(value).toBeCloseTo(vertices[index]! * factor, 9)
      );
      expect(Array.from(scaled.indices)).toEqual(indices);
      // The fetched bytes are shared by every feature naming them.
      expect(Array.from(decodeImportedMeshPayload(bytes).vertices)).toEqual(
        vertices
      );
    }
  );

  it('never scales embedded triangles, which are always in document units', () => {
    const embedded = importedMeshTriangles(
      { ...feature, vertices, indices, payloadUnits: 'mm' },
      new Map(),
      'inch'
    );
    expect(embedded.vertices).toBe(vertices);
  });

  it('keeps embedded triangles ahead of an unavailable payload reference', () => {
    const embedded = importedMeshTriangles(
      { ...feature, vertices, indices },
      new Map(),
      'mm'
    );
    expect(embedded.vertices).toBe(vertices);
    expect(embedded.indices).toBe(indices);
  });

  it('names the source when its referenced payload is unavailable', () => {
    expect(() => importedMeshTriangles(feature, new Map(), 'mm')).toThrow(
      'Mesh data for "scan.stl" is not available on this device.'
    );
  });

  it('refuses unreadable payloads and sources with neither mesh form', () => {
    expect(() =>
      importedMeshTriangles(
        feature,
        new Map([[ref.checksumSha256, bytes.subarray(0, bytes.length - 1)]]),
        'mm'
      )
    ).toThrow('Imported mesh payload is unreadable.');
    expect(() =>
      importedMeshTriangles(
        { ...feature, meshPayloadRef: undefined },
        new Map(),
        'mm'
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
