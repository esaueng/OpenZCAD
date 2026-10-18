import type { RemusKernel } from './remus-runtime';
import type { FaceGeometry, FaceWitnessV1 } from '@openzcad/shared';
import { measureFaceGeometry } from './exact-measure';
import { quantizeCoordinate } from './topology-fingerprint';

/** Entries kept before the cache starts over; a few drags' worth of faces. */
const DEFAULT_CAPACITY = 8192;

/**
 * Face measurements reused across the frames of a drag preview.
 *
 * Moving one face reshapes only that face and its neighbours, yet every
 * preview frame measured every face again: on the 160-face hammer holder,
 * area integration alone was about 60 ms of a 230 ms frame. A face is reused
 * only when its exact shape inputs match: its ADR-011 witness (surface,
 * analytic parameters, perimeter and vertex centroid), its edge count, every
 * vertex position, and the raw analytic parameters of surfaces the witness
 * does not describe. All are quantized at the geometry tolerance the
 * witnesses already use. B-spline faces are never measured by the preview.
 */
export class PreviewFaceGeometryCache {
  private readonly entries = new Map<string, FaceGeometry | undefined>();
  hits = 0;
  misses = 0;

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  measure(
    kernel: RemusKernel,
    face: number,
    witness: FaceWitnessV1
  ): FaceGeometry | undefined {
    const key = faceShapeKey(kernel, face, witness);
    // Callers decorate what they receive, so each gets its own copy.
    if (this.entries.has(key)) {
      this.hits += 1;
      return structuredClone(this.entries.get(key));
    }
    this.misses += 1;
    const geometry = measureFaceGeometry(kernel, face);
    if (this.entries.size >= this.capacity) this.entries.clear();
    this.entries.set(key, structuredClone(geometry));
    return geometry;
  }

  clear(): void {
    this.entries.clear();
  }
}

function faceShapeKey(
  kernel: RemusKernel,
  face: number,
  witness: FaceWitnessV1
): string {
  const vertices = Array.from(kernel.getFaceVertices(face), (vertex) =>
    Array.from(kernel.getVertexPosition(vertex), quantizeCoordinate).join(',')
  ).sort();
  let parameters = '';
  if (witness.analytic.kind === 'none') {
    try {
      parameters = kernel.getAnalyticSurfaceParams(face);
    } catch {
      parameters = 'unavailable';
    }
  }
  return [
    JSON.stringify(witness),
    kernel.getFaceEdges(face).length,
    vertices.join(';'),
    parameters
  ].join('|');
}
