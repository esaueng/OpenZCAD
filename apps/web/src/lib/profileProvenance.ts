import {
  geometryTolerance,
  profileContainsPoint,
  resolveBoundaryProfileReference
} from '@openzcad/geometry';
import type { BoundaryProvenance } from '@openzcad/shared';

type Point = { x: number; y: number };
export interface BoundaryRegionGeometry {
  outer: Point[];
  holes: Point[][];
  boundingBox: { min: Point; max: Point };
}

export function boundaryRegionContainsPoint(
  region: BoundaryRegionGeometry,
  point: Point
): boolean {
  return profileContainsPoint(
    {
      boundingBox: region.boundingBox,
      outer: { polyline: region.outer },
      holes: region.holes.map((polyline) => ({ polyline }))
    },
    point
  );
}

/** A saved boundary witness must never recover through a weaker identity tier. */
export function resolveBoundaryRegionReference<
  T extends BoundaryRegionGeometry & {
    area: number;
    sourceBoundaryLoops?: BoundaryProvenance;
  }
>(
  reference: {
    sourceBoundaryLoops: BoundaryProvenance;
    sourceArea: number;
    samplePoint: Point;
  },
  regions: readonly T[]
): T {
  let scale = 1;
  for (const region of regions) {
    scale = Math.max(
      scale,
      region.boundingBox.max.x - region.boundingBox.min.x,
      region.boundingBox.max.y - region.boundingBox.min.y
    );
  }
  return resolveBoundaryProfileReference(
    reference,
    regions,
    geometryTolerance(scale),
    boundaryRegionContainsPoint
  );
}
