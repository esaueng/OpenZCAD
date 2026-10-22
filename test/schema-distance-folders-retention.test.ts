import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createProjectDocument,
  findSketch,
  listFeaturesInOrder,
  normalizeDocument,
  objectFolderOfBody
} from '@openzcad/document-core';
import { frameForPlaneRef } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
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

const owner = toUserId('user_schema_retention');
const sheetId = 'dsht_distance_folders' as DrawingSheetId;
const noteId = 'dann_distance_folders' as DrawingAnnotationId;
const imageId = 'rimg_distance_folders' as ReferenceImageId;
const artifactId = toArtifactId('artifact_distance_folders_png');
const assetId = toAssetId('asset_distance_folders_thumbnail');
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
  return findSketch(document, sketchId)!.objectIds.map((id) => {
    const node = document.nodes[id]!;
    if (node.kind !== 'sketch-object' || !node.data.projection)
      throw new Error('Missing authored projection');
    return node.data.projection;
  });
}

function expectDistances(
  document: ProjectDocument,
  sketchId: SketchId,
  width: number
) {
  const sketch = findSketch(document, sketchId)!;
  const objects = new Map(
    sketch.objectIds.map((id) => {
      const node = document.nodes[id]!;
      if (node.kind !== 'sketch-object') throw new Error('Missing line');
      return [id, node.data] as const;
    })
  );
  const measured = sketch.referenceDimensions!.map((reference) =>
    resolveSketchReferenceDimension(objects, reference, (value) =>
      typeof value === 'number' ? value : undefined
    )
  );
  expect(measured).toHaveLength(4);
  for (const [index, value] of [
    Math.hypot(width, 10),
    Math.hypot(width, 10),
    width,
    10
  ].entries()) {
    const outcome = measured[index]!;
    expect(outcome.status).toBe('current');
    if (outcome.status !== 'current') throw new Error(outcome.reason);
    if (outcome.dimensionKind !== 'distance')
      throw new Error('Expected a reference distance');
    expect(outcome.value).toBeCloseTo(value, 10);
  }
}

async function fixture() {
  const sum = await checksum(png);
  const initial = createProjectDocument('Distance and folders', owner);
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
    source: { fingerprint: 'v1:distance-folders-fixture' },
    views: [
      {
        viewId: 'dvw_distance_folders_top' as DrawingViewId,
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
  const plate = commandFactories.extrudeSketch({
    name: 'Linked plate',
    sketchId,
    distance: 3,
    profiles: [{ all: true, sourceEntityIds: objectIds }]
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
  saved.schemaVersion = 34 as ProjectDocument['schemaVersion'];
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
            objectKey: 'retained/distance-folders.png',
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

it('retains real v31–34 content while reference modes follow a linked source resize without driving exact geometry', async () => {
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
  const folders = structuredClone(opened.objectFolders);
  const solveBefore = await adapter.solveSketch(opened, f.sketchId);
  const before = await adapter.syncDocument(opened);
  expect(before.warnings).toEqual([]);
  expect(before.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(600, 8);
  const commands = (['absolute', 'horizontal', 'vertical'] as const).map(
    (distanceMode) =>
      commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: { dimensionKind: 'distance', distanceMode, a: f.a, b: f.b }
      })
  );
  manager.runTransaction('Annotate linked corner distances', [
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
  expect(references![0]!.data).not.toHaveProperty('distanceMode');
  expect(references![0]).toEqual(
    findSketch(opened, f.sketchId)!.referenceDimensions![0]
  );
  expectDistances(annotated, f.sketchId, 20);
  expect(sketch.objectIds).toEqual(f.objectIds);
  expect(sketch.constraints).toEqual(
    findSketch(opened, f.sketchId)!.constraints
  );
  for (const id of f.objectIds)
    expect(annotated.nodes[id]).toEqual(opened.nodes[id]);
  expect(Object.keys(annotated.nodes)).toEqual(Object.keys(opened.nodes));
  for (const [index, feature] of listFeaturesInOrder(opened).entries())
    expect(historyFeatureDigest(annotated, feature, index)).toBe(
      historyFeatureDigest(opened, feature, index)
    );
  expect(await adapter.solveSketch(annotated, f.sketchId)).toEqual(solveBefore);
  const afterAnnotations = await adapter.syncDocument(annotated);
  expect(afterAnnotations.warnings).toEqual([]);
  expect(afterAnnotations.bodyRepresentations[f.plateId]!.volume).toBe(
    before.bodyRepresentations[f.plateId]!.volume
  );
  expect(afterAnnotations.bodyRepresentations[f.plateId]!.bbox).toEqual(
    before.bodyRepresentations[f.plateId]!.bbox
  );
  expect(annotated.editHistory!.entries.slice(0, -1)).toEqual(
    opened.editHistory!.entries
  );
  manager.undo();
  expect(findSketch(manager.document, f.sketchId)).toEqual(
    findSketch(opened, f.sketchId)
  );
  manager.redo();
  expectDistances(manager.document, f.sketchId, 20);

  const retained = (document: ProjectDocument) => {
    expect(document.objectFolders).toEqual(folders);
    expect(objectFolderOfBody(document, f.sourceId)).toBe('folder_assembly');
    expect(objectFolderOfBody(document, f.plateId)).toBe('folder_assembly');
    expect(document.drawings).toEqual(opened.drawings);
    expect(document.referenceImages).toEqual(opened.referenceImages);
    expect(document.assets).toEqual(opened.assets);
    const current = findSketch(document, f.sketchId)!;
    expect(current.objectIds).toEqual(f.objectIds);
    expect(current.referenceDimensions).toEqual(references);
    expect(current.dimensionLabelPositions).toEqual(labels);
    expect(projectionSources(document, f.sketchId)).toEqual(sources);
  };
  const priorEntries = structuredClone(manager.document.editHistory!.entries);
  manager.execute(
    commandFactories.setParameter({ name: 'w', expression: '32' })
  );
  const resized = await adapter.syncDocument(manager.document);
  expect(resized.warnings).toEqual([]);
  expect(resized.bodyRepresentations[f.sourceId]!.volume).toBeCloseTo(1600, 8);
  expect(resized.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(960, 8);
  expect(resized.bodyRepresentations[f.plateId]!.bbox.max.x).toBeCloseTo(32, 8);
  expect(resized.bodyRepresentations[f.plateId]!.bbox.max.y).toBeCloseTo(10, 8);
  const states = Object.values(resized.sketchProjections ?? {});
  expect(states.filter((state) => state.status === 'moved')).toHaveLength(3);
  expect(states.filter((state) => state.status === 'current')).toHaveLength(1);
  const writeBack = projectionWriteBackCommand(manager.document, resized);
  expect(writeBack).not.toBeNull();
  manager.normalize(writeBack!);
  expect(manager.document.editHistory!.entries.slice(0, -1)).toEqual(
    priorEntries
  );
  retained(manager.document);
  expectDistances(manager.document, f.sketchId, 32);
  const settled = await adapter.syncDocument(manager.document);
  expect(settled.warnings).toEqual([]);
  expect(
    Object.values(settled.sketchProjections ?? {}).every(
      (state) => state.status === 'current'
    )
  ).toBe(true);

  manager.undo();
  retained(manager.document);
  expectDistances(manager.document, f.sketchId, 20);
  const undone = await adapter.syncDocument(manager.document);
  expect(undone.warnings).toEqual([]);
  expect(undone.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(600, 8);
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
  expect(resumed.canRedo).toBe(true);
  retained(resumed.document);
  expectDistances(resumed.document, f.sketchId, 20);
  resumed.redo();
  retained(resumed.document);
  expectDistances(resumed.document, f.sketchId, 32);
  const replayed = replayCommands(f.initial, resumed.document.commandLog);
  expect(replayed.nodes).toEqual(resumed.document.nodes);
  retained(replayed);
  expectDistances(replayed, f.sketchId, 32);
  for (const document of [resumed.document, replayed]) {
    const rebuilt = await adapter.syncDocument(document);
    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(960, 8);
    expect(rebuilt.bodyRepresentations[f.plateId]!.bbox).toEqual(
      settled.bodyRepresentations[f.plateId]!.bbox
    );
  }
});
