import { frameForPlaneRef, type PlaneBasis } from '@openzcad/geometry';
import {
  referenceImageHeight,
  type ProjectDocument,
  type ReferenceImage,
  type ReferenceImageId,
  type ReferenceImagePlane,
  type Vector3
} from '@openzcad/shared';
import { resolvedSketchPlaneBasis } from './sketch/planeBasis';

/*
 * I05 reference images as the viewport draws them. Kept apart from the card
 * on purpose: the workspace shell calls this every render, and whatever
 * App.tsx imports lands in the entry chunk whole.
 */

/**
 * Where an image's plane lies now. A datum follows the frame the exact build
 * resolved; a face follows its lineage, and keeps the frame it was placed on
 * when the face can no longer be found, so the picture stays put rather than
 * vanishing. Null only for a datum that has not resolved (failed, suppressed,
 * deleted or still building).
 */
export function referenceImagePlaneBasis(
  document: ProjectDocument,
  plane: ReferenceImagePlane,
  name: string
): PlaneBasis | null {
  if (plane.type === 'datum') {
    return document.derived.datumFrames?.[plane.datumFeatureId] ?? null;
  }
  if (plane.type === 'face') {
    try {
      return resolvedSketchPlaneBasis(document, plane, () => 0, name);
    } catch {
      return frameForPlaneRef(plane, () => 0);
    }
  }
  return frameForPlaneRef(plane, (value) =>
    typeof value === 'number' ? value : 0
  );
}

/** The image's own frame in the world: its centre and its turned axes. */
export interface ReferenceImageFrame {
  center: Vector3;
  /** Along the image's width (its pixel rows, left to right). */
  xAxis: Vector3;
  /** Along the image's height (its pixel columns, bottom to top). */
  yAxis: Vector3;
  normal: Vector3;
}

export function referenceImageFrame(
  basis: PlaneBasis,
  image: Pick<ReferenceImage, 'center' | 'rotationDeg'>
): ReferenceImageFrame {
  const { origin, u, v, normal } = basis;
  const turn = (image.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const along = (a: number, b: number): Vector3 => ({
    x: u.x * a + v.x * b,
    y: u.y * a + v.y * b,
    z: u.z * a + v.z * b
  });
  const offset = along(image.center.u, image.center.v);
  return {
    center: {
      x: origin.x + offset.x,
      y: origin.y + offset.y,
      z: origin.z + offset.z
    },
    xAxis: along(cos, sin),
    yAxis: along(-sin, cos),
    normal: { x: normal.x, y: normal.y, z: normal.z }
  };
}

/** A reference image as the viewport draws it: presentation only. */
export interface ReferenceImageDisplay {
  imageId: ReferenceImageId;
  name: string;
  frame: ReferenceImageFrame;
  width: number;
  height: number;
  opacity: number;
  /** The bytes' identity, so the viewer can cache one texture per picture. */
  checksumSha256: string;
  /** Where the bytes are archived; a change retries an unavailable picture. */
  artifactId: string;
  selected: boolean;
}

/**
 * The shown reference images, with any unsaved card draft laid over its
 * image so the viewport follows the fields as they are typed. An image whose
 * plane has not resolved draws nothing rather than a guess.
 */
export function referenceImageDisplays(
  document: ProjectDocument,
  hidden: ReadonlySet<string>,
  selectedImageId: string | null,
  draft: ReferenceImage | null = null
): ReferenceImageDisplay[] {
  return (document.referenceImages?.images ?? []).flatMap((stored) => {
    const image = draft?.imageId === stored.imageId ? draft : stored;
    if (hidden.has(image.imageId)) return [];
    const basis = referenceImagePlaneBasis(document, image.plane, image.name);
    if (!basis) return [];
    return [
      {
        imageId: image.imageId,
        name: image.name,
        frame: referenceImageFrame(basis, image),
        width: image.width,
        height: referenceImageHeight(image),
        opacity: image.opacity,
        checksumSha256: image.source.checksumSha256,
        artifactId: image.artifactId,
        selected: image.imageId === selectedImageId
      }
    ];
  });
}

/** True when the image's plane cannot be found at all: a datum gone missing. */
export function referenceImagePlaneMissing(
  document: ProjectDocument,
  image: ReferenceImage
): boolean {
  return referenceImagePlaneBasis(document, image.plane, image.name) === null;
}

/**
 * Where a picture about to be inserted will lie, from the face selected when
 * the Image tool opened: on that face when it can carry an image, on Top
 * (XY) with no face selected, and nowhere — a refusal to show — when a face
 * is selected that it cannot lie on, rather than quietly on Top, far from
 * what the user picked.
 */
export function referenceImageInsertPlane(
  selectedFace: ReferenceImagePlane | { reason: string } | null
): { plane: ReferenceImagePlane } | { refusal: string } {
  if (selectedFace === null)
    return { plane: { type: 'canonical', plane: 'XY', offset: 0 } };
  if ('reason' in selectedFace)
    return {
      refusal: `${selectedFace.reason} Clear the selection to place it on Top (XY).`
    };
  return { plane: selectedFace };
}
