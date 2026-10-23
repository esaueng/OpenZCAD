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
  objectFolderOfBody,
  resolveParamValue
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
  resolveSketchPromotionBoundaryTokens,
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
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';

const owner = toUserId('user_schema_retention');
const sheetId = 'dsht_provenance_folders' as DrawingSheetId;
const noteId = 'dann_provenance_folders' as DrawingAnnotationId;
const imageId = 'rimg_provenance_folders' as ReferenceImageId;
const artifactId = toArtifactId('artifact_provenance_folders_png');
const assetId = toAssetId('asset_provenance_folders_thumbnail');
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxoAAAAASUVORK5CYII='
  ),
  (character) => character.charCodeAt(0)
);
const above = { type: 'canonical', plane: 'XY', offset: 8 } as const;
const hole = {
  objectKind: 'rectangle' as const,
  width: '2 mm',
  height: 4,
  centerX: 5,
  centerY: 5
};
const scalar = (value: Parameters<typeof resolveParamValue>[0]) =>
  resolveParamValue(value, {}, 'retained conversion', 'mm');

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
  width: number
) {
  const sketch = findSketch(document, sketchId)!;
  const measured = sketch.referenceDimensions!.map((reference) =>
    resolveSketchReferenceDimension(
      sketchObjects(document, sketchId),
      reference,
      scalar,
      sketch.composites
    )
  );
  expect(measured).toHaveLength(9);
  for (const [index, value] of [
    Math.hypot(width, 10),
    Math.hypot(width, 10),
    width,
    10,
    Math.hypot(width - 6, 7),
    width - 6,
    7,
    2
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
  const initial = createProjectDocument('Provenance and folders', owner);
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
    source: { fingerprint: 'v1:provenance-folders-fixture' },
    views: [
      {
        viewId: 'dvw_provenance_folders_top' as DrawingViewId,
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
  manager.execute(
    commandFactories.addSketchObjects({ sketchId, objects: [hole] })
  );
  const holeId = findSketch(manager.document, sketchId)!.objectIds.at(-1)!;
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
  const selected = computeSketchRegions(
    [...sketchObjects(manager.document, sketchId)].map(([id, data]) => ({
      id,
      data
    })),
    scalar
  ).filter((region) => region.sourceEntityIds.includes(objectIds[0]!));
  expect(selected).toHaveLength(1);
  const region = selected[0]!;
  expect(region.area).toBeCloseTo(192, 9);
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
  saved.schemaVersion = 36 as ProjectDocument['schemaVersion'];
  return {
    initial,
    saved,
    sketchId,
    sourceId,
    plateId,
    plateFeatureId: plate.payload.ids!.featureNodeId,
    objectIds,
    holeId,
    a,
    b,
    sum
  };
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
            objectKey: 'retained/provenance-folders.png',
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

it('converts a mixed-unit hole inside a linked outline while retaining native content, named targets, provenance and a real face attachment', async () => {
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
  const selected = computeSketchRegions(
    [...sketchObjects(opened, f.sketchId)].map(([id, data]) => ({ id, data })),
    scalar
  ).filter((region) => region.sourceEntityIds.includes(f.objectIds[0]!));
  expect(selected).toHaveLength(1);
  expect(selected[0]!.area).toBeCloseTo(192, 9);
  const loops = selected[0]!.sourceBoundaryLoops!;
  expect(loops.outer).toHaveLength(4);
  expect(loops.outer.every((token) => token.startsWith('p1/'))).toBe(true);
  expect(loops.holes).toHaveLength(1);
  expect(loops.holes[0]).toHaveLength(4);
  expect(
    loops.holes[0]!.every((token) => token.startsWith(`b1/${f.holeId}/`))
  ).toBe(true);
  const before = await adapter.syncDocument(opened);
  expect(before.warnings).toEqual([]);
  expect(before.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(576, 8);
  const faceNames = before.bodyRepresentations[f.plateId]!.topology!.faces.map(
    (face) => face.reference?.lineageName
  ).sort();
  expect(faceNames).toHaveLength(10);
  expect(faceNames.every((name) => typeof name === 'string')).toBe(true);
  const front = before.bodyRepresentations[f.plateId]!.topology!.faces.find(
    (face) =>
      (face.geometry?.normal?.y ?? 0) < -0.99 &&
      Math.abs(face.geometry?.center?.y ?? Infinity) < 1e-9
  )!;
  const attachment = faceSketchAttachment({
    bodyId: f.plateId,
    pickedHash: front.hash,
    face: front
  });
  if (!attachment.ok) throw new Error(attachment.reason);
  expect(attachment.attachment).toBe('associative');
  const attachedSketch = commandFactories.addSketch({
    name: 'Retained face attachment',
    planeRef: attachment.planeRef,
    objects: [{ objectKind: 'circle', radius: 0.5, centerX: 0, centerY: 0 }]
  });
  manager.execute(attachedSketch);
  const attachedSketchId = attachedSketch.payload.ids!.sketchId;
  const boss = commandFactories.extrudeSketch({
    name: 'Attached boss',
    sketchId: attachedSketchId,
    distance: 1,
    operation: 'new-body'
  });
  manager.execute(boss);
  const bossId = boss.payload.ids!.bodyId;
  manager.execute(
    commandFactories.moveToObjectFolder({
      parentId: 'folder_assembly',
      bodyIds: [bossId]
    })
  );
  const beforeConversion = structuredClone(manager.document);
  manager.execute(
    commandFactories.convertLegacySketchObject({
      sketchId: f.sketchId,
      sourceObjectId: f.holeId,
      expectedSource: hole
    })
  );
  const convertedSketch = findSketch(manager.document, f.sketchId)!;
  const promotion = structuredClone(convertedSketch.promotions![0]!);
  expect(promotion.sourceObjectId).toBe(f.holeId);
  expect(promotion.sourceData).toEqual(hole);
  expect(promotion.edgeIds).toHaveLength(4);
  expect(promotion.aliases.edges).toEqual(promotion.edgeIds);
  expect(promotion.aliases.vertices).toEqual(
    promotion.edgeIds.map((objectId) => ({ objectId, point: 'start' }))
  );
  expect(manager.document.nodes[f.holeId]).toBeUndefined();
  const profileOf = (document: ProjectDocument) => {
    const feature = document.nodes[f.plateFeatureId]!;
    if (feature.kind !== 'feature' || feature.data.featureKind !== 'extrude')
      throw new Error('Missing plate');
    const profile = feature.data.profile;
    if (
      !profile ||
      !('sourceBoundaryLoops' in profile) ||
      !profile.sourceBoundaryLoops
    )
      throw new Error('Missing retained boundary provenance');
    return profile;
  };
  expect(profileOf(manager.document).sourceBoundaryLoops).toEqual(loops);
  const firstEdge = sketchObjects(manager.document, f.sketchId).get(
    promotion.edgeIds[0]!
  )!;
  if (firstEdge.objectKind !== 'line')
    throw new Error('Missing converted edge');
  // Raw `(5) + (2 mm) * -.5` used to fail evaluation and lose this hole.
  expect({
    x1: scalar(firstEdge.x1),
    y1: scalar(firstEdge.y1),
    x2: scalar(firstEdge.x2),
    y2: scalar(firstEdge.y2)
  }).toEqual({ x1: 4, y1: 3, x2: 6, y2: 3 });
  const regionsAfterConversion = computeSketchRegions(
    [...sketchObjects(manager.document, f.sketchId)].map(([id, data]) => ({
      id,
      data
    })),
    scalar,
    undefined,
    {
      promotionBoundaryTokens: resolveSketchPromotionBoundaryTokens(
        convertedSketch.promotions!,
        sketchObjects(manager.document, f.sketchId)
      )
    }
  );
  const convertedRegion = regionsAfterConversion.find((region) =>
    region.sourceEntityIds.includes(f.objectIds[0]!)
  )!;
  expect(convertedRegion.area).toBeCloseTo(192, 9);
  expect(convertedRegion.sourceBoundaryLoops).toEqual(loops);
  const converted = await adapter.syncDocument(manager.document);
  expect(converted.warnings).toEqual([]);
  expect(converted.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(576, 8);
  expect(
    converted.bodyRepresentations[f.plateId]!.topology!.faces.map(
      (face) => face.reference?.lineageName
    ).sort()
  ).toEqual(faceNames);
  manager.execute(
    commandFactories.addSketchComposite({
      sketchId: f.sketchId,
      composite: {
        compositeKind: 'rectangle',
        method: 'corner',
        edgeIds: [...promotion.edgeIds]
      }
    })
  );
  const composite = findSketch(manager.document, f.sketchId)!.composites![0]!;
  const unannotated = structuredClone(manager.document);
  const solveBefore = await adapter.solveSketch(unannotated, f.sketchId);
  const corner = createSketchCompositeCornerTarget(composite, 1);
  expect(corner.topology).toEqual({
    version: 1,
    edgeIds: promotion.edgeIds,
    helperIds: []
  });
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
      data: {
        dimensionKind: 'angle',
        a: createSketchCompositeSideTarget(composite, 0),
        b: createSketchCompositeSideTarget(composite, 1)
      }
    })
  ];
  manager.runTransaction('Measure converted hole from projected corner', [
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
  expectMeasurements(annotated, f.sketchId, 20);
  expect(sketch.constraints).toEqual(
    findSketch(unannotated, f.sketchId)!.constraints
  );
  for (const id of objectIds)
    expect(annotated.nodes[id]).toEqual(unannotated.nodes[id]);
  for (const [index, feature] of listFeaturesInOrder(unannotated).entries())
    expect(historyFeatureDigest(annotated, feature, index)).toBe(
      historyFeatureDigest(unannotated, feature, index)
    );
  expect(await adapter.solveSketch(annotated, f.sketchId)).toEqual(solveBefore);
  const afterAnnotations = await adapter.syncDocument(annotated);
  expect(afterAnnotations.warnings).toEqual([]);
  expect(afterAnnotations.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(
    576,
    8
  );
  expect(afterAnnotations.bodyRepresentations[f.plateId]!.bbox).toEqual(
    converted.bodyRepresentations[f.plateId]!.bbox
  );
  const attachmentWire: unknown = JSON.parse(
    JSON.stringify(attachment.planeRef)
  );
  const oldContent = (document: ProjectDocument) => {
    expect(document.objectFolders).toEqual(folders);
    for (const id of [f.sourceId, f.plateId, bossId])
      expect(objectFolderOfBody(document, id)).toBe('folder_assembly');
    expect(document.drawings).toEqual(opened.drawings);
    expect(document.referenceImages).toEqual(opened.referenceImages);
    expect(document.assets).toEqual(opened.assets);
    expect(projectionSources(document, f.sketchId)).toEqual(sources);
    expect(
      JSON.parse(
        JSON.stringify(findSketch(document, attachedSketchId)!.planeRef)
      )
    ).toEqual(attachmentWire);
  };
  const retained = (document: ProjectDocument) => {
    oldContent(document);
    const current = findSketch(document, f.sketchId)!;
    expect(current.objectIds).toEqual(objectIds);
    expect(current.promotions).toEqual([promotion]);
    expect(current.composites).toEqual([composite]);
    expect(current.referenceDimensions).toEqual(references);
    expect(current.dimensionLabelPositions).toEqual(labels);
    expect(profileOf(document).sourceBoundaryLoops).toEqual(loops);
  };
  const priorEntries = structuredClone(manager.document.editHistory!.entries);
  manager.execute(
    commandFactories.setParameter({ name: 'w', expression: '32' })
  );
  const resized = await adapter.syncDocument(manager.document);
  expect(resized.warnings).toEqual([]);
  expect(resized.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(936, 8);
  const writeBack = projectionWriteBackCommand(manager.document, resized);
  expect(writeBack).not.toBeNull();
  manager.normalize(writeBack!);
  retained(manager.document);
  expectMeasurements(manager.document, f.sketchId, 32);
  expect(manager.document.editHistory!.entries.slice(0, -1)).toEqual(
    priorEntries
  );
  expect(
    manager.document.editHistory!.entries.slice(
      0,
      opened.editHistory!.entries.length
    )
  ).toEqual(opened.editHistory!.entries);
  const settled = await adapter.syncDocument(manager.document);
  expect(settled.warnings).toEqual([]);
  expect(
    settled.bodyRepresentations[f.plateId]!.topology!.faces.map(
      (face) => face.reference?.lineageName
    ).sort()
  ).toEqual(faceNames);
  expect(settled.bodyRepresentations[bossId]!.volume).toBeCloseTo(
    Math.PI / 4,
    8
  );
  expect(
    (settled.bodyRepresentations[bossId]!.bbox.min.x +
      settled.bodyRepresentations[bossId]!.bbox.max.x) /
      2
  ).toBeCloseTo(16, 8);
  expect(
    Object.values(settled.sketchProjections ?? {}).every(
      (state) => state.status === 'current'
    )
  ).toBe(true);
  manager.undo();
  retained(manager.document);
  expectMeasurements(manager.document, f.sketchId, 20);
  const undone = await adapter.syncDocument(manager.document);
  expect(undone.warnings).toEqual([]);
  expect(undone.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(576, 8);
  expect(undone.bodyRepresentations[bossId]!.volume).toBeCloseTo(
    Math.PI / 4,
    8
  );
  expect(
    (undone.bodyRepresentations[bossId]!.bbox.min.x +
      undone.bodyRepresentations[bossId]!.bbox.max.x) /
      2
  ).toBeCloseTo(10, 8);
  manager.undo();
  manager.undo();
  manager.undo();
  oldContent(manager.document);
  expect(manager.document.nodes[f.holeId]).toEqual(
    beforeConversion.nodes[f.holeId]
  );
  expect(findSketch(manager.document, f.sketchId)).toEqual(
    findSketch(beforeConversion, f.sketchId)
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
  oldContent(resumed.document);
  expect(resumed.canRedo).toBe(true);
  resumed.redo();
  expect(profileOf(resumed.document).sourceBoundaryLoops).toEqual(loops);
  expect(findSketch(resumed.document, f.sketchId)!.promotions).toEqual([
    promotion
  ]);
  resumed.redo();
  resumed.redo();
  retained(resumed.document);
  expectMeasurements(resumed.document, f.sketchId, 20);
  resumed.redo();
  retained(resumed.document);
  expectMeasurements(resumed.document, f.sketchId, 32);
  const replayed = replayCommands(f.initial, resumed.document.commandLog);
  expect(replayed.nodes).toEqual(resumed.document.nodes);
  retained(replayed);
  expectMeasurements(replayed, f.sketchId, 32);
  for (const document of [resumed.document, replayed]) {
    const rebuilt = await adapter.syncDocument(document);
    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(936, 8);
    expect(
      rebuilt.bodyRepresentations[f.plateId]!.topology!.faces.map(
        (face) => face.reference?.lineageName
      ).sort()
    ).toEqual(faceNames);
    expect(rebuilt.bodyRepresentations[bossId]!.volume).toBeCloseTo(
      Math.PI / 4,
      8
    );
    expect(
      (rebuilt.bodyRepresentations[bossId]!.bbox.min.x +
        rebuilt.bodyRepresentations[bossId]!.bbox.max.x) /
        2
    ).toBeCloseTo(16, 8);
  }
});
