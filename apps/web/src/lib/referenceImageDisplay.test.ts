import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  addReferenceImage
} from '@openzcad/document-core';
import {
  toUserId,
  type ArtifactId,
  type FeatureId,
  type ProjectDocument,
  type ReferenceImage,
  type ReferenceImageId
} from '@openzcad/shared';
import {
  referenceImageDisplays,
  referenceImageFrame,
  referenceImagePlaneMissing
} from './referenceImageDisplay';

function image(extra: Partial<ReferenceImage> = {}): ReferenceImage {
  return {
    imageId: 'rimg_one' as ReferenceImageId,
    name: 'Plan',
    contentType: 'image/png',
    source: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: 'b'.repeat(64),
      logicalBytes: 10
    },
    artifactId: 'artifact_one' as ArtifactId,
    pixelWidth: 300,
    pixelHeight: 100,
    plane: { type: 'canonical', plane: 'XY', offset: 0 },
    center: { u: 0, v: 0 },
    rotationDeg: 0,
    width: 60,
    opacity: 0.5,
    ...extra
  };
}

function withImage(placed: ReferenceImage): ProjectDocument {
  return addReferenceImage(createProjectDocument('Images', toUserId('test')), {
    image: placed
  });
}

const close = (vector: { x: number; y: number; z: number }) => ({
  x: Math.round(vector.x * 1e9) / 1e9 + 0,
  y: Math.round(vector.y * 1e9) / 1e9 + 0,
  z: Math.round(vector.z * 1e9) / 1e9 + 0
});

describe('reference image placement', () => {
  it('lays an image on a principal plane at its offset, position and turn', () => {
    const document = withImage(
      image({
        plane: { type: 'canonical', plane: 'XY', offset: 7 },
        center: { u: 10, v: -4 },
        rotationDeg: 90
      })
    );
    const [shown] = referenceImageDisplays(document, new Set(), null);
    expect(close(shown!.frame.center)).toEqual({ x: 10, y: -4, z: 7 });
    // A quarter turn counter-clockwise about +Z: the width runs along +Y.
    expect(close(shown!.frame.xAxis)).toEqual({ x: 0, y: 1, z: 0 });
    expect(close(shown!.frame.yAxis)).toEqual({ x: -1, y: 0, z: 0 });
    expect(shown!.width).toBe(60);
    expect(shown!.height).toBe(20);
    expect(shown!.opacity).toBe(0.5);
  });

  it('faces the Front view on the front-facing XZ basis', () => {
    const document = withImage(
      image({
        plane: { type: 'canonical', plane: 'XZ', offset: 0, basisRevision: 2 }
      })
    );
    const [shown] = referenceImageDisplays(document, new Set(), null);
    // Width along +X, height up +Z, readable from the Front view.
    expect(close(shown!.frame.xAxis)).toEqual({ x: 1, y: 0, z: 0 });
    expect(close(shown!.frame.yAxis)).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('follows a datum plane, and draws nothing while it has not resolved', () => {
    const datumFeatureId = 'feature_datum' as FeatureId;
    const document = withImage(
      image({ plane: { type: 'datum', datumFeatureId } })
    );
    expect(referenceImageDisplays(document, new Set(), null)).toEqual([]);
    expect(
      referenceImagePlaneMissing(document, document.referenceImages!.images[0]!)
    ).toBe(true);
    const resolved: ProjectDocument = {
      ...document,
      derived: {
        ...document.derived,
        datumFrames: {
          [datumFeatureId]: {
            origin: { x: 0, y: 0, z: 12 },
            u: { x: 1, y: 0, z: 0 },
            v: { x: 0, y: 1, z: 0 },
            normal: { x: 0, y: 0, z: 1 }
          }
        }
      }
    };
    const [shown] = referenceImageDisplays(resolved, new Set(), null);
    expect(shown!.frame.center.z).toBe(12);
  });

  it('keeps a face image on the frame it was placed on when the face is gone', () => {
    const document = withImage(
      image({
        plane: {
          type: 'face',
          bodyId: 'body_gone' as never,
          faceHash: 4,
          sourceArea: 100,
          sourceCenter: { x: 0, y: 0, z: 20 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          frame: {
            origin: { x: 1, y: 2, z: 20 },
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { x: 0, y: 0, z: 1 }
          }
        }
      })
    );
    const [shown] = referenceImageDisplays(document, new Set(), null);
    expect(shown!.frame.center).toEqual({ x: 1, y: 2, z: 20 });
  });

  it('skips hidden images, marks the selected one and shows a card draft', () => {
    const stored = image();
    const document = withImage(stored);
    expect(
      referenceImageDisplays(document, new Set([stored.imageId]), null)
    ).toEqual([]);
    const [selected] = referenceImageDisplays(
      document,
      new Set(),
      stored.imageId,
      { ...stored, width: 120, opacity: 0.9 }
    );
    expect(selected).toMatchObject({
      selected: true,
      width: 120,
      opacity: 0.9
    });
  });

  it('turns about the plane normal', () => {
    const frame = referenceImageFrame(
      {
        origin: { x: 0, y: 0, z: 0 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 }
      },
      { center: { u: 0, v: 0 }, rotationDeg: 45 }
    );
    expect(frame.xAxis.x).toBeCloseTo(Math.SQRT1_2);
    expect(frame.xAxis.y).toBeCloseTo(Math.SQRT1_2);
  });
});
