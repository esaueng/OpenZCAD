/**
 * I03 stored-unit conversion, phase 4: the native orientation of the edges
 * an asymmetric blend is applied to.
 *
 * A stored edge reference identifies an edge by its witness, whose two ends
 * sort by quantized coordinates. Some blends do not read that order. They
 * read the kernel's own:
 *
 * - a variable-radius fillet (`filletVariable`) puts its start radius at the
 *   kernel edge's start vertex, and a selected edge without per-vertex
 *   radii keeps the feature's start → end radii in that direction;
 * - a two-distance chamfer (`chamferV2`) and a distance-angle chamfer take
 *   their first setback off the first of the two faces the kernel lists for
 *   the edge, which follows the edge's native direction.
 *
 * Re-capture matches witnesses, which cannot see either order. If the
 * converted rebuild ran an edge the other way, or listed its faces the other
 * way, the same reference would build the blend mirrored along the edge or
 * across it, and on a symmetric body the totals would not show it. So while
 * a re-capture is running the edge-modifier build reports each asymmetric
 * blend's edges here, and the re-capture refuses unless every edge keeps its
 * native start, end and face order in the converted build.
 */
import type { FaceWitnessV1 } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import { edgeToFaceMapOf } from './exact-sync-memo';
import { faceWitnessOf } from './exact-witnesses';
import { referenceRecaptureHooks } from './reference-recapture-slot';

type Point = readonly [number, number, number];

/** One blended edge, as the kernel orients it, in document units. */
export interface BlendEdgeOrientation {
  /**
   * Native start vertex, the curve at a quarter and three quarters of its
   * parameter span, and native end vertex.
   */
  readonly samples: readonly [Point, Point, Point, Point];
  /** The faces that use the edge, in the kernel's adjacency order. */
  readonly faces: readonly FaceWitnessV1[];
}

/** One asymmetric blend application, reported during a re-capture build. */
export interface BlendOrientationReport {
  /** Within the feature: `selection`, or `pattern copy N` for a repeat. */
  readonly label: string;
  /** What reads the orientation, for the refusal. */
  readonly reads: string;
  readonly edges: readonly BlendEdgeOrientation[];
}

/** The settings a blend reads, as `edgeModifierSettings` resolves them. */
export interface BlendOrientationSettings {
  readonly size: number;
  readonly chamferAngleRadians?: number;
  readonly chamferSecondDistance?: number;
  readonly variableRadius?: { readonly endRadius: number };
  readonly vertexRadii?: readonly unknown[];
  readonly radiusStations?: readonly unknown[];
}

/**
 * What reads the native orientation of a blend's edges, or undefined when
 * nothing does: a constant fillet, an even chamfer, and a variable fillet
 * whose two radii are equal and set for no vertex or station.
 */
export function blendOrientationReads(
  featureKind: 'fillet' | 'chamfer',
  settings: BlendOrientationSettings
): string | undefined {
  if (featureKind === 'fillet') {
    if (!settings.variableRadius) return undefined;
    if (
      settings.variableRadius.endRadius !== settings.size ||
      settings.vertexRadii !== undefined ||
      settings.radiusStations !== undefined
    )
      return 'its start and end radii follow the direction the kernel runs each edge';
    return undefined;
  }
  if (settings.chamferAngleRadians !== undefined)
    return 'its distance and angle are measured from the first face the kernel lists for each edge';
  if (
    settings.chamferSecondDistance !== undefined &&
    settings.chamferSecondDistance !== settings.size
  )
    return 'its two setbacks go on the faces in the order the kernel lists them for each edge';
  return undefined;
}

function pointOf(values: ArrayLike<number>, offset = 0): Point {
  return [values[offset]!, values[offset + 1]!, values[offset + 2]!];
}

/** Measures one edge of `solid` as the kernel orients it. */
export function measureBlendEdgeOrientation(
  kernel: Pick<
    RemusKernel,
    'getEdgeVertices' | 'getEdgeParamSpan' | 'evaluateEdgeCurve'
  >,
  faces: readonly FaceWitnessV1[],
  edge: number
): BlendEdgeOrientation {
  const ends = kernel.getEdgeVertices(edge);
  const span = kernel.getEdgeParamSpan(edge);
  const at = (fraction: number) =>
    pointOf(
      kernel.evaluateEdgeCurve(edge, span[0]! + (span[1]! - span[0]!) * fraction)
    );
  return {
    samples: [pointOf(ends, 0), at(0.25), at(0.75), pointOf(ends, 3)],
    faces
  };
}

/**
 * During a re-capture build, reports the native orientation of `edges` of
 * `solid` when the blend reads it. Does nothing otherwise, so an ordinary
 * build makes no extra kernel call.
 */
export function reportBlendOrientation(
  kernel: RemusKernel,
  solid: number,
  edges: readonly number[],
  featureKind: 'fillet' | 'chamfer',
  settings: BlendOrientationSettings,
  label: string
): void {
  const hooks = referenceRecaptureHooks();
  if (!hooks?.noteBlendOrientation) return;
  const reads = blendOrientationReads(featureKind, settings);
  if (!reads) return;
  const adjacency = edgeToFaceMapOf(kernel, solid);
  hooks.noteBlendOrientation({
    label,
    reads,
    edges: edges.map((edge) =>
      measureBlendEdgeOrientation(
        kernel,
        (adjacency[String(edge)] ?? []).map((face) =>
          faceWitnessOf(kernel, face)
        ),
        edge
      )
    )
  });
}
