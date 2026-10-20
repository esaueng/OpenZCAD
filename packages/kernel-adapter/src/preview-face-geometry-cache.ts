import type { RemusKernel } from './remus-runtime';
import type { FaceGeometry, FaceWitnessV1 } from '@openzcad/shared';
import { measureFaceGeometry } from './exact-measure';
import { syncReadMemoFor } from './exact-sync-memo';
import { quantizeCoordinate } from './topology-fingerprint';

/** Entries kept before the cache starts over; a few drags' worth of faces. */
const DEFAULT_CAPACITY = 8192;

/** The kernel reads that identify a face's measurement inputs. */
export type FaceShapeKernel = Pick<
  RemusKernel,
  | 'getFaceVertices'
  | 'getVertexPosition'
  | 'getFaceEdges'
  | 'getAnalyticSurfaceParams'
  | 'getFaceNormal'
  | 'getSurfaceDomain'
  | 'getFaceWires'
  | 'getWireEdges'
  | 'isEdgeForwardInWire'
  | 'getEdgeCurveType'
  | 'getEdgeParamSpan'
  | 'evaluateEdgeCurve'
  | 'getEdgeNurbsData'
>;

/** A face as a drag preview publishes it. */
export interface PreviewFace {
  witness: FaceWitnessV1;
  /** Undefined for B-spline faces, which the preview never measures. */
  geometry: FaceGeometry | undefined;
}

interface FaceDigestBindings {
  faceContentDigests(faces: Uint32Array): string[];
}

/**
 * Remus's exact per-face content digests (esaueng/remus#1188), one per face
 * in order. Null when the kernel predates them or refuses the call; callers
 * then fall back to reading each face.
 */
export function faceContentDigestsOf(
  kernel: RemusKernel,
  faces: Uint32Array
): readonly string[] | null {
  const bindings = kernel as unknown as Partial<FaceDigestBindings>;
  if (typeof bindings.faceContentDigests !== 'function') return null;
  try {
    const digests = bindings.faceContentDigests(faces);
    return digests.length === faces.length ? digests : null;
  } catch {
    return null;
  }
}

/** Fractions of an edge's trimmed span sampled into its signature. */
const EDGE_SAMPLES = [0, 0.25, 0.5, 0.75, 1];

/**
 * Face measurements reused across the frames of a drag preview.
 *
 * Moving one face reshapes only that face and its neighbours, yet every
 * preview frame measured every face again: on the 160-face hammer holder,
 * area integration alone was about 60 ms of a 230 ms frame. A face is reused
 * only when every input its measurement reads matches: its ADR-011 witness
 * (surface, perimeter and vertex centroid), its vertex positions, its
 * boundary, and the oriented values the witness canonicalizes away: the
 * raw analytic parameters, the parameter domain and a plane's oriented
 * normal. Two coincident faces of opposite orientation therefore never share
 * an entry. The boundary is each wire's edges in order with their direction,
 * curve type, five points along the trimmed span and any NURBS definition, so
 * equal-perimeter curves of different shape stay apart. Five points determine
 * any conic (two a line, three a circle) and the NURBS definition the rest, so
 * an edge's length adds nothing; it is not read, because integrating it for
 * every edge of every face cost as much per frame as the measurements the
 * cache saves. Positions are quantized at the geometry tolerance the
 * witnesses already use. B-spline faces are never measured by the preview.
 */
export class PreviewFaceGeometryCache {
  private readonly entries = new Map<string, FaceGeometry | undefined>();
  private readonly byDigest = new Map<string, PreviewFace>();
  hits = 0;
  misses = 0;
  digestHits = 0;

  constructor(
    private readonly capacity = DEFAULT_CAPACITY,
    private readonly measureFace: (
      kernel: RemusKernel,
      face: number
    ) => FaceGeometry | undefined = measureFaceGeometry
  ) {}

  measure(
    kernel: RemusKernel,
    face: number,
    witness: FaceWitnessV1
  ): FaceGeometry | undefined {
    let key: string;
    try {
      key = faceShapeKey(kernel, face, witness);
    } catch {
      // An unreadable boundary (an unsupported imported edge, say) only
      // forgoes reuse: the face is measured cold, as it was before.
      this.misses += 1;
      return this.measureFace(kernel, face);
    }
    // Callers decorate what they receive, so each gets its own copy.
    if (this.entries.has(key)) {
      this.hits += 1;
      return structuredClone(this.entries.get(key));
    }
    this.misses += 1;
    const geometry = this.measureFace(kernel, face);
    if (this.entries.size >= this.capacity) this.entries.clear();
    this.entries.set(key, structuredClone(geometry));
    return geometry;
  }

  /**
   * A face's witness and measurement. Given the face's exact content digest,
   * a face seen before, under any handle, skips the witness, the shape key
   * and the measurement: all of them read only the face's own surface,
   * boundary and vertices, which the digest covers bit for bit.
   */
  describe(
    kernel: RemusKernel,
    face: number,
    digest: string | undefined,
    witnessOf: (kernel: RemusKernel, face: number) => FaceWitnessV1
  ): PreviewFace {
    const known = digest === undefined ? undefined : this.byDigest.get(digest);
    if (known) {
      this.digestHits += 1;
      // As `witnessOf` would have: later reads of this handle share it.
      syncReadMemoFor(kernel)?.recordFaceWitness(face, known.witness);
      return {
        witness: known.witness,
        geometry: structuredClone(known.geometry)
      };
    }
    const witness = witnessOf(kernel, face);
    const geometry =
      witness.surfaceType === 'bspline'
        ? undefined
        : this.measure(kernel, face, witness);
    if (digest !== undefined) {
      if (this.byDigest.size >= this.capacity) this.byDigest.clear();
      this.byDigest.set(digest, {
        witness,
        geometry: structuredClone(geometry)
      });
    }
    return { witness, geometry };
  }

  clear(): void {
    this.entries.clear();
    this.byDigest.clear();
  }
}

/** A kernel read for the key; a refused read is itself part of the key. */
function read(value: () => ArrayLike<number> | string): string {
  try {
    const result = value();
    return typeof result === 'string' ? result : Array.from(result).join(',');
  } catch {
    return 'unavailable';
  }
}

export function faceShapeKey(
  kernel: FaceShapeKernel,
  face: number,
  witness: FaceWitnessV1
): string {
  const vertices = Array.from(kernel.getFaceVertices(face), (vertex) =>
    Array.from(kernel.getVertexPosition(vertex), quantizeCoordinate).join(',')
  ).sort();
  return [
    JSON.stringify(witness),
    kernel.getFaceEdges(face).length,
    vertices.join(';'),
    boundarySignature(kernel, face),
    read(() => kernel.getAnalyticSurfaceParams(face)),
    read(() => kernel.getSurfaceDomain(face)),
    witness.surfaceType === 'plane'
      ? read(() => kernel.getFaceNormal(face))
      : ''
  ].join('|');
}

/** Every wire's edges in order, with the edge data area and centroid read. */
function boundarySignature(kernel: FaceShapeKernel, face: number): string {
  const quantized = (values: ArrayLike<number>) =>
    Array.from(values, quantizeCoordinate).join(',');
  return Array.from(kernel.getFaceWires(face), (wire) =>
    Array.from(kernel.getWireEdges(wire), (edge) => {
      const span = Array.from(kernel.getEdgeParamSpan(edge));
      const samples = EDGE_SAMPLES.map((fraction) =>
        read(() =>
          quantized(
            kernel.evaluateEdgeCurve(
              edge,
              span[0]! + (span[1]! - span[0]!) * fraction
            )
          )
        )
      );
      // A JSON string for NURBS edges, null for analytic ones.
      const nurbs = read(() =>
        JSON.stringify(kernel.getEdgeNurbsData(edge) as unknown)
      );
      return [
        kernel.isEdgeForwardInWire(edge, wire) ? '+' : '-',
        read(() => kernel.getEdgeCurveType(edge)),
        samples.join(' '),
        nurbs
      ].join('/');
    }).join(';')
  )
    .sort()
    .join('#');
}
