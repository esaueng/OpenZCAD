import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  composeCommands,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  listFeaturesInOrder,
  normalizeDocument,
  objectFolderOfBody
} from '@openzcad/document-core';
import { computeSketchRegions, frameForPlaneRef } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  createSketchCompositeCornerTarget,
  createSketchCompositeSideTarget,
  resolveSketchReferenceDimension,
  toArtifactId,
  toAssetId,
  toUserId,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type ProjectDocument,
  type ReferenceImageId,
  type SketchId,
  type SketchPointRef
} from '@openzcad/shared';
import {
  backupFileBytes,
  checksum,
  packBackupFile,
  parseProjectBackup
} from '../apps/web/src/lib/projectBackup';
import {
  projectionFromPick,
  projectionWriteBackCommand
} from '../apps/web/src/lib/sketch/projection';
import { historyFeatureDigest } from '../packages/kernel-adapter/src/exact-history-cache';
import {
  compositeCommands,
  compositeMemberUpdates,
  cornerRectangleShape
} from '../apps/web/src/lib/sketch/composites';
import { sketchEntitiesEditCommands } from '../apps/web/src/lib/sketch/editing';

const owner = toUserId('user_schema_retention');
const sheetId = 'dsht_composite_folders' as DrawingSheetId;
const noteId = 'dann_composite_folders' as DrawingAnnotationId;
const imageId = 'rimg_composite_folders' as ReferenceImageId;
const artifactId = toArtifactId('artifact_composite_folders_png');
const assetId = toAssetId('asset_composite_folders_thumbnail');
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxoAAAAASUVORK5CYII='
  ),
  (character) => character.charCodeAt(0)
);
const above = { type: 'canonical', plane: 'XY', offset: 8 } as const;

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());

function pointAt(
  document: ProjectDocument,
  sketchId: SketchId,
  x: number,
  y: number
): SketchPointRef {
  // Pick real projected line endpoints once. Resizes retain these references;
  // no later coordinate search or target substitution can hide an ID change.
  for (const objectId of findSketch(document, sketchId)!.objectIds) {
    const node = document.nodes[objectId]!;
    if (node.kind !== 'sketch-object' || node.data.objectKind !== 'line')
      continue;
    if (node.data.x1 === x && node.data.y1 === y)
      return { objectId, point: 'start' };
    if (node.data.x2 === x && node.data.y2 === y)
      return { objectId, point: 'end' };
  }
  throw new Error(`Missing projected corner (${x}, ${y})`);
}

function projectionSources(document: ProjectDocument, sketchId: SketchId) {
  return findSketch(document, sketchId)!.objectIds.flatMap((id) => {
    const node = document.nodes[id]!;
    if (node.kind !== 'sketch-object') throw new Error('Missing sketch object');
    return node.data.projection ? [node.data.projection] : [];
  });
}

function sketchObjects(document: ProjectDocument, sketchId: SketchId) {
  const sketch = findSketch(document, sketchId)!;
  return new Map(
    sketch.objectIds.map((id) => {
      const node = document.nodes[id]!;
      if (node.kind !== 'sketch-object') throw new Error('Missing line');
      return [id, node.data] as const;
    })
  );
}

function expectMeasurements(
  document: ProjectDocument,
  sketchId: SketchId,
  width: number,
  right: number
) {
  const sketch = findSketch(document, sketchId)!;
  const measured = sketch.referenceDimensions!.map((reference) =>
    resolveSketchReferenceDimension(
      sketchObjects(document, sketchId),
      reference,
      (value) => (typeof value === 'number' ? value : undefined),
      sketch.composites
    )
  );
  expect(measured).toHaveLength(9);
  for (const [index, value] of [
    Math.hypot(width, 10),
    Math.hypot(width, 10),
    width,
    10,
    Math.hypot(right - width, 10),
    right - width,
    10,
    right - 40
  ].entries()) {
    const outcome = measured[index]!;
    expect(outcome.status).toBe('current');
    if (outcome.status !== 'current') throw new Error(outcome.reason);
    if (outcome.dimensionKind !== 'distance')
      throw new Error('Expected a reference distance');
    expect(outcome.value).toBeCloseTo(value, 10);
  }
  expect(measured[8]).toMatchObject({
    status: 'current',
    dimensionKind: 'angle',
    valueDeg: 90
  });
}

async function fixture() {
  const sum = await checksum(png);
  const initial = createProjectDocument('Composite targets and folders', owner);
  initial.assets[assetId] = {
    assetId,
    artifactId,
    kind: 'thumbnail',
    name: 'Retained thumbnail.png',
    contentType: 'image/png',
    bytes: png.length,
    checksum: sum,
    storage: 'remote',
    createdAt: new Date(0).toISOString()
  };
  const manager = new CommandManager(initial);
  manager.execute(
    commandFactories.setParameter({ name: 'w', expression: '20' })
  );
  const source = commandFactories.addPrimitive({
    name: 'Reference block',
    primitiveKind: 'box',
    dimensions: { width: 'w', height: 10, depth: 5 }
  });
  manager.execute(source);
  const sourceId = source.payload.ids!.bodyId;
  const sheet: DrawingSheet = {
    sheetId,
    name: 'Retained drawing',
    paper: { size: 'A4', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 2 },
    projectionAngle: 'third',
    titleBlock: { title: 'Reference block' },
    source: { fingerprint: 'v1:composite-folders-fixture' },
    views: [
      {
        viewId: 'dvw_composite_folders_top' as DrawingViewId,
        orientation: 'top',
        bodyIds: [sourceId],
        centerMm: { x: 120, y: 90 },
        hiddenLines: false
      }
    ],
    annotations: [
      {
        annotationId: noteId,
        kind: 'note',
        text: 'BREAK EDGES',
        placementMm: { x: 10, y: 15 }
      }
    ]
  };
  manager.execute(commandFactories.addDrawingSheet({ sheet }));
  manager.execute(
    commandFactories.updateDrawingAnnotation({
      sheetId,
      annotation: {
        annotationId: noteId,
        kind: 'note',
        text: 'BREAK ALL SHARP EDGES',
        placementMm: { x: 14, y: 18 }
      }
    })
  );
  manager.execute(
    commandFactories.addReferenceImage({
      image: {
        imageId,
        artifactId,
        name: 'Retained picture',
        contentType: 'image/png',
        pixelWidth: 1,
        pixelHeight: 1,
        source: {
          marker: 'openzcad-source-ref',
          version: 1,
          hashAlgorithm: 'sha256',
          checksumSha256: sum,
          logicalBytes: png.length
        },
        plane: { type: 'canonical', plane: 'XZ', offset: 7, basisRevision: 2 },
        center: { u: 11, v: -13 },
        rotationDeg: -90,
        width: 42,
        opacity: 0.35
      }
    })
  );
  manager.execute(
    commandFactories.updateReferenceImage({
      imageId,
      center: { u: 17, v: -19 },
      width: 54
    })
  );
  const measured = await adapter.syncDocument(manager.document);
  expect(measured.warnings).toEqual([]);
  const top = measured.bodyRepresentations[sourceId]!.topology!.faces.find(
    (face) => (face.geometry?.normal?.z ?? 0) > 0.99
  )!;
  const picked = projectionFromPick({
    document: { ...manager.document, derived: measured },
    sketch: null,
    selection: { kind: 'face', bodyId: sourceId, hash: top.hash },
    basis: frameForPlaneRef(above, Number),
    mode: 'linked',
    construction: false
  });
  expect(picked.skipped).toEqual([]);
  expect(picked.objects).toHaveLength(4);
  const outline = commandFactories.addSketch({
    name: 'Linked outline',
    planeRef: above,
    objects: picked.objects
  });
  manager.execute(outline);
  const sketchId = outline.payload.ids!.sketchId;
  const objectIds = [...findSketch(manager.document, sketchId)!.objectIds];
  const a = pointAt(manager.document, sketchId, 0, 0);
  const b = pointAt(manager.document, sketchId, 20, 10);
  manager.execute(
    commandFactories.addSketchReferenceDimension({
      sketchId,
      data: { dimensionKind: 'distance', a, b }
    })
  );
  manager.runTransaction(
    'Measure linked corners',
    (['absolute', 'horizontal', 'vertical'] as const).map((distanceMode) =>
      commandFactories.addSketchReferenceDimension({
        sketchId,
        data: { dimensionKind: 'distance', distanceMode, a, b }
      })
    )
  );
  const regions = computeSketchRegions(
    [...sketchObjects(manager.document, sketchId)].map(([id, data]) => ({
      id,
      data
    })),
    Number
  );
  expect(regions).toHaveLength(1);
  const region = regions[0]!;
  expect(region.area).toBeCloseTo(200, 9);
  const plate = commandFactories.extrudeSketch({
    name: 'Linked plate',
    sketchId,
    distance: 3,
    profile: {
      profileId: region.profileId,
      regionFingerprint: region.regionFingerprint,
      sourceArea: region.area,
      samplePoint: region.samplePoint,
      sourceEntityIds: [...region.sourceEntityIds]
    }
  });
  manager.execute(plate);
  const plateId = plate.payload.ids!.bodyId;
  manager.execute(
    commandFactories.createObjectFolder({
      folderId: 'folder_assembly',
      name: 'Assembly',
      parentId: null,
      bodyIds: [sourceId, plateId]
    })
  );
  manager.execute(
    commandFactories.createObjectFolder({
      folderId: 'folder_detail',
      name: 'Details',
      parentId: 'folder_assembly'
    })
  );
  manager.execute(
    commandFactories.renameObjectFolder({
      folderId: 'folder_assembly',
      name: 'Retained assembly'
    })
  );
  manager.execute(
    commandFactories.moveToObjectFolder({
      parentId: 'folder_detail',
      bodyIds: [plateId]
    })
  );
  manager.execute(
    commandFactories.deleteObjectFolder({ folderId: 'folder_detail' })
  );
  expect(objectFolderOfBody(manager.document, plateId)).toBe('folder_assembly');
  manager.undo();
  expect(objectFolderOfBody(manager.document, plateId)).toBe('folder_detail');
  manager.redo();
  const saved = structuredClone(manager.document);
  saved.schemaVersion = 35 as ProjectDocument['schemaVersion'];
  return { initial, saved, sketchId, sourceId, plateId, objectIds, a, b, sum };
}

async function backup(document: ProjectDocument, sum: string) {
  return parseProjectBackup(
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document,
      files: [
        await packBackupFile(
          {
            artifactId,
            projectId: document.projectId,
            kind: 'reference-image',
            name: 'Retained picture.png',
            objectKey: 'retained/composite-folders.png',
            contentType: 'image/png',
            createdAt: new Date(0).toISOString(),
            metadata: {}
          },
          new Uint8Array(png).buffer
        )
      ],
      sources: [
        {
          sha256: sum,
          logicalBytes: png.length,
          base64: btoa(String.fromCharCode(...png))
        }
      ]
    })
  );
}

it('keeps named boundary targets on linked geometry through source edits, solved composite reshape, undo, replay and native backup', async () => {
  const f = await fixture();
  const original = structuredClone(f.saved);
  const opened = normalizeDocument(structuredClone(f.saved));
  expect(opened).toEqual({
    ...original,
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION
  });
  expect(f.saved).toEqual(original);
  const manager = new CommandManager(opened);
  const sources = structuredClone(projectionSources(opened, f.sketchId));
  expect(sources).toHaveLength(4);
  const shape = cornerRectangleShape({ x: 40, y: 0 }, { x: 60, y: 12 });
  if (!shape) throw new Error('Held rectangle fixture is degenerate');
  const drawing = compositeCommands(shape, {
    kind: 'sketch',
    sketchId: f.sketchId
  });
  manager.execute(composeCommands(drawing.label, drawing.commands));
  const composite = findSketch(manager.document, f.sketchId)!.composites![0]!;
  const selected = computeSketchRegions(
    [...sketchObjects(manager.document, f.sketchId)].map(([id, data]) => ({
      id,
      data
    })),
    Number
  ).filter((region) => region.sourceEntityIds.includes(composite.edgeIds[0]!));
  expect(selected).toHaveLength(1);
  const region = selected[0]!;
  expect(region.area).toBeCloseTo(240, 9);
  const pad = commandFactories.extrudeSketch({
    name: 'Held rectangle pad',
    sketchId: f.sketchId,
    distance: 5,
    profile: {
      profileId: region.profileId,
      regionFingerprint: region.regionFingerprint,
      sourceArea: region.area,
      samplePoint: region.samplePoint,
      sourceEntityIds: [...region.sourceEntityIds]
    }
  });
  manager.execute(pad);
  const padId = pad.payload.ids!.bodyId;
  manager.execute(
    commandFactories.moveToObjectFolder({
      parentId: 'folder_assembly',
      bodyIds: [padId]
    })
  );
  const unannotated = structuredClone(manager.document);
  const solveBefore = await adapter.solveSketch(unannotated, f.sketchId);
  const before = await adapter.syncDocument(unannotated);
  expect(before.warnings).toEqual([]);
  expect(before.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(600, 8);
  expect(before.bodyRepresentations[padId]!.volume).toBeCloseTo(1200, 8);
  const corner = createSketchCompositeCornerTarget(composite, 1);
  const sideA = createSketchCompositeSideTarget(composite, 0);
  const sideB = createSketchCompositeSideTarget(composite, 1);
  const commands = [
    ...(['absolute', 'horizontal', 'vertical'] as const).map((distanceMode) =>
      commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: { dimensionKind: 'distance', distanceMode, a: f.b, b: corner }
      })
    ),
    commandFactories.addSketchReferenceDimension({
      sketchId: f.sketchId,
      data: {
        dimensionKind: 'distance',
        distanceMode: 'horizontal',
        a: createSketchCompositeCornerTarget(composite, 0),
        b: corner
      }
    }),
    commandFactories.addSketchReferenceDimension({
      sketchId: f.sketchId,
      data: { dimensionKind: 'angle', a: sideA, b: sideB }
    })
  ];
  manager.runTransaction('Measure projected edge to held boundaries', [
    ...commands,
    ...commands.map((command, index) =>
      commandFactories.setSketchReferenceLabelPosition({
        sketchId: f.sketchId,
        annotationId: command.payload.ids!.annotationId,
        position: { x: 23 + index, y: 13 + index }
      })
    )
  ]);
  const annotated = structuredClone(manager.document);
  const sketch = findSketch(annotated, f.sketchId)!;
  const references = structuredClone(sketch.referenceDimensions);
  const labels = structuredClone(sketch.dimensionLabelPositions);
  const objectIds = [...sketch.objectIds];
  const folders = structuredClone(annotated.objectFolders);
  expect(references![0]!.data).not.toHaveProperty('distanceMode');
  expect(references!.slice(0, 4)).toEqual(
    findSketch(opened, f.sketchId)!.referenceDimensions
  );
  expect(corner.topology).toEqual({
    version: 1,
    edgeIds: composite.edgeIds,
    helperIds: []
  });
  expectMeasurements(annotated, f.sketchId, 20, 60);
  expect(sketch.constraints).toEqual(
    findSketch(unannotated, f.sketchId)!.constraints
  );
  expect(Object.keys(annotated.nodes)).toEqual(Object.keys(unannotated.nodes));
  for (const id of objectIds)
    expect(annotated.nodes[id]).toEqual(unannotated.nodes[id]);
  for (const [index, feature] of listFeaturesInOrder(unannotated).entries())
    expect(historyFeatureDigest(annotated, feature, index)).toBe(
      historyFeatureDigest(unannotated, feature, index)
    );
  expect(await adapter.solveSketch(annotated, f.sketchId)).toEqual(solveBefore);
  const afterAnnotations = await adapter.syncDocument(annotated);
  expect(afterAnnotations.warnings).toEqual([]);
  for (const bodyId of [f.plateId, padId]) {
    expect(afterAnnotations.bodyRepresentations[bodyId]!.volume).toBe(
      before.bodyRepresentations[bodyId]!.volume
    );
    expect(afterAnnotations.bodyRepresentations[bodyId]!.bbox).toEqual(
      before.bodyRepresentations[bodyId]!.bbox
    );
  }
  expect(annotated.editHistory!.entries.slice(0, -1)).toEqual(
    unannotated.editHistory!.entries
  );
  const faceNames = before.bodyRepresentations[padId]!.topology!.faces.map(
    (face) => face.reference?.lineageName
  ).sort();
  expect(faceNames).toHaveLength(6);
  expect(faceNames.every((name) => typeof name === 'string')).toBe(true);
  manager.undo();
  expect(findSketch(manager.document, f.sketchId)).toEqual(
    findSketch(unannotated, f.sketchId)
  );
  manager.redo();

  const retained = (document: ProjectDocument) => {
    expect(document.objectFolders).toEqual(folders);
    for (const id of [f.sourceId, f.plateId, padId])
      expect(objectFolderOfBody(document, id)).toBe('folder_assembly');
    expect(document.drawings).toEqual(opened.drawings);
    expect(document.referenceImages).toEqual(opened.referenceImages);
    expect(document.assets).toEqual(opened.assets);
    const current = findSketch(document, f.sketchId)!;
    expect(current.objectIds).toEqual(objectIds);
    expect(current.composites).toEqual([composite]);
    expect(current.referenceDimensions).toEqual(references);
    expect(current.dimensionLabelPositions).toEqual(labels);
    expect(projectionSources(document, f.sketchId)).toEqual(sources);
    // The selected pad boundary remains the same ordered authored members.
    expect(document.nodes[pad.payload.ids!.featureNodeId]).toEqual(
      annotated.nodes[pad.payload.ids!.featureNodeId]
    );
  };
  const priorEntries = structuredClone(manager.document.editHistory!.entries);
  manager.execute(
    commandFactories.setParameter({ name: 'w', expression: '32' })
  );
  const sourceResized = await adapter.syncDocument(manager.document);
  expect(sourceResized.warnings).toEqual([]);
  expect(sourceResized.bodyRepresentations[f.sourceId]!.volume).toBeCloseTo(
    1600,
    8
  );
  expect(sourceResized.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(
    960,
    8
  );
  expect(sourceResized.bodyRepresentations[padId]!.volume).toBeCloseTo(1200, 8);
  const writeBack = projectionWriteBackCommand(manager.document, sourceResized);
  expect(writeBack).not.toBeNull();
  manager.normalize(writeBack!);
  expect(manager.document.editHistory!.entries.slice(0, -1)).toEqual(
    priorEntries
  );
  retained(manager.document);
  expectMeasurements(manager.document, f.sketchId, 32, 60);
  const projectedIds = new Map(
    f.objectIds.map((id) => [id, structuredClone(manager.document.nodes[id])])
  );
  const commandsToReshape = await sketchEntitiesEditCommands(
    manager.document,
    f.sketchId,
    compositeMemberUpdates(
      composite,
      [
        { x: 40, y: 0 },
        { x: 70, y: 0 },
        { x: 70, y: 12 },
        { x: 40, y: 12 }
      ],
      sketchObjects(manager.document, f.sketchId)
    ),
    (document, sketchId) => adapter.solveSketch(document, sketchId),
    'Widen held rectangle'
  );
  manager.execute(composeCommands('Widen held rectangle', commandsToReshape));
  retained(manager.document);
  expectMeasurements(manager.document, f.sketchId, 32, 70);
  for (const [id, node] of projectedIds)
    expect(manager.document.nodes[id]).toEqual(node);
  expect(
    manager.document.editHistory!.entries.slice(
      0,
      opened.editHistory!.entries.length
    )
  ).toEqual(opened.editHistory!.entries);
  const reshaped = await adapter.syncDocument(manager.document);
  expect(reshaped.warnings).toEqual([]);
  expect(reshaped.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(960, 8);
  expect(reshaped.bodyRepresentations[padId]!.volume).toBeCloseTo(1800, 8);
  expect(reshaped.bodyRepresentations[padId]!.bbox).toEqual({
    min: { x: 40, y: 0, z: 8 },
    max: { x: 70, y: 12, z: 13 }
  });
  expect(
    reshaped.bodyRepresentations[padId]!.topology!.faces.map(
      (face) => face.reference?.lineageName
    ).sort()
  ).toEqual(faceNames);
  expect(
    Object.values(reshaped.sketchProjections ?? {}).every(
      (state) => state.status === 'current'
    )
  ).toBe(true);
  manager.undo();
  retained(manager.document);
  expectMeasurements(manager.document, f.sketchId, 32, 60);
  const undone = await adapter.syncDocument(manager.document);
  expect(undone.warnings).toEqual([]);
  expect(undone.bodyRepresentations[padId]!.volume).toBeCloseTo(1200, 8);
  manager.undo();
  retained(manager.document);
  expectMeasurements(manager.document, f.sketchId, 20, 60);
  const sourceUndone = await adapter.syncDocument(manager.document);
  expect(sourceUndone.warnings).toEqual([]);
  expect(sourceUndone.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(
    600,
    8
  );
  const archived = await backup(manager.document, f.sum);
  expect(backupFileBytes(archived.files[0]!)).toEqual(png);
  expect(archived.sources).toEqual([
    {
      sha256: f.sum,
      logicalBytes: png.length,
      base64: btoa(String.fromCharCode(...png))
    }
  ]);
  const resumed = new CommandManager(normalizeDocument(archived.document));
  retained(resumed.document);
  expectMeasurements(resumed.document, f.sketchId, 20, 60);
  expect(resumed.canRedo).toBe(true);
  resumed.redo();
  retained(resumed.document);
  expectMeasurements(resumed.document, f.sketchId, 32, 60);
  resumed.redo();
  retained(resumed.document);
  expectMeasurements(resumed.document, f.sketchId, 32, 70);
  const replayed = replayCommands(f.initial, resumed.document.commandLog);
  expect(replayed.nodes).toEqual(resumed.document.nodes);
  retained(replayed);
  expectMeasurements(replayed, f.sketchId, 32, 70);
  for (const document of [resumed.document, replayed]) {
    const rebuilt = await adapter.syncDocument(document);
    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(960, 8);
    expect(rebuilt.bodyRepresentations[padId]!.volume).toBeCloseTo(1800, 8);
    expect(rebuilt.bodyRepresentations[padId]!.bbox).toEqual(
      reshaped.bodyRepresentations[padId]!.bbox
    );
  }
});
