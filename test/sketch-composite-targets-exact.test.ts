import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  getLatestBodyId,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  createSketchCompositeCornerTarget,
  createSketchCompositeSideTarget,
  resolveSketchReferenceDimension,
  toUserId,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchId,
  type SketchObjectData
} from '@openzcad/shared';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';
import {
  compositeCommands,
  compositeMemberUpdates,
  cornerRectangleShape
} from '../apps/web/src/lib/sketch/composites';
import { sketchEntitiesEditCommands } from '../apps/web/src/lib/sketch/editing';
import { historyFeatureDigest } from '../packages/kernel-adapter/src/exact-history-cache';
import { resolveRegionProfiles } from '../packages/kernel-adapter/src/region-profile';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());

const scalar = (value: ParamValue) =>
  typeof value === 'number' ? value : Number(value);

function objects(document: ProjectDocument, sketchId: SketchId) {
  return new Map<EntityId, SketchObjectData>(
    findSketch(document, sketchId)!.objectIds.flatMap((id) => {
      const node = document.nodes[id];
      return node?.kind === 'sketch-object' ? [[id, node.data] as const] : [];
    })
  );
}

function region(document: ProjectDocument, sketchId: SketchId) {
  const regions = computeSketchRegions(
    [...objects(document, sketchId)].map(([id, data]) => ({ id, data })),
    scalar
  );
  expect(regions).toHaveLength(1);
  return regions[0]!;
}

function fixture() {
  const initial = createProjectDocument(
    'S04 exact targets',
    toUserId('user_test')
  );
  const manager = new CommandManager(initial);
  const shape = cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 });
  if (!shape) throw new Error('Rectangle fixture is degenerate.');
  const drawing = compositeCommands(shape, {
    kind: 'new-sketch',
    name: 'Held rectangle',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 }
  });
  manager.execute(composeCommands(drawing.label, drawing.commands));
  const { sketchId } = drawing;
  const source = region(manager.document, sketchId);
  // Use a selected-region reference, not the more permissive all-entities
  // form: resizing must invalidate its geometric fields and retain identity.
  const profile = {
    profileId: source.profileId,
    regionFingerprint: source.regionFingerprint,
    sourceArea: source.area,
    samplePoint: source.samplePoint,
    sourceEntityIds: [...source.sourceEntityIds]
  };
  manager.execute(
    commandFactories.extrudeSketch({
      name: 'Plate',
      sketchId,
      distance: 5,
      operation: 'new-body',
      profile
    })
  );
  const bodyId = getLatestBodyId(manager.document)!;
  const composite = findSketch(manager.document, sketchId)!.composites![0]!;
  return { initial, manager, sketchId, bodyId, composite, profile };
}

function addReferences(f: ReturnType<typeof fixture>) {
  const width = commandFactories.addSketchReferenceDimension({
    sketchId: f.sketchId,
    data: {
      dimensionKind: 'distance',
      distanceMode: 'horizontal',
      a: createSketchCompositeCornerTarget(f.composite, 0),
      b: createSketchCompositeCornerTarget(f.composite, 1)
    }
  });
  const angle = commandFactories.addSketchReferenceDimension({
    sketchId: f.sketchId,
    data: {
      dimensionKind: 'angle',
      a: createSketchCompositeSideTarget(f.composite, 0),
      b: createSketchCompositeSideTarget(f.composite, 1)
    }
  });
  f.manager.execute(composeCommands('Measure held rectangle', [width, angle]));
}

function expectReferences(
  document: ProjectDocument,
  sketchId: SketchId,
  width: number
) {
  const sketch = findSketch(document, sketchId)!;
  expect(sketch.referenceDimensions).toHaveLength(2);
  const measured = sketch.referenceDimensions!.map((reference) =>
    resolveSketchReferenceDimension(
      objects(document, sketchId),
      reference,
      scalar,
      sketch.composites
    )
  );
  expect(measured).toMatchObject([
    { status: 'current', dimensionKind: 'distance', value: width },
    { status: 'current', dimensionKind: 'angle', valueDeg: 90 }
  ]);
}

async function backup(document: ProjectDocument) {
  return (
    await parseProjectBackup(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: [],
        sources: [],
        saveStates: []
      })
    )
  ).document;
}

describe('S04 named composite targets on the exact kernel', () => {
  it('keeps named corner/side annotations out of GCS and exact geometry/cache inputs', async () => {
    const f = fixture();
    const before = f.manager.document;
    const solveBefore = await adapter.solveSketch(before, f.sketchId);
    const solidBefore = await adapter.syncDocument(before);
    addReferences(f);
    const annotation = findSketch(f.manager.document, f.sketchId)!
      .referenceDimensions![0]!;
    f.manager.execute(
      commandFactories.setSketchReferenceLabelPosition({
        sketchId: f.sketchId,
        annotationId: annotation.annotationId,
        position: { x: 3, y: -4 }
      })
    );
    const reopened = await backup(f.manager.document);
    expectReferences(reopened, f.sketchId, 20);
    expect(findSketch(reopened, f.sketchId)).toEqual(
      findSketch(f.manager.document, f.sketchId)
    );
    expect(await adapter.solveSketch(reopened, f.sketchId)).toEqual(
      solveBefore
    );
    for (const [index, feature] of listFeaturesInOrder(before).entries()) {
      expect(historyFeatureDigest(reopened, feature, index)).toBe(
        historyFeatureDigest(before, feature, index)
      );
    }
    const solidAfter = await adapter.syncDocument(reopened);
    expect(solidAfter.warnings).toEqual([]);
    // Closed-form oracle: a 20 × 12 rectangle extruded 5 has volume 1200.
    expect(solidAfter.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(
      1200,
      8
    );
    expect(solidAfter.bodyRepresentations[f.bodyId]!.bbox).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 20, y: 12, z: 5 }
    });
    expect(solidAfter.bodyRepresentations[f.bodyId]!.volume).toBe(
      solidBefore.bodyRepresentations[f.bodyId]!.volume
    );
  });

  it('retains the selected region and named targets through solved resize, undo, replay and backup', async () => {
    const f = fixture();
    addReferences(f);
    const before = f.manager.document;
    const originalRegion = region(before, f.sketchId);
    const originalReferences = structuredClone(
      findSketch(before, f.sketchId)!.referenceDimensions
    );
    const commands = await sketchEntitiesEditCommands(
      before,
      f.sketchId,
      compositeMemberUpdates(
        f.composite,
        [
          { x: 0, y: 0 },
          { x: 30, y: 0 },
          { x: 30, y: 12 },
          { x: 0, y: 12 }
        ],
        objects(before, f.sketchId)
      ),
      (document, sketchId) => adapter.solveSketch(document, sketchId),
      'Widen held rectangle'
    );
    f.manager.execute(composeCommands('Widen held rectangle', commands));
    const resized = f.manager.document;
    const changedRegion = region(resized, f.sketchId);
    expect(changedRegion.area).toBeCloseTo(360, 9);
    expect(changedRegion.regionFingerprint).not.toBe(
      originalRegion.regionFingerprint
    );
    expect(changedRegion.profileId).not.toBe(originalRegion.profileId);
    expect(changedRegion.sourceEntityIds).toEqual(
      originalRegion.sourceEntityIds
    );
    const resolved = resolveRegionProfiles(
      resized,
      findSketch(resized, f.sketchId)!,
      { profile: f.profile },
      {}
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.area).toBeCloseTo(360, 9);
    expect(findSketch(resized, f.sketchId)!.referenceDimensions).toEqual(
      originalReferences
    );
    expectReferences(resized, f.sketchId, 30);

    f.manager.undo();
    expectReferences(f.manager.document, f.sketchId, 20);
    const undone = await adapter.syncDocument(f.manager.document);
    expect(undone.warnings).toEqual([]);
    expect(undone.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(1200, 8);
    const originalFaceNames = undone.bodyRepresentations[
      f.bodyId
    ]!.topology!.faces.map((face) => face.reference?.lineageName).sort();
    expect(originalFaceNames).toHaveLength(6);
    expect(originalFaceNames.every((name) => typeof name === 'string')).toBe(
      true
    );
    expect(new Set(originalFaceNames).size).toBe(6);
    f.manager.redo();
    const replayed = replayCommands(f.initial, f.manager.document.commandLog);
    const reopened = await backup(replayed);
    expectReferences(reopened, f.sketchId, 30);
    expect(findSketch(reopened, f.sketchId)!.composites).toEqual([f.composite]);
    expect(findSketch(reopened, f.sketchId)!.referenceDimensions).toEqual(
      originalReferences
    );
    const rebuilt = await adapter.syncDocument(reopened);
    expect(rebuilt.warnings).toEqual([]);
    // The same feature now builds 30 × 12 × 5, with no profile retargeting.
    expect(rebuilt.bodyRepresentations[f.bodyId]!.volume).toBeCloseTo(1800, 8);
    expect(
      rebuilt.bodyRepresentations[f.bodyId]!.topology!.faces.map(
        (face) => face.reference?.lineageName
      ).sort()
    ).toEqual(originalFaceNames);
    expect(rebuilt.bodyRepresentations[f.bodyId]!.bbox).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 30, y: 12, z: 5 }
    });
  });

  it('protects every captured side until named annotations are explicitly removed, then restores identities on undo', () => {
    const f = fixture();
    addReferences(f);
    const before = f.manager.document;
    const annotations = findSketch(before, f.sketchId)!.referenceDimensions!;
    // Side 3 is not either angle operand or either measured corner's alias.
    // Removing it would still dissolve the shape the named targets identify.
    const objectId = f.composite.edgeIds[2]!;
    expect(() =>
      f.manager.execute(
        commandFactories.deleteSketchObject({ sketchId: f.sketchId, objectId })
      )
    ).toThrow(/Delete the reference dimensions first/);
    expect(f.manager.document).toBe(before);
    f.manager.execute(
      composeCommands(
        'Remove named measurements',
        annotations.map(({ annotationId }) =>
          commandFactories.deleteSketchReferenceDimension({
            sketchId: f.sketchId,
            annotationId
          })
        )
      )
    );
    f.manager.execute(
      commandFactories.deleteSketchObject({ sketchId: f.sketchId, objectId })
    );
    expect(
      findSketch(f.manager.document, f.sketchId)!.composites
    ).toBeUndefined();
    expect(f.manager.document.nodes[objectId]).toBeUndefined();
    f.manager.undo();
    f.manager.undo();
    expect(findSketch(f.manager.document, f.sketchId)).toEqual(
      findSketch(before, f.sketchId)
    );
    expectReferences(f.manager.document, f.sketchId, 20);
    expect(f.manager.document.nodes[objectId]).toEqual(before.nodes[objectId]);
  });
});
