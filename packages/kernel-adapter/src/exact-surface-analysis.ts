/**
 * M09 analysis overlays: per-face values the exact kernel evaluates on a
 * body's own surfaces, sampled for the viewport to colour. It runs on the
 * same worker path and build as the M09 clash query (`exact-body-clash.ts`):
 * the adapter hands it the solids of the document it already built, and it
 * asks the kernel only read-only questions. Nothing here reads the display
 * mesh, and no value is ever invented for a sample the kernel refused.
 *
 * Sampling. Each face is tessellated on its own (so colours break cleanly at
 * edges), and every vertex is projected back onto the face's exact surface.
 * The kernel evaluates the analysis at that surface parameter; the overlay
 * vertex is the projected point and its normal the exact outward normal
 * there. A projection that lands farther from the tessellation than the
 * chord tolerance allows is not trusted: the sample is left unevaluated
 * (NaN, drawn neutral) rather than coloured from a point on the wrong part
 * of the surface.
 *
 * Exactness. A value at a sample is the kernel's exact evaluation. A face's
 * range is the range over its samples, which is exact only where the value
 * cannot vary across the face (a plane's draft); elsewhere the true extreme
 * may lie between samples, and the face says so (`exact: false`).
 *
 * Draft: `getFaceDraftAngle` at each sample, against the pull direction,
 * in degrees. Positive opens toward the pull. The minimum draft is not the
 * kernel's concern: the bands (`draftBand` in `@openzcad/shared`) are read
 * from these values by whoever colours them.
 */
import type {
  SurfaceAnalysisBody,
  SurfaceAnalysisFace,
  SurfaceAnalysisRequest,
  SurfaceAnalysisUnsupported
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';

/**
 * Sampling density, relative to the body's size: ten times the display
 * chord ratio. The overlay interpolates between exact samples, so it needs
 * enough of them to show a gradient, not a silhouette-quality mesh.
 */
export const ANALYSIS_LINEAR_DEFLECTION_RATIO = 2e-3;
export const ANALYSIS_ANGULAR_DEFLECTION = 0.12;
/** Samples one body may take before it is refused rather than sampled. */
export const ANALYSIS_MAX_SAMPLES_PER_BODY = 150_000;
/**
 * A projected sample may lie this many chord tolerances from its
 * tessellation vertex; farther, the projection is not trusted.
 */
const PROJECTION_TRUST = 4;
type Box = readonly [number, number, number, number, number, number];

function boxOf(kernel: RemusKernel, solids: readonly number[]): Box {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const solid of solids) {
    const raw = kernel.boundingBox(solid);
    for (let axis = 0; axis < 3; axis += 1) {
      box[axis] = Math.min(box[axis]!, raw[axis]!);
      box[axis + 3] = Math.max(box[axis + 3]!, raw[axis + 3]!);
    }
  }
  return box as unknown as Box;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'The geometry kernel refused the evaluation.';
}

/** The analysis value at one exact surface sample, and its outward normal. */
interface SampleValue {
  value: number;
  normal: readonly [number, number, number];
}

interface Evaluator {
  /** Throws when the kernel cannot evaluate at (u, v). */
  evaluate(face: number, u: number, v: number): SampleValue;
  /** Whether the face's sampled range is its exact range. */
  exactRange(surface: string): boolean;
}

function unit(v: {
  x: number;
  y: number;
  z: number;
}): [number, number, number] {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 0) || !Number.isFinite(length)) {
    throw new Error('The pull direction must be a non-zero vector.');
  }
  return [v.x / length, v.y / length, v.z / length];
}

function evaluatorFor(
  kernel: RemusKernel,
  request: SurfaceAnalysisRequest
): Evaluator {
  const pull = unit(request.pull);
  return {
    evaluate(face, u, v) {
      const raw = kernel.getFaceDraftAngle(
        face,
        u,
        v,
        pull[0],
        pull[1],
        pull[2]
      );
      const parsed = JSON.parse(raw) as {
        angleRadians: number;
        outwardNormal: [number, number, number];
      };
      const value = (parsed.angleRadians * 180) / Math.PI;
      const normal = parsed.outwardNormal;
      if (
        !Number.isFinite(value) ||
        !Array.isArray(normal) ||
        normal.length !== 3 ||
        !normal.every(Number.isFinite)
      ) {
        throw new Error('The kernel returned no draft at this point.');
      }
      return { value, normal: [normal[0], normal[1], normal[2]] };
    },
    // A plane has one normal, so one draft: its range is exact.
    exactRange: (surface) => surface === 'plane'
  };
}

interface FaceSamples {
  positions: number[];
  normals: number[];
  values: number[];
  indices: number[];
}

/**
 * Samples every face of one body's solids. Returns null with an unsupported
 * entry when the body needs more samples than it may take.
 */
export function analyzeBodySurfaces(
  kernel: RemusKernel,
  bodyId: string,
  solids: readonly number[],
  request: SurfaceAnalysisRequest,
  unsupported: SurfaceAnalysisUnsupported[]
): SurfaceAnalysisBody | null {
  const evaluator = evaluatorFor(kernel, request);
  const box = boxOf(kernel, solids);
  const scale = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
  const deflection = Math.max(1e-5, scale * ANALYSIS_LINEAR_DEFLECTION_RATIO);
  const trust = deflection * PROJECTION_TRUST;

  const out: FaceSamples = {
    positions: [],
    normals: [],
    values: [],
    indices: []
  };
  const faces: SurfaceAnalysisFace[] = [];
  let faceIndex = 0;
  let sampleCount = 0;

  for (const solid of solids) {
    for (const face of Array.from(kernel.getSolidFaces(solid))) {
      const index = faceIndex;
      faceIndex += 1;
      let surface = 'unknown';
      try {
        surface = kernel.getSurfaceType(face);
      } catch {
        // Named only for the summary; the samples decide the rest.
      }
      let mesh;
      try {
        mesh = kernel.tessellateFace(
          face,
          deflection,
          ANALYSIS_ANGULAR_DEFLECTION
        );
      } catch (error) {
        unsupported.push({
          bodyId,
          face: index,
          reason: 'kernel-refused',
          message: messageOf(error)
        });
        continue;
      }
      try {
        const positions = mesh.positions;
        const meshNormals = mesh.normals;
        const indices = mesh.indices;
        const vertexCount = positions.length / 3;
        sampleCount += vertexCount;
        if (sampleCount > ANALYSIS_MAX_SAMPLES_PER_BODY) {
          unsupported.push({
            bodyId,
            face: null,
            reason: 'too-many-samples',
            message: `This body needs more than ${ANALYSIS_MAX_SAMPLES_PER_BODY.toLocaleString('en-US')} samples to analyse.`
          });
          return null;
        }
        const base = out.positions.length / 3;
        let min = Infinity;
        let max = -Infinity;
        let evaluated = 0;
        let firstError: string | null = null;
        for (let vertex = 0; vertex < vertexCount; vertex += 1) {
          const x = positions[vertex * 3]!;
          const y = positions[vertex * 3 + 1]!;
          const z = positions[vertex * 3 + 2]!;
          let point: [number, number, number] = [x, y, z];
          let normal: readonly number[] = [
            meshNormals[vertex * 3] ?? 0,
            meshNormals[vertex * 3 + 1] ?? 0,
            meshNormals[vertex * 3 + 2] ?? 1
          ];
          let value = Number.NaN;
          try {
            const projected = kernel.projectPointOnSurface(face, x, y, z);
            const distance = projected[5]!;
            if (
              projected.length < 6 ||
              !Array.from(projected).every(Number.isFinite) ||
              distance > trust
            ) {
              throw new Error(
                'The sample could not be placed on the exact surface.'
              );
            }
            const sample = evaluator.evaluate(
              face,
              projected[0]!,
              projected[1]!
            );
            point = [projected[2]!, projected[3]!, projected[4]!];
            normal = sample.normal;
            value = sample.value;
          } catch (error) {
            firstError ??= messageOf(error);
          }
          out.positions.push(point[0], point[1], point[2]);
          out.normals.push(normal[0]!, normal[1]!, normal[2]!);
          out.values.push(value);
          if (Number.isFinite(value)) {
            evaluated += 1;
            if (value < min) min = value;
            if (value > max) max = value;
          }
        }
        for (const vertex of indices) out.indices.push(base + vertex);
        if (evaluated === 0) {
          unsupported.push({
            bodyId,
            face: index,
            reason: 'kernel-refused',
            message: firstError ?? 'The face has no samples to evaluate.'
          });
          continue;
        }
        if (evaluated < vertexCount) {
          unsupported.push({
            bodyId,
            face: index,
            reason: 'partly-evaluated',
            message: `${vertexCount - evaluated} of ${vertexCount} samples could not be evaluated: ${firstError ?? 'no reason given'}`
          });
        }
        const summary: SurfaceAnalysisFace = {
          face: index,
          surface,
          min,
          max,
          samples: evaluated,
          exact: evaluated === vertexCount && evaluator.exactRange(surface)
        };
        faces.push(summary);
      } finally {
        mesh.free();
      }
    }
  }

  return {
    bodyId,
    positions: Float32Array.from(out.positions),
    normals: Float32Array.from(out.normals),
    indices: Uint32Array.from(out.indices),
    values: Float32Array.from(out.values),
    faces
  };
}
