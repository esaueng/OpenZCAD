import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  listFeaturesInOrder,
  patternBody,
  setNodeMetadata,
  setParameter,
  transformBody,
  updateFeature,
  updateSketchObject
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * The one contract that makes the cache shippable: a sync served from a
 * restored prefix must produce the same derived state as an adapter that
 * has never seen the document before.
 *
 * Two exemptions. `updatedAt` is a timestamp. The display mesh's vertex and
 * index buffers are compared by triangle budget rather than by byte: a
 * replayed feature's solids occupy different kernel arena slots than a cold
 * build's, and the mesher may then split identical faces along different
 * diagonals. Everything that makes the meshes interchangeable IS pinned
 * bitwise below — face hashes, per-face `triangleStart`/`triangleCount`,
 * edge polylines, volume, bbox, and mass properties all still `toEqual`.
 */
function normalized(derived: DerivedState) {
  const { updatedAt: _updatedAt, ...rest } = derived;
  return {
    ...rest,
    bodyRepresentations: Object.fromEntries(
      Object.entries(rest.bodyRepresentations).map(([bodyId, body]) => [
        bodyId,
        {
          ...body,
          mesh: {
            kind: body.mesh.kind,
            triangles: body.mesh.indices.length / 3
          }
        }
      ])
    )
  };
}

async function freshDerived(document: ProjectDocument): Promise<DerivedState> {
  const fresh = await createExactKernelAdapter();
  try {
    return await fresh.syncDocument(document);
  } finally {
    fresh.dispose();
  }
}

/**
 * Five features exercising the state the cache must carry across a restore:
 * a primitive, a consuming transform, a sketch, an extrude reading that
 * sketch, and a pattern consuming the extrusion.
 */
function chainDocument() {
  let document = addPrimitiveFeature(
    createProjectDocument('Cache chain', toUserId('user_cache')),
    {
      name: 'Base',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    }
  );
  const baseBodyId = document.bodyOrder[0]!;
  const moved = transformBody(document, {
    name: 'Move',
    targetBodyId: baseBodyId,
    translation: { x: 5, y: 0, z: 0 }
  });
  document = moved.document;
  const sketch = addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [{ objectKind: 'circle', radius: 3, centerX: 40, centerY: 0 }]
  });
  document = sketch.document;
  const extrude = extrudeSketch(document, {
    name: 'Puck',
    sketchId: sketch.sketchId,
    distance: 4
  });
  document = extrude.document;
  const pattern = patternBody(document, {
    name: 'Row',
    targetBodyId: extrude.bodyId,
    patternKind: 'linear',
    count: 3,
    axis: 'y',
    spacing: 10
  });
  return {
    document: pattern.document,
    baseBodyId,
    sketchId: sketch.sketchId
  };
}

describe('incremental prefix rebuild cache', { timeout: 120_000 }, () => {
  it('restores the unchanged prefix and matches a from-scratch rebuild', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const { document } = chainDocument();
      const first = await adapter.syncDocument(document);
      expect(events.at(-1)).toEqual({
        kind: 'full-rebuild',
        replayed: 5,
        restored: 0
      });
      expect(normalized(first)).toEqual(normalized(await freshDerived(document)));

      // Editing the LAST feature restores everything before it.
      const patternFeature = listFeaturesInOrder(document).find(
        (feature) => feature.data.featureKind === 'pattern'
      )!;
      const editedTail = updateFeature(document, {
        featureId: patternFeature.featureId,
        data: { count: 4 }
      });
      const second = await adapter.syncDocument(editedTail);
      expect(events.at(-1)).toEqual({
        kind: 'prefix-restore',
        replayed: 1,
        restored: 4
      });
      expect(normalized(second)).toEqual(
        normalized(await freshDerived(editedTail))
      );

      // Editing a MID feature replays it and everything after it.
      const transformFeature = listFeaturesInOrder(editedTail).find(
        (feature) => feature.data.featureKind === 'transform'
      )!;
      const editedMid = updateFeature(editedTail, {
        featureId: transformFeature.featureId,
        data: {
          transform: {
            translation: { x: 7, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 }
          }
        }
      });
      const third = await adapter.syncDocument(editedMid);
      expect(events.at(-1)).toEqual({
        kind: 'prefix-restore',
        replayed: 4,
        restored: 1
      });
      expect(normalized(third)).toEqual(
        normalized(await freshDerived(editedMid))
      );

      // Editing the FIRST feature leaves no prefix to restore.
      const primitive = listFeaturesInOrder(editedMid).find(
        (feature) => feature.data.featureKind === 'primitive'
      )!;
      const editedHead = updateFeature(editedMid, {
        featureId: primitive.featureId,
        data: { dimensions: { width: 12, height: 10, depth: 10 } }
      });
      const fourth = await adapter.syncDocument(editedHead);
      expect(events.at(-1)).toEqual({
        kind: 'full-rebuild',
        replayed: 5,
        restored: 0
      });
      expect(normalized(fourth)).toEqual(
        normalized(await freshDerived(editedHead))
      );

      // An identical resync restores the whole history and only re-measures.
      const fifth = await adapter.syncDocument(editedHead);
      expect(events.at(-1)).toEqual({
        kind: 'prefix-restore',
        replayed: 0,
        restored: 5
      });
      expect(normalized(fifth)).toEqual(normalized(fourth));
    } finally {
      adapter.dispose();
    }
  });

  it('invalidates from the sketch feature when its objects change', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const { document, sketchId } = chainDocument();
      await adapter.syncDocument(document);

      // The sketch node is digested into the sketch feature AND the extrude
      // that reads it, so a radius edit replays sketch, extrude, and pattern
      // while the primitive and transform restore.
      const sketch = findSketch(document, sketchId)!;
      const edited = updateSketchObject(document, {
        sketchId,
        objectId: sketch.objectIds[0]!,
        data: { objectKind: 'circle', radius: 4, centerX: 40, centerY: 0 }
      });
      const derived = await adapter.syncDocument(edited);
      expect(events.at(-1)).toEqual({
        kind: 'prefix-restore',
        replayed: 3,
        restored: 2
      });
      expect(normalized(derived)).toEqual(
        normalized(await freshDerived(edited))
      );
    } finally {
      adapter.dispose();
    }
  });

  it('rebuilds from scratch when the parameter scope changes', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const { document } = chainDocument();
      await adapter.syncDocument(document);

      // No feature changed, but any expression may reference any parameter
      // by name, so the scope digest treats the table as global input.
      const withParam = setParameter(document, { name: 'w', expression: '12' });
      const derived = await adapter.syncDocument(withParam);
      expect(events.at(-1)).toEqual({
        kind: 'full-rebuild',
        replayed: 5,
        restored: 0
      });
      expect(normalized(derived)).toEqual(
        normalized(await freshDerived(withParam))
      );
    } finally {
      adapter.dispose();
    }
  });

  it('replays suppression and prefix failure warnings exactly once', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      // A failing pattern in the middle: its warning lives in the cached
      // prefix state, so a later edit must carry it through the restore
      // without duplicating it.
      let document = addPrimitiveFeature(
        createProjectDocument('Warning chain', toUserId('user_cache')),
        {
          name: 'Base',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        }
      );
      document = patternBody(document, {
        name: 'Too many',
        targetBodyId: document.bodyOrder[0]!,
        patternKind: 'linear',
        count: 500,
        axis: 'x',
        spacing: 20
      }).document;
      const tail = addPrimitiveFeature(document, {
        name: 'Tail',
        primitiveKind: 'box',
        dimensions: { width: 4, height: 4, depth: 4 }
      });
      document = tail;

      const first = await adapter.syncDocument(document);
      expect(
        first.warnings.filter((warning) =>
          warning.includes('between 2 and 100')
        )
      ).toHaveLength(1);

      const tailFeature = listFeaturesInOrder(document).at(-1)!;
      const edited = updateFeature(document, {
        featureId: tailFeature.featureId,
        data: { dimensions: { width: 5, height: 4, depth: 4 } }
      });
      const second = await adapter.syncDocument(edited);
      expect(events.at(-1)).toEqual({
        kind: 'prefix-restore',
        replayed: 1,
        restored: 2
      });
      expect(
        second.warnings.filter((warning) =>
          warning.includes('between 2 and 100')
        )
      ).toHaveLength(1);
      expect(normalized(second)).toEqual(
        normalized(await freshDerived(edited))
      );

      // Suppressing the tail changes its digest in place; the suppression
      // warning is emitted by the replay, not carried stale from the cache.
      const suppressed = setNodeMetadata(edited, {
        nodeId: tailFeature.id,
        metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: true }
      });
      const third = await adapter.syncDocument(suppressed);
      expect(events.at(-1)).toEqual({
        kind: 'prefix-restore',
        replayed: 1,
        restored: 2
      });
      expect(
        third.warnings.filter((warning) => warning.includes('Suppressed'))
      ).toHaveLength(1);
      expect(normalized(third)).toEqual(
        normalized(await freshDerived(suppressed))
      );
    } finally {
      adapter.dispose();
    }
  });

  it('bypasses caching above the checkpoint limit and stays correct', async () => {
    const events: RebuildCacheEvent[] = [];
    const adapter = await createExactKernelAdapter({
      historyCheckpointLimit: 2,
      onRebuildCacheEvent: (event) => events.push(event)
    });
    try {
      const { document } = chainDocument();
      const first = await adapter.syncDocument(document);
      const second = await adapter.syncDocument(document);
      expect(events).toEqual([
        { kind: 'full-rebuild', replayed: 5, restored: 0 },
        { kind: 'full-rebuild', replayed: 5, restored: 0 }
      ]);
      expect(normalized(second)).toEqual(normalized(first));
      expect(normalized(first)).toEqual(
        normalized(await freshDerived(document))
      );
    } finally {
      adapter.dispose();
    }
  });
});
