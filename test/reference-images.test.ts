import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  normalizeDocument,
  normalizedReferenceImageRotation
} from '@openzcad/document-core';
import {
  calibratedReferenceImageWidth,
  isAcceptableReferenceImageArtifact,
  MAX_REFERENCE_IMAGE_BYTES,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  referenceImageError,
  referenceImageHeight,
  referenceImageSetError,
  referenceImagesWithHistory,
  sniffReferenceImageType,
  toUserId,
  type ArtifactId,
  type ProjectDocument,
  type ReferenceImage,
  type ReferenceImageId
} from '@openzcad/shared';
import { sharedProjectSnapshotDocument } from '@openzcad/persistence';
import {
  canonicalProjectContentKey,
  geometryContentKey
} from '../apps/web/src/worker/exactRebuildCache';
import {
  parseCreateUploadSessionRequest,
  parseSaveProjectDocumentRequest
} from '../apps/web/worker/validation';
import { createProjectDiagnosticBundle } from '../apps/web/src/lib/projectDiagnostics';
import { importSourceChecksums } from '../apps/web/src/lib/sourceBlobClaims';
import * as webGlimpse from '../apps/web/src/lib/glimpseContract';
import * as workerGlimpse from '../apps/web/worker/glimpseContract';

const imageId = 'rimg_one' as ReferenceImageId;
const checksum = 'a'.repeat(64);

function image(extra: Partial<ReferenceImage> = {}): ReferenceImage {
  return {
    imageId,
    name: 'Bracket drawing',
    contentType: 'image/png',
    source: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: checksum,
      logicalBytes: 1234
    },
    artifactId: 'artifact_one' as ArtifactId,
    pixelWidth: 400,
    pixelHeight: 200,
    plane: { type: 'canonical', plane: 'XY', offset: 0 },
    center: { u: 0, v: 0 },
    rotationDeg: 0,
    width: 100,
    opacity: 0.6,
    ...extra
  };
}

function boxDocument(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Bracket', toUserId('test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 6 }
    }
  );
}

describe('I05 reference-image section (schema v32)', () => {
  it('is schema 32, additive, and never added to a document without images', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(32);
    const document = boxDocument();
    expect(document.referenceImages).toBeUndefined();
    const saved = JSON.parse(JSON.stringify(document)) as ProjectDocument;
    // An older document opens exactly as written: no empty section appears.
    const older = { ...saved, schemaVersion: 30 } as unknown as ProjectDocument;
    const opened = normalizeDocument(older);
    expect('referenceImages' in opened).toBe(false);
    expect(opened.nodes).toEqual(saved.nodes);
  });

  it('inserts, edits, deletes, undoes and replays images without the pixels', () => {
    const document = boxDocument();
    const manager = new CommandManager(document);
    manager.execute(commandFactories.addReferenceImage({ image: image() }));
    expect(manager.document.referenceImages?.images).toEqual([image()]);
    manager.execute(
      commandFactories.updateReferenceImage({
        imageId,
        center: { u: 5, v: -3 },
        rotationDeg: 270,
        width: 80,
        opacity: 0.3,
        plane: { type: 'canonical', plane: 'YZ', offset: 4 }
      })
    );
    const edited = manager.document.referenceImages!.images[0]!;
    expect(edited).toMatchObject({
      center: { u: 5, v: -3 },
      // Stored in (−180, 180] so equal turns store equal angles.
      rotationDeg: -90,
      width: 80,
      opacity: 0.3,
      plane: { type: 'canonical', plane: 'YZ', offset: 4 }
    });
    // The command log and the undo entry carry the reference, never bytes.
    expect(JSON.stringify(manager.document.commandLog)).not.toMatch(
      /base64|data:image/
    );
    // Undo, redo and replay reproduce the same placement.
    expect(
      replayCommands(document, manager.document.commandLog).referenceImages
    ).toEqual(manager.document.referenceImages);
    expect(manager.undoIsReferenceImageOnly).toBe(true);
    manager.undo();
    expect(manager.document.referenceImages?.images[0]?.width).toBe(100);
    manager.redo();
    expect(manager.document.referenceImages?.images[0]?.width).toBe(80);
    manager.execute(commandFactories.deleteReferenceImage({ imageId }));
    // An empty section is stored as absent, never as an empty list.
    expect('referenceImages' in manager.document).toBe(false);
    // The deleted image still owns its bytes while undo can restore it.
    expect([...referenceImagesWithHistory(manager.document)]).not.toHaveLength(
      0
    );
    expect(importSourceChecksums(manager.document).has(checksum)).toBe(true);
    manager.undo();
    expect(manager.document.referenceImages?.images).toHaveLength(1);
  });

  it('records no edit for an update that changes nothing', () => {
    const manager = new CommandManager(boxDocument());
    manager.execute(commandFactories.addReferenceImage({ image: image() }));
    const version = manager.document.version;
    manager.execute(
      commandFactories.updateReferenceImage({ imageId, width: 100 })
    );
    expect(manager.document.version).toBe(version);
  });

  it('refuses a duplicate id and an unknown image', () => {
    const manager = new CommandManager(boxDocument());
    manager.execute(commandFactories.addReferenceImage({ image: image() }));
    expect(() =>
      manager.execute(commandFactories.addReferenceImage({ image: image() }))
    ).toThrow(/already exists/);
    expect(() =>
      manager.execute(
        commandFactories.updateReferenceImage({
          imageId: 'rimg_missing' as ReferenceImageId,
          width: 3
        })
      )
    ).toThrow(/not found/);
  });

  it('validates the section on load and at the account edge', () => {
    for (const bad of [
      image({ width: 0 }),
      image({ opacity: 0 }),
      image({ opacity: 1.5 }),
      image({ pixelWidth: 0 }),
      image({ contentType: 'image/gif' as 'image/png' }),
      image({ name: '  ' }),
      image({ imageId: 'img_wrong' as ReferenceImageId }),
      image({ center: { u: Number.NaN, v: 0 } }),
      image({
        plane: { type: 'canonical', plane: 'XW' as 'XY', offset: 0 }
      }),
      image({
        source: {
          ...image().source,
          logicalBytes: MAX_REFERENCE_IMAGE_BYTES + 1
        }
      })
    ]) {
      expect(referenceImageError(bad)).not.toBeNull();
      const document = {
        ...boxDocument(),
        referenceImages: { images: [bad] }
      } as ProjectDocument;
      expect(() => normalizeDocument(document)).toThrow();
      const wire = JSON.parse(JSON.stringify(document)) as ProjectDocument;
      expect(() =>
        parseSaveProjectDocumentRequest(
          { projectId: wire.projectId, expectedVersion: 0, document: wire },
          wire.projectId
        )
      ).toThrow(/referenceImages/);
    }
    expect(referenceImageSetError({ images: [] })).toMatch(/absent/);
    expect(referenceImageSetError({ images: [image(), image()] })).toMatch(
      /twice/
    );
    expect(referenceImageSetError({ images: [image()] })).toBeNull();
    // Every plane a sketch can use is accepted.
    for (const plane of [
      { type: 'datum', datumFeatureId: 'feature_datum' },
      {
        type: 'frame',
        frame: {
          origin: { x: 0, y: 0, z: 5 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          zAxis: { x: 0, y: 0, z: 1 }
        }
      },
      { type: 'canonical', plane: 'XZ', offset: -2, basisRevision: 2 }
    ] as ReferenceImage['plane'][]) {
      expect(referenceImageError(image({ plane }))).toBeNull();
    }
  });

  it('drops an undo history whose image snapshot is malformed', () => {
    const manager = new CommandManager(boxDocument());
    manager.execute(commandFactories.addReferenceImage({ image: image() }));
    manager.execute(
      commandFactories.updateReferenceImage({ imageId, width: 40 })
    );
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    const change = saved
      .editHistory!.entries.at(-1)!
      .changes.find((entry) => entry.field === 'referenceImages')!;
    (change as { before?: unknown }).before = {
      images: [image({ width: -1 })]
    };
    const opened = normalizeDocument(saved);
    expect(opened.editHistory).toBeUndefined();
    expect(opened.referenceImages).toEqual(manager.document.referenceImages);
  });

  it('stays out of the geometry key, share links and diagnostics', () => {
    const document = boxDocument();
    const placed = new CommandManager(document);
    placed.execute(commandFactories.addReferenceImage({ image: image() }));
    // An image edit keeps every cached build and the ready geometry.
    expect(geometryContentKey(placed.document)).toBe(
      geometryContentKey({ ...placed.document, referenceImages: undefined })
    );
    expect(canonicalProjectContentKey(placed.document)).not.toBe(
      canonicalProjectContentKey({
        ...placed.document,
        referenceImages: undefined
      })
    );
    expect(
      'referenceImages' in sharedProjectSnapshotDocument(placed.document)
    ).toBe(false);
    const bundle = createProjectDiagnosticBundle(
      placed.document,
      { remusVersion: '0', remusCommit: '0' },
      '2026-10-20T00:00:00.000Z'
    );
    expect('referenceImages' in bundle.document).toBe(false);
    // Images are never features or bodies: nothing the build reads changes.
    expect(placed.document.featureOrder).toEqual(document.featureOrder);
    expect(placed.document.bodyOrder).toEqual(document.bodyOrder);
  });

  it('lists every image command in both analytics operation allowlists', () => {
    const kinds = [
      'reference-image.add',
      'reference-image.update',
      'reference-image.delete'
    ];
    for (const contract of [webGlimpse, workerGlimpse])
      expect(contract.EXPANDED.feature_operation).toEqual(
        expect.arrayContaining(kinds)
      );
  });

  it('accepts only PNG and JPEG reference-image uploads', () => {
    const request = (contentType: string) => ({
      projectId: 'project_one',
      fileName: 'drawing.png',
      contentType,
      kind: 'reference-image'
    });
    expect(parseCreateUploadSessionRequest(request('image/png')).kind).toBe(
      'reference-image'
    );
    expect(
      parseCreateUploadSessionRequest(request('image/jpeg')).contentType
    ).toBe('image/jpeg');
    expect(() =>
      parseCreateUploadSessionRequest(request('image/svg+xml'))
    ).toThrow(/Reference image contentType/);
    expect(isAcceptableReferenceImageArtifact('image/png', 10)).toBe(true);
    expect(isAcceptableReferenceImageArtifact('image/png', 0)).toBe(false);
    expect(
      isAcceptableReferenceImageArtifact(
        'image/jpeg',
        MAX_REFERENCE_IMAGE_BYTES + 1
      )
    ).toBe(false);
    expect(isAcceptableReferenceImageArtifact('text/html', 10)).toBe(false);
  });
});

describe('reference-image measures', () => {
  it('scales by two points and a known distance', () => {
    // 100 px apart on a 400 px picture, known to be 25 mm: 100 mm wide.
    expect(
      calibratedReferenceImageWidth(
        { pixelWidth: 400 },
        { x: 10, y: 10 },
        { x: 70, y: 90 },
        25
      )
    ).toBeCloseTo(100, 12);
    expect(
      calibratedReferenceImageWidth(
        { pixelWidth: 400 },
        { x: 10, y: 10 },
        { x: 10, y: 10 },
        25
      )
    ).toBeNull();
    expect(
      calibratedReferenceImageWidth(
        { pixelWidth: 400 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        -5
      )
    ).toBeNull();
    expect(referenceImageHeight(image({ width: 80 }))).toBe(40);
  });

  it('normalizes turns and recognizes PNG and JPEG by content', () => {
    expect(normalizedReferenceImageRotation(180)).toBe(180);
    expect(normalizedReferenceImageRotation(-180)).toBe(180);
    expect(normalizedReferenceImageRotation(370)).toBe(10);
    expect(normalizedReferenceImageRotation(-190)).toBe(170);
    expect(
      sniffReferenceImageType(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
      )
    ).toBe('image/png');
    expect(sniffReferenceImageType(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe(
      'image/jpeg'
    );
    expect(
      sniffReferenceImageType(new TextEncoder().encode('<svg></svg>'))
    ).toBeNull();
  });
});
