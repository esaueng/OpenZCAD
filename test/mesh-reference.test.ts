import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  importMeshBody,
  transformBody,
  addPrimitiveFeature,
  booleanBodies
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { parseStl } from '@openzcad/io-stl';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { coincidentBoxSoup } from './support/mesh-import-fixtures';

const user = toUserId('user_mesh_reference');
function reference() {
  return importMeshBody(createProjectDocument('Mesh reference', user), {
    name: 'Non-manifold mesh',
    artifactId: 'artifact_mesh_reference',
    sourceName: 'mesh.stl',
    ...coincidentBoxSoup()
  });
}

describe('STL mesh references', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it('keeps non-manifold facets across cached replay and a fresh-device reopen', async () => {
    const { document, bodyId } = reference();
    for (let pass = 0; pass < 2; pass++) {
      const state = await adapter.syncDocument(document);
      const body = state.bodyRepresentations[bodyId]!;
      expect(body.meshReference).toBe(true);
      expect(body.mesh.indices).toHaveLength(24 * 3);
      expect(body.exportableStep).toBe(false);
      expect(body.bbox).toEqual({
        min: { x: 0, y: 0, z: 0 },
        max: { x: 2, y: 3, z: 4 }
      });
      expect(state.featureWarnings).toEqual([
        expect.objectContaining({ kind: 'advisory' })
      ]);
      // Returned buffers belong to the caller, never the retained source.
      body.mesh.vertices.fill(999);
    }
    const reopened = await createExactKernelAdapter();
    try {
      const state = await reopened.syncDocument(
        JSON.parse(JSON.stringify(document)) as ProjectDocument
      );
      expect(state.bodyRepresentations[bodyId]!.mesh.vertices[0]).toBe(0);
      expect(state.bodyRepresentations[bodyId]!.mesh.indices).toHaveLength(72);
    } finally {
      reopened.dispose();
    }
  });

  it.each(['stl-ascii', 'stl-binary'] as const)(
    'exports all reference and exact bodies as %s',
    async (format) => {
      const { document, bodyId } = reference();
      const mixed = addPrimitiveFeature(document, {
        name: 'Exact box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      });
      const bytes = await adapter.exportMesh(mixed, mixed.bodyOrder, {
        format,
        deflection: 0.08
      });
      const parsed = parseStl(bytes.buffer, 'roundtrip.stl');
      expect(parsed.triangleCount).toBe(36);
      const { document: roundtrip, bodyId: restoredId } = importMeshBody(
        createProjectDocument('Reimport', user),
        {
          ...parsed,
          name: 'Reimport',
          sourceName: 'roundtrip.stl',
          artifactId: 'artifact_roundtrip'
        }
      );
      const state = await adapter.syncDocument(roundtrip);
      expect(state.bodyRepresentations[restoredId]!.mesh.indices).toHaveLength(
        36 * 3
      );
      // Exact exporters must never quietly omit the reference from a mixed selection.
      await expect(
        adapter.exportStep(mixed, [bodyId, mixed.bodyOrder[1]!])
      ).rejects.toThrow(/mesh reference/);
    }
  );

  it('moves and scales a reference without modifying its source and exports physical units', async () => {
    const { document, bodyId } = reference();
    document.units = 'inch';
    const moved = transformBody(document, {
      name: 'Move mesh',
      targetBodyId: bodyId,
      translation: { x: 10, y: 20, z: 30 },
      scale: 2
    });
    const state = await adapter.syncDocument(moved.document);
    expect(state.bodyRepresentations[bodyId]!.bbox).toEqual({
      min: { x: 10, y: 20, z: 30 },
      max: { x: 14, y: 26, z: 38 }
    });
    const stl = await adapter.exportStl(moved.document, [bodyId]);
    const parsed = parseStl(new TextEncoder().encode(stl).buffer, 'moved.stl');
    expect(
      Math.min(...parsed.vertices.filter((_, i) => i % 3 === 0))
    ).toBeCloseTo(254, 9);
    const source = await adapter.syncDocument(document);
    expect(source.bodyRepresentations[bodyId]!.bbox.min).toEqual({
      x: 0,
      y: 0,
      z: 0
    });
  });

  it('refuses solid modeling with a reference while retaining both source bodies', async () => {
    const { document, bodyId } = reference();
    const mixed = addPrimitiveFeature(document, {
      name: 'Exact box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const cut = booleanBodies(mixed, {
      name: 'Union mesh',
      operation: 'union',
      targetBodyIds: mixed.bodyOrder
    });
    const state = await adapter.syncDocument(cut.document);
    const refusal = state.featureWarnings?.find(
      (warning) => warning.kind === 'build-failed'
    );
    expect(refusal?.message).toContain('mesh reference');
    expect(state.bodyRepresentations[bodyId]!.consumed).toBe(false);
    expect(state.bodyRepresentations[mixed.bodyOrder[1]!]!.consumed).toBe(
      false
    );
  });

  it('keeps degenerate but readable source facets as a reference', async () => {
    const { document, bodyId } = importMeshBody(
      createProjectDocument('Degenerate mesh', user),
      {
        name: 'Collapsed facet',
        artifactId: 'artifact_degenerate',
        sourceName: 'collapsed.stl',
        triangleCount: 1,
        vertices: [0, 0, 0, 1, 0, 0, 2, 0, 0],
        indices: [0, 1, 2]
      }
    );
    const state = await adapter.syncDocument(document);
    expect(state.bodyRepresentations[bodyId]!.meshReference).toBe(true);
    const stl = await adapter.exportStl(document, [bodyId]);
    expect(
      parseStl(new TextEncoder().encode(stl).buffer, 'collapsed.stl')
        .triangleCount
    ).toBe(1);
  });

  it.skipIf(!process.env.OZ_PRIVATE_STL)(
    'imports a private STL through the complete document rebuild',
    async () => {
      const bytes = readFileSync(process.env.OZ_PRIVATE_STL!);
      const parsed = parseStl(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ),
        'private.stl'
      );
      const { document, bodyId } = importMeshBody(
        createProjectDocument('Private STL qualification', user),
        {
          ...parsed,
          name: 'Private mesh',
          sourceName: 'private.stl',
          artifactId: 'artifact_private'
        }
      );
      const state = await adapter.syncDocument(document);
      expect(state.bodyRepresentations[bodyId]).toBeDefined();
      expect(
        state.bodyRepresentations[bodyId]!.mesh.indices.length
      ).toBeGreaterThan(0);
      expect(
        state.featureWarnings?.filter((warning) => warning.kind !== 'advisory')
      ).toEqual([]);
    }
  );
});
