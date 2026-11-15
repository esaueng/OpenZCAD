/**
 * Boolean and union support: fuse/unify wrappers, shared-volume probes for
 * operation inference, connectivity checks, and the tangent-union offset
 * suggestion. Kernel-facing but stateless; boolean policy (which operation a
 * feature performs) stays with the adapter's build loop.
 */
import type { RemusKernel } from './remus-runtime';
import type { BodyId } from '@openzcad/shared';
import {
  extrudeBoundsCanShareVolume,
  extrudeVolumeTolerance,
  type ExtrudeInferenceBody
} from './extrude-inference';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import {
  displayTessellationForExtents,
  heldDisplayTessellation
} from './display-tessellation';
import {
  censusOfSolids,
  countFaceConnectedComponents,
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh,
  unifyCopyChecked,
  unionSwallowedCurvature
} from './boolean-result-validation';
import { type KernelUnifyReport, validationReport } from './kernel-validation';
import { AdapterRefusal } from './adapter-refusal';
import { exactBooleanOutcome, exactFuseAll } from './exact-boolean-refusal';
import {
  analyzeUnionConnectivity,
  type UnionBounds
} from './union-connectivity';
import type { ExactShape } from './exact-types';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';
import {
  DIRECT_EDIT_TOLERANCE,
  GEOMETRY_EPSILON,
  transformMatrix
} from './exact-math';

export interface UnionFuseOperand {
  solid: number;
  name: string;
  bounds: UnionBounds;
}

/**
 * A move that turns a faceted union into an exact one, or nothing.
 *
 * The fuse facets where the operands meet tangentially, which for the shapes
 * this workspace makes is almost always an axis or a face sitting exactly in
 * one of the other operand's face planes. That is where a new primitive
 * lands: a box is corner-origin and a cylinder is axis-origin, so creating
 * one of each puts the cylinder's axis on the box's corner edge, and the
 * repair a user reaches for first — slide it along X — keeps the axis in the
 * y = 0 plane and fails again.
 *
 * So the remedy is worth naming exactly rather than describing. Each
 * candidate is TRIED, on copies, and only offered once the fuse it produces
 * is measured exact: a suggestion that does not work is worse than the
 * general advice it replaces, and this is the same reason
 * `acceptedEdgeModifierProbe` probes instead of inferring.
 */
/**
 * Whether one solid tessellates to a closed, consistently oriented mesh —
 * the same question the strict union validation asks later, asked early.
 *
 * It has to be the same question. The refusal copy is emitted once: here if a
 * union is unacceptable, and by the strict pass otherwise. If these two
 * disagree, either a union is refused twice or the proved move never reaches
 * the sentence it belongs to. Both go through `inspectTriangleMeshClosure`
 * with the deflection the display pass picks for the body's own extents.
 */
export function solidMeshIsClosed(kernel: RemusKernel, solid: number): boolean {
  return tessellateAndCheckSolidMesh(kernel, solid, false).closed;
}

function tessellateAndCheckSolidMesh(
  kernel: RemusKernel,
  solid: number,
  retainForMeasurement: boolean,
  heldLinearDeflection?: number
): { closed: boolean; displayMesh?: UnionDisplayMeshPayload } {
  try {
    const bounds = kernel.boundingBox(solid);
    // The same deflection rule as the measurement pass, so the projection
    // retained here is the one measurement asks for.
    const tessellation = heldDisplayTessellation(
      displayTessellationForExtents(
        bounds[3]! - bounds[0]!,
        bounds[4]! - bounds[1]!,
        bounds[5]! - bounds[2]!
      ),
      heldLinearDeflection
    );
    const mesh = kernel.tessellateSolidGroupedBinary(
      solid,
      tessellation.linearDeflection,
      tessellation.angularDeflection
    );
    try {
      const positions = mesh.positions;
      const indices = mesh.indices;
      const closed = isClosedConsistentlyOrientedMesh(
        inspectTriangleMeshClosure(positions, indices)
      );
      if (!closed || !retainForMeasurement) return { closed };
      try {
        const faceOffsets = mesh.faceOffsets;
        const bytes =
          positions.byteLength + indices.byteLength + faceOffsets.byteLength;
        if (bytes > MAX_RETAINED_UNION_DISPLAY_MESH_BYTES) return { closed };
        return {
          closed,
          displayMesh: {
            kernel,
            solid,
            linearDeflection: tessellation.linearDeflection,
            angularDeflection: tessellation.angularDeflection,
            positions: positions.slice(),
            indices: indices.slice(),
            faceOffsets: faceOffsets.slice(),
            bytes
          }
        };
      } catch {
        // Reuse is optional; an allocation failure must not reject good geometry.
        return { closed };
      }
    } finally {
      mesh.free();
    }
  } catch {
    // A body that cannot even be tessellated is not one to offer a move for.
    return { closed: false };
  }
}

export function exactUnionOffsetSuggestion(
  kernel: RemusKernel,
  operands: readonly UnionFuseOperand[],
  units: string
): string | null {
  if (operands.length !== 2) {
    return null;
  }
  const [anchor, mover] = operands as [UnionFuseOperand, UnionFuseOperand];
  const centre = (bounds: UnionBounds, axis: 'x' | 'y' | 'z') =>
    (bounds.min[axis] + bounds.max[axis]) / 2;
  const axes = ['x', 'y', 'z'] as const;
  const toCentre = {
    x: centre(anchor.bounds, 'x') - centre(mover.bounds, 'x'),
    y: centre(anchor.bounds, 'y') - centre(mover.bounds, 'y'),
    z: centre(anchor.bounds, 'z') - centre(mover.bounds, 'z')
  };
  // One axis first, because a single number is the easiest move to carry out.
  // A ball or a ring created against the box's corner needs all three before
  // it sits anywhere clean, so the combined move is tried after them.
  const candidates: { x: number; y: number; z: number }[] = [
    ...axes.map((axis) => ({
      x: axis === 'x' ? toCentre.x : 0,
      y: axis === 'y' ? toCentre.y : 0,
      z: axis === 'z' ? toCentre.z : 0
    })),
    toCentre
  ];
  const operandCensus = censusOfSolids(kernel, [anchor.solid, mover.solid]);
  const format = (value: number) => {
    const rounded = Number(
      Math.abs(value) < 1 ? value.toFixed(3) : value.toFixed(2)
    );
    return `${rounded > 0 ? '+' : ''}${rounded}`;
  };
  for (const offset of candidates) {
    const moves = axes.filter(
      (axis) => Math.abs(offset[axis]) > GEOMETRY_EPSILON
    );
    if (moves.length === 0) {
      continue;
    }
    let candidate: number;
    let verdict: StrictUnionVerdict;
    try {
      const moved = kernel.copySolid(mover.solid);
      kernel.transformSolid(
        moved,
        transformMatrix(offset, { x: 0, y: 0, z: 0 })
      );
      // Through the union gate, the same call the real union makes, not a
      // bare `fuseAll`. The unification step it adds is not cosmetic: without
      // it a candidate can fail the solid check below that the actual edit
      // would have accepted, and the probe then reports no move exists when
      // one plainly does. The gate's verdict is that solid check.
      ({ solid: candidate, verdict } = fuseUniformSolidChecked(kernel, [
        kernel.copySolid(anchor.solid),
        moved
      ]));
    } catch {
      continue;
    }
    // A candidate that swallows the mover inside the anchor loses every
    // curved face, so it is rejected rather than offered as a move that makes
    // the user's new body disappear. The kernel's own exact-only refusal
    // covers the case this check used to share with it — a silently faceted
    // fuse — which is why only the swallowing half remains.
    if (
      unionSwallowedCurvature({
        operands: operandCensus,
        result: censusOfSolids(kernel, [candidate])
      })
    ) {
      continue;
    }
    // And it has to be a solid. Losing the mover is not the only way a
    // tangency fails, so clearing the curvature check alone would let this
    // offer a move that trades one refusal for the other — worse than the
    // general advice it replaces, which is the one thing this must never be.
    if (verdictRefusesUnion(verdict)) {
      continue;
    }
    const described = moves
      .map(
        (axis) => `${format(offset[axis])} ${units} in ${axis.toUpperCase()}`
      )
      .join(', ');
    return `Moving ${mover.name} ${described} clears it.`;
  }
  return null;
}

export function collapseShape(kernel: RemusKernel, shape: ExactShape): number {
  if (shape.solids.length === 0) {
    throw new Error('Exact body contains no solids.');
  }
  return shape.solids.length === 1
    ? shape.solids[0]!
    : fuseUniformSolid(kernel, shape.solids);
}

/**
 * Boolean union can leave adjacent coplanar faces split along the source-solid
 * boundary. The result is one valid solid, but those fragments render as false
 * seams and make a manufactured part look assembled from separate plates.
 * Remus unifies only faces on the same underlying surface, so real part
 * boundaries, holes, blends, and sharp corners remain intact.
 */
export function unifyBooleanFaces(kernel: RemusKernel, solid: number): number {
  kernel.unifyFaces(solid);
  return solid;
}

/**
 * Unification is accepted only on both halves of the union gate: a strict
 * topological solid AND a closed viewport projection. Merging the wall pieces
 * of a boss standing on a shaft's base can hand back a solid that still
 * validates while its tessellation is open along the merged notch; accepting
 * it on validation alone sent a perfectly good raw union to the strict pass
 * as "open, non-manifold, or inconsistently oriented".
 *
 * The strict half is the kernel's own verdict from `unifyFacesChecked`; see
 * {@link unifyUnionFacesChecked}, which this returns the solid of.
 */
export function unifyUnionFaces(
  kernel: RemusKernel,
  solid: number,
  onAccepted?: (solid: number) => void
): number {
  return unifyUnionFacesChecked(kernel, solid, onAccepted).solid;
}

/**
 * What the union gate learned about a solid while producing it, so the
 * later checks on the same handle (the union refusal, the strict
 * measurement pass) reuse the verdict instead of validating a NURBS-heavy
 * body again. `meshClosed` stays undefined when it was never needed: a
 * solid whose strict validation already failed is refused without
 * tessellating it.
 */
export interface StrictUnionVerdict {
  /** Strict validation error count of exactly this handle. */
  strictErrors: number;
  /** Whether its display projection was closed and consistently oriented. */
  meshClosed?: boolean;
  /** Same-sync JS-owned projection from the closure check, when within budget. */
  displayMesh?: UnionDisplayMeshPayload;
}

/** Copied grouped projection retained only until its same-sync measurement. */
export interface UnionDisplayMeshPayload {
  readonly kernel: RemusKernel;
  readonly solid: number;
  readonly linearDeflection: number;
  readonly angularDeflection: number;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly faceOffsets: Uint32Array;
  readonly bytes: number;
}

/** A mesh-like view for measurement; its buffers are JS-owned. */
export interface ReusableUnionDisplayMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly faceOffsets: Uint32Array;
  free(): void;
}

const MAX_RETAINED_UNION_DISPLAY_MESH_BYTES = 8 * 1024 * 1024;

interface UnionMeshBudget {
  retainedBytes: number;
}

const verdictBudgets = new WeakMap<object, UnionMeshBudget>();
const payloadBudgets = new WeakMap<UnionDisplayMeshPayload, UnionMeshBudget>();

function releaseUnionDisplayMesh(
  payload: UnionDisplayMeshPayload | undefined
): void {
  if (!payload) return;
  const budget = payloadBudgets.get(payload);
  if (!budget) return;
  budget.retainedBytes -= payload.bytes;
  payloadBudgets.delete(payload);
}

/** Per-sync verdict map with a single 8 MiB cap across all union projections. */
export class UnionVerdictsWithMeshBudget extends Map<
  number,
  StrictUnionVerdict
> {
  constructor() {
    super();
    verdictBudgets.set(this, { retainedBytes: 0 });
  }

  override set(key: number, verdict: StrictUnionVerdict): this {
    const budget = verdictBudgets.get(this)!;
    releaseUnionDisplayMesh(this.get(key)?.displayMesh);
    const payload = verdict.displayMesh;
    if (payload) {
      if (
        budget.retainedBytes + payload.bytes >
        MAX_RETAINED_UNION_DISPLAY_MESH_BYTES
      ) {
        verdict.displayMesh = undefined;
      } else {
        budget.retainedBytes += payload.bytes;
        payloadBudgets.set(payload, budget);
      }
    }
    return super.set(key, verdict);
  }

  override delete(key: number): boolean {
    releaseUnionDisplayMesh(this.get(key)?.displayMesh);
    return super.delete(key);
  }

  override clear(): void {
    for (const verdict of this.values())
      releaseUnionDisplayMesh(verdict.displayMesh);
    super.clear();
  }
}

/** Takes a matching same-sync projection and gives measurement a no-op-free view. */
export function takeUnionDisplayMeshForMeasurement(
  verdict: StrictUnionVerdict | undefined,
  kernel: RemusKernel,
  solid: number,
  linearDeflection: number,
  angularDeflection: number
): ReusableUnionDisplayMesh | undefined {
  const cached = verdict?.displayMesh;
  if (
    !cached ||
    cached.kernel !== kernel ||
    cached.solid !== solid ||
    cached.linearDeflection !== linearDeflection ||
    cached.angularDeflection !== angularDeflection ||
    cached.bytes > MAX_RETAINED_UNION_DISPLAY_MESH_BYTES
  ) {
    return undefined;
  }
  verdict.displayMesh = undefined;
  releaseUnionDisplayMesh(cached);
  return {
    positions: cached.positions,
    indices: cached.indices,
    faceOffsets: cached.faceOffsets,
    free() {}
  };
}

/** A union result together with the verdict its gate established. */
export interface UnifiedUnion {
  solid: number;
  verdict: StrictUnionVerdict;
}

/**
 * The union gate, decided by the kernel's unification report.
 *
 * Healing runs on a copy (`unifyCopyChecked`), and `unifyFacesChecked`
 * validates the raw solid before merging and the candidate after, so
 * accepting or refusing the candidate needs no `validateSolid` call of its
 * own. The adapter used to ask `validateSolid` about the unified copy, then
 * about the raw union, then once more in the measurement pass — the same
 * strict validation of one body up to five times per rebuild.
 *
 * Acceptance: the copy is adopted when the kernel kept a merge
 * (`facesMerged > 0`, not `reverted`), the result is strict
 * (`resultErrors === 0`), and its display projection is closed. Anything
 * else leaves the raw union standing with the kernel's verdict on it
 * (`inputErrors`). A copy that merged nothing, or whose merge was rolled
 * back, is the raw solid again, so keeping the raw handle ships the same
 * body.
 */
export function unifyUnionFacesChecked(
  kernel: RemusKernel,
  rawSolid: number,
  onAccepted?: (solid: number) => void,
  retainDisplayMesh = false,
  heldLinearDeflection?: number
): UnifiedUnion {
  const unified = unifyCopyChecked(kernel, rawSolid);
  if (unified === null) {
    // The kernel threw instead of reporting, so nothing was measured: the
    // raw union stands and still needs its one strict verdict for the
    // refusal and the measurement pass.
    return rawUnionWithVerdict(
      kernel,
      rawSolid,
      validationReport(kernel, rawSolid).errorCount,
      retainDisplayMesh,
      heldLinearDeflection
    );
  }
  return unifyUnionFacesWithVerdict(
    kernel,
    rawSolid,
    unified.report,
    unified.candidate,
    onAccepted,
    retainDisplayMesh,
    heldLinearDeflection
  );
}

/**
 * Core of `unifyUnionFacesChecked` with the report supplied separately, so
 * tests can pin the verdict mapping without a kernel. `healedCopy` is the
 * copy the checked call unified; the gate adopts it only when it also
 * passes the closed-projection half.
 */
export function unifyUnionFacesWithVerdict(
  kernel: RemusKernel,
  rawSolid: number,
  report: KernelUnifyReport,
  healedCopy: number,
  onAccepted?: (solid: number) => void,
  retainDisplayMesh = false,
  heldLinearDeflection?: number
): UnifiedUnion {
  if (!report.reverted && report.facesMerged > 0 && report.resultErrors === 0) {
    const closure = tessellateAndCheckSolidMesh(
      kernel,
      healedCopy,
      retainDisplayMesh,
      heldLinearDeflection
    );
    if (closure.closed) {
      onAccepted?.(healedCopy);
      return {
        solid: healedCopy,
        verdict: {
          strictErrors: 0,
          meshClosed: true,
          ...(closure.displayMesh ? { displayMesh: closure.displayMesh } : {})
        }
      };
    }
  }
  // The merge was declined, reverted, not strict, or opened the projection:
  // the raw solid stands with the kernel's own verdict on it.
  return rawUnionWithVerdict(
    kernel,
    rawSolid,
    report.inputErrors,
    retainDisplayMesh,
    heldLinearDeflection
  );
}

/** The raw union kept, with its projection measured only when it is strict. */
function rawUnionWithVerdict(
  kernel: RemusKernel,
  rawSolid: number,
  strictErrors: number,
  retainDisplayMesh: boolean,
  heldLinearDeflection?: number
): UnifiedUnion {
  const closure =
    strictErrors === 0
      ? tessellateAndCheckSolidMesh(
          kernel,
          rawSolid,
          retainDisplayMesh,
          heldLinearDeflection
        )
      : undefined;
  return {
    solid: rawSolid,
    verdict: {
      strictErrors,
      ...(closure
        ? {
            meshClosed: closure.closed,
            ...(closure.displayMesh ? { displayMesh: closure.displayMesh } : {})
          }
        : {})
    }
  };
}

/** `fuseUniformSolid` that returns the gate's verdict with the solid. */
export function fuseUniformSolidChecked(
  kernel: RemusKernel,
  solids: number[],
  labels?: readonly string[],
  onAccepted?: (solid: number) => void,
  retainDisplayMesh = false,
  heldLinearDeflection?: number
): UnifiedUnion {
  return unifyUnionFacesChecked(
    kernel,
    // `exactFuseAll` refuses by name on a non-exact pair; only a fused
    // solid reaches the gate.
    fuseAllMergingFaceContacts(kernel, solids, labels),
    onAccepted,
    retainDisplayMesh,
    heldLinearDeflection
  );
}

/** Retire a scratch solid; a failed release never replaces the result. */
function releaseScratchSolid(kernel: RemusKernel, solid: number): void {
  try {
    kernel.deleteSolid(solid);
  } catch {
    // An arena handle that could not be retired is a leak, not an error.
  }
}

/**
 * A solid's boundary split into face-connected components — exact, from the
 * kernel's edge-to-face map — or null when the kernel cannot describe it.
 */
export function faceComponentsOf(
  kernel: RemusKernel,
  solid: number
): number[][] | null {
  try {
    const faces = Array.from<number>(kernel.getSolidFaces(solid));
    const edgeToFaces = JSON.parse(kernel.edgeToFaceMap(solid)) as Record<
      string,
      number[]
    >;
    const parent = new Map(faces.map((face) => [face, face]));
    const root = (face: number): number => {
      let current = face;
      while (parent.get(current) !== current) current = parent.get(current)!;
      return current;
    };
    for (const adjacent of Object.values(edgeToFaces)) {
      for (const face of adjacent.slice(1)) {
        if (!parent.has(face) || !parent.has(adjacent[0]!)) continue;
        const left = root(adjacent[0]!);
        const right = root(face);
        if (left !== right) parent.set(right, left);
      }
    }
    const groups = new Map<number, number[]>();
    for (const face of faces) {
      const component = root(face);
      groups.set(component, [...(groups.get(component) ?? []), face]);
    }
    return [...groups.values()];
  } catch {
    return null;
  }
}

/** Operand count of one contact group above which no repair is attempted. */
export const MAX_CONTACT_REPAIR_OPERANDS = 12;

/**
 * Triangles one certification may tessellate, refinements included. Past it
 * the certification fails, and with it the union: cost is bounded, and the
 * bound fails closed.
 */
export const MAX_CERTIFY_TRIANGLES = 400_000;

/** Positional tolerance as a fraction of the body's own extent. */
const EXTENT_TOLERANCE_RATIO = 1e-7;
/** Volume slack: a fraction of the SMALLEST operand's volume ... */
const SMALLEST_OPERAND_VOLUME_RATIO = 1e-6;
/** ... floored by what the kernel's volume can resolve on the whole body. */
const BODY_VOLUME_RESOLUTION = 1e-11;

/** A point strictly inside an operand, and the clearance it was found with. */
interface InteriorWitness {
  readonly point: readonly [number, number, number];
  readonly tolerance: number;
}

function boxExtent(box: readonly number[]): number {
  return Math.hypot(box[3]! - box[0]!, box[4]! - box[1]!, box[5]! - box[2]!);
}

/** Tolerance for positions on a body of this box: relative to its size. */
function extentTolerance(box: readonly number[]): number {
  return Math.max(boxExtent(box) * EXTENT_TOLERANCE_RATIO, Number.MIN_VALUE);
}

/**
 * A point strictly inside `solid`, or null when none is found: the interior
 * grid of its box first, then a point a small step inside the largest
 * triangle of each planar face, at steps down to 1e-5 of the solid's extent.
 * The planar face is tessellated at a deflection of 1e-6 of the extent, so
 * the triangle lies inside a ring only a few µm wide rather than across it.
 */
export function operandInteriorWitness(
  kernel: RemusKernel,
  solid: number
): InteriorWitness | null {
  const grid = sharedInteriorPoint(kernel, solid, solid);
  const box = Array.from<number>(kernel.boundingBox(solid));
  const extent = boxExtent(box);
  if (grid) {
    const spans = [0, 1, 2].map((axis) => box[axis + 3]! - box[axis]!);
    return {
      point: grid,
      tolerance: Math.min(
        DIRECT_EDIT_TOLERANCE * Math.max(1, ...box.map(Math.abs)),
        Math.min(...spans) / 8
      )
    };
  }
  const deflection = Math.min(MEASUREMENT_DEFLECTION, extent * 1e-6);
  for (const face of Array.from<number>(kernel.getSolidFaces(solid))) {
    if (kernel.getSurfaceType(face) !== 'plane') continue;
    const mesh = kernel.tessellateFace(face, deflection);
    let best: { centre: number[]; normal: number[]; area: number } | null =
      null;
    try {
      const p = mesh.positions;
      const index = mesh.indices;
      for (let t = 0; t + 2 < index.length; t += 3) {
        const [a, b, c] = [index[t]! * 3, index[t + 1]! * 3, index[t + 2]! * 3];
        const u = [0, 1, 2].map((axis) => p[b + axis]! - p[a + axis]!);
        const v = [0, 1, 2].map((axis) => p[c + axis]! - p[a + axis]!);
        const n = [
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!
        ];
        const area = Math.hypot(n[0]!, n[1]!, n[2]!) / 2;
        if (area > (best?.area ?? 0)) {
          best = {
            centre: [0, 1, 2].map(
              (axis) => (p[a + axis]! + p[b + axis]! + p[c + axis]!) / 3
            ),
            normal: n.map((value) => value / (2 * area)),
            area
          };
        }
      }
    } finally {
      mesh.free();
    }
    if (!best) continue;
    for (const ratio of [1e-3, 1e-5]) {
      const step = extent * ratio;
      const point = [0, 1, 2].map(
        (axis) => best.centre[axis]! - best.normal[axis]! * step
      ) as [number, number, number];
      // The clearance stays far below the step: a 0.01 mm wall cannot be
      // cleared by a quarter of a 0.04 mm step.
      const clearance = step / 1000;
      if (insideExactly(kernel, solid, point, clearance)) {
        return { point, tolerance: clearance };
      }
    }
  }
  return null;
}

/** One boundary component's display triangles, about a local origin. */
interface ComponentMesh {
  readonly faces: readonly number[];
  readonly deflection: number;
  /** Nine coordinates per triangle, relative to the certification origin. */
  readonly triangles: Float64Array;
  /** 1 where the triangle lies on a curved face (a chord, not the surface). */
  readonly curved: Uint8Array;
  readonly low: readonly [number, number, number];
  readonly high: readonly [number, number, number];
}

/** Tessellates one component, or null once `budget` would be exceeded. */
function tessellateComponent(
  kernel: RemusKernel,
  faces: readonly number[],
  deflection: number,
  origin: readonly [number, number, number],
  budget: { triangles: number }
): ComponentMesh | null {
  const chunks: { coordinates: number[]; curved: boolean }[] = [];
  let count = 0;
  for (const face of faces) {
    const curved = kernel.getSurfaceType(face) !== 'plane';
    const mesh = kernel.tessellateFace(face, deflection);
    try {
      const p = mesh.positions;
      const index = mesh.indices;
      const triangles = Math.floor(index.length / 3);
      budget.triangles -= triangles;
      if (budget.triangles < 0) return null;
      const coordinates: number[] = new Array<number>(triangles * 9);
      for (let t = 0; t < triangles; t += 1) {
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = index[t * 3 + corner]! * 3;
          for (let axis = 0; axis < 3; axis += 1) {
            coordinates[t * 9 + corner * 3 + axis] =
              p[vertex + axis]! - origin[axis]!;
          }
        }
      }
      chunks.push({ coordinates, curved });
      count += triangles;
    } finally {
      mesh.free();
    }
  }
  const triangles = new Float64Array(count * 9);
  const curvedFlags = new Uint8Array(count);
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let offset = 0;
  for (const chunk of chunks) {
    triangles.set(chunk.coordinates, offset * 9);
    curvedFlags.fill(
      chunk.curved ? 1 : 0,
      offset,
      offset + chunk.coordinates.length / 9
    );
    for (let index = 0; index < chunk.coordinates.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = chunk.coordinates[index + axis]!;
        low[axis] = Math.min(low[axis]!, value);
        high[axis] = Math.max(high[axis]!, value);
      }
    }
    offset += chunk.coordinates.length / 9;
  }
  return { faces, deflection, triangles, curved: curvedFlags, low, high };
}

/**
 * Distance from the origin to the triangle (a, b, c): the closest point by
 * Voronoi region of the triangle (Ericson, Real-Time Collision Detection
 * §5.1.5), so long sliver triangles on a cylinder wall are measured as they
 * are rather than by a bounding sphere.
 */
function originTriangleDistance(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  // p − a with p at the origin.
  const apx = -ax;
  const apy = -ay;
  const apz = -az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(ax, ay, az);
  const bpx = -bx;
  const bpy = -by;
  const bpz = -bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(ax + v * abx, ay + v * aby, az + v * abz);
  }
  const cpx = -cx;
  const cpy = -cy;
  const cpz = -cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(ax + w * acx, ay + w * acy, az + w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return Math.hypot(
      bx + w * (cx - bx),
      by + w * (cy - by),
      bz + w * (cz - bz)
    );
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return Math.hypot(
    ax + abx * v + acx * w,
    ay + aby * v + acy * w,
    az + abz * v + acz * w
  );
}

/**
 * The winding number of the closed component mesh about `point` (Van
 * Oosterom–Strackee solid angles), and how near the point comes to a curved
 * triangle: a lower bound on its distance to the nearest one.
 *
 * Outward-wound triangles give +1 for a point inside the material a
 * component bounds and 0 outside it; a cavity's component is wound into the
 * void, so a point in the surrounding material is outside it and gets 0.
 * `nearestCurved` is the exact distance to the nearest curved triangle,
 * `nearest` to the nearest triangle of any kind.
 */
function componentWinding(
  mesh: ComponentMesh,
  point: readonly [number, number, number]
): { winding: number; nearestCurved: number; nearest: number } {
  const t = mesh.triangles;
  let angle = 0;
  let nearestCurved = Infinity;
  let nearest = Infinity;
  for (let index = 0; index < mesh.curved.length; index += 1) {
    const o = index * 9;
    const ax = t[o]! - point[0];
    const ay = t[o + 1]! - point[1];
    const az = t[o + 2]! - point[2];
    const bx = t[o + 3]! - point[0];
    const by = t[o + 4]! - point[1];
    const bz = t[o + 5]! - point[2];
    const cx = t[o + 6]! - point[0];
    const cy = t[o + 7]! - point[1];
    const cz = t[o + 8]! - point[2];
    const la = Math.hypot(ax, ay, az);
    const lb = Math.hypot(bx, by, bz);
    const lc = Math.hypot(cx, cy, cz);
    const numerator =
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx);
    const denominator =
      la * lb * lc +
      (ax * bx + ay * by + az * bz) * lc +
      (ax * cx + ay * cy + az * cz) * lb +
      (bx * cx + by * cy + bz * cz) * la;
    angle += 2 * Math.atan2(numerator, denominator);
    const distance = originTriangleDistance(ax, ay, az, bx, by, bz, cx, cy, cz);
    nearest = Math.min(nearest, distance);
    if (mesh.curved[index]) nearestCurved = Math.min(nearestCurved, distance);
  }
  return { winding: angle / (4 * Math.PI), nearestCurved, nearest };
}

/**
 * A solid's boundary components, tessellated about one origin, so a point
 * can be located among them by winding number. Components are refined in
 * place when a point comes too near one of their curved chords.
 */
interface WindingSet {
  readonly origin: readonly [number, number, number];
  readonly meshes: ComponentMesh[];
}

/**
 * Triangle allowance shared by everything one pass of the gate tessellates.
 * Exhausting it fails the pass, which fails closed.
 */
interface TriangleBudget {
  triangles: number;
}

function windingSetOf(
  kernel: RemusKernel,
  solid: number,
  budget: TriangleBudget
): WindingSet | null {
  const components = faceComponentsOf(kernel, solid);
  if (components === null) return null;
  const box = kernel.boundingBox(solid);
  const origin = [
    (box[0]! + box[3]!) / 2,
    (box[1]! + box[4]!) / 2,
    (box[2]! + box[5]!) / 2
  ] as const;
  const meshes: ComponentMesh[] = [];
  for (const faces of components) {
    const mesh = tessellateComponent(
      kernel,
      faces,
      MEASUREMENT_DEFLECTION,
      origin,
      budget
    );
    if (mesh === null) return null;
    meshes.push(mesh);
  }
  return { origin, meshes };
}

/**
 * Where `point` sits among a solid's boundary components: the components
 * with a non-zero winding about it (`key`, e.g. `"0:1"`), their total, and
 * the exact distance to the nearest triangle wound (`clearance`). Null when
 * the winding cannot be resolved.
 *
 * A point inside material has total +1, enclosed by the component bounding
 * that material; a cavity winds 0 about the material around it and −1 about
 * a point in its void. Only components whose box holds the point are wound.
 * A point closer to a curved triangle than twice the chord deflection could
 * sit between the mesh and the true surface, so that component alone is
 * tessellated again, finer, down to 1e-7 of its extent; still too close, or
 * past the budget, and the point is unresolved.
 */
function locateAmong(
  kernel: RemusKernel,
  set: WindingSet,
  world: readonly [number, number, number],
  budget: TriangleBudget
): { total: number; key: string; clearance: number } | null {
  const point = [0, 1, 2].map((axis) => world[axis]! - set.origin[axis]!) as [
    number,
    number,
    number
  ];
  const enclosing: string[] = [];
  let total = 0;
  let clearance = Infinity;
  for (let index = 0; index < set.meshes.length; index += 1) {
    let mesh = set.meshes[index]!;
    if (
      [0, 1, 2].some(
        (axis) =>
          point[axis]! < mesh.low[axis]! - 2 * mesh.deflection ||
          point[axis]! > mesh.high[axis]! + 2 * mesh.deflection
      )
    ) {
      continue;
    }
    let reading = componentWinding(mesh, point);
    while (reading.nearestCurved <= 2 * mesh.deflection) {
      const extent = Math.hypot(
        mesh.high[0] - mesh.low[0],
        mesh.high[1] - mesh.low[1],
        mesh.high[2] - mesh.low[2]
      );
      const finer = Math.min(
        mesh.deflection / 8,
        Math.max(reading.nearestCurved, 0) / 4
      );
      if (!(finer >= extent * 1e-7)) return null;
      const refined = tessellateComponent(
        kernel,
        mesh.faces,
        finer,
        set.origin,
        budget
      );
      if (refined === null) return null;
      set.meshes[index] = mesh = refined;
      reading = componentWinding(mesh, point);
    }
    const winding = Math.round(reading.winding);
    if (Math.abs(reading.winding - winding) > 0.25) return null;
    clearance = Math.min(clearance, reading.nearest);
    if (winding !== 0) {
      enclosing.push(`${index}:${winding}`);
      total += winding;
    }
  }
  return { total, key: enclosing.join(','), clearance };
}

/**
 * Clearance a lump witness keeps from every face, per unit of the lump's
 * THINNEST box span — not its diagonal, which on a 1 m plate 0.001 mm thick
 * demanded more clearance than half the plate's thickness allows. Floored at
 * the geometry's linear tolerance so it never reaches zero.
 */
const LUMP_WITNESS_CLEARANCE_RATIO = 1e-6;

/** Candidate points a small step inside each planar face of `faces`. */
function planarStepCandidates(
  kernel: RemusKernel,
  faces: readonly number[],
  extent: number
): [number, number, number][] {
  const deflection = Math.min(MEASUREMENT_DEFLECTION, extent * 1e-6);
  const candidates: [number, number, number][] = [];
  for (const face of faces) {
    if (kernel.getSurfaceType(face) !== 'plane') continue;
    const mesh = kernel.tessellateFace(face, deflection);
    let best: { centre: number[]; normal: number[]; area: number } | null =
      null;
    try {
      const p = mesh.positions;
      const index = mesh.indices;
      for (let t = 0; t + 2 < index.length; t += 3) {
        const [a, b, c] = [index[t]! * 3, index[t + 1]! * 3, index[t + 2]! * 3];
        const u = [0, 1, 2].map((axis) => p[b + axis]! - p[a + axis]!);
        const v = [0, 1, 2].map((axis) => p[c + axis]! - p[a + axis]!);
        const n = [
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!
        ];
        const area = Math.hypot(n[0]!, n[1]!, n[2]!) / 2;
        if (area > (best?.area ?? 0)) {
          best = {
            centre: [0, 1, 2].map(
              (axis) => (p[a + axis]! + p[b + axis]! + p[c + axis]!) / 3
            ),
            normal: n.map((value) => value / (2 * area)),
            area
          };
        }
      }
    } finally {
      mesh.free();
    }
    if (!best) continue;
    for (const ratio of [1e-3, 1e-5]) {
      const step = extent * ratio;
      candidates.push(
        [0, 1, 2].map(
          (axis) => best.centre[axis]! - best.normal[axis]! * step
        ) as [number, number, number]
      );
    }
  }
  return candidates;
}

/**
 * One interior witness per LUMP of material in `solid` — a body of several
 * separate regions gets one in each, and a cavity gets none. Null when a
 * component can be shown neither to bound material nor to be a cavity.
 *
 * A solid in one component is one lump ({@link operandInteriorWitness}).
 * Otherwise each component is probed at the interior grid of its box and a
 * step inside its planar faces: a point inside the solid (exact classifier)
 * that this component alone encloses with winding +1 witnesses its lump; a
 * point it winds −1 shows it is a cavity. A witness must also clear every
 * triangle of the solid by {@link LUMP_WITNESS_CLEARANCE_RATIO} of the
 * lump's thinnest span, and never less than the linear tolerance, so it is
 * never a point that merely grazes a face (a grid point 2e-17 off a cavity
 * wall classified inside, then could not be located against the fuse).
 */
function lumpWitnesses(
  kernel: RemusKernel,
  solid: number,
  budget: TriangleBudget
): InteriorWitness[] | null {
  const components = faceComponentsOf(kernel, solid);
  if (components === null) return null;
  if (components.length <= 1) {
    const witness = operandInteriorWitness(kernel, solid);
    return witness ? [witness] : null;
  }
  const set = windingSetOf(kernel, solid, budget);
  if (set === null) return null;
  const witnesses: InteriorWitness[] = [];
  for (let index = 0; index < set.meshes.length; index += 1) {
    const mesh = set.meshes[index]!;
    const low = mesh.low.map((value, axis) => value + set.origin[axis]!);
    const high = mesh.high.map((value, axis) => value + set.origin[axis]!);
    const extent = Math.hypot(
      high[0]! - low[0]!,
      high[1]! - low[1]!,
      high[2]! - low[2]!
    );
    const clearance = Math.max(
      Math.min(high[0]! - low[0]!, high[1]! - low[1]!, high[2]! - low[2]!) *
        LUMP_WITNESS_CLEARANCE_RATIO,
      GEOMETRY_LINEAR_TOLERANCE
    );
    // The classifier's band stays inside the witness's own clearance: a
    // band of 1e-7 of a 1 m plate's diagonal is wider than a 0.0001 mm plate.
    const tolerance = Math.max(
      Math.min(extent * EXTENT_TOLERANCE_RATIO, clearance),
      Number.MIN_VALUE
    );
    const candidates: [number, number, number][] = [];
    for (const fx of INTERIOR_WITNESS_FRACTIONS) {
      for (const fy of INTERIOR_WITNESS_FRACTIONS) {
        for (const fz of INTERIOR_WITNESS_FRACTIONS) {
          candidates.push([
            low[0]! + (high[0]! - low[0]!) * fx,
            low[1]! + (high[1]! - low[1]!) * fy,
            low[2]! + (high[2]! - low[2]!) * fz
          ]);
        }
      }
    }
    candidates.push(...planarStepCandidates(kernel, mesh.faces, extent));
    let verdict: 'lump' | 'cavity' | null = null;
    for (const point of candidates) {
      const located = locateAmong(kernel, set, point, budget);
      if (located === null) continue;
      if (located.key.split(',').includes(`${index}:-1`)) {
        verdict = 'cavity';
        break;
      }
      if (
        located.total === 1 &&
        located.key === `${index}:1` &&
        located.clearance > clearance &&
        insideExactly(kernel, solid, point, tolerance)
      ) {
        witnesses.push({ point, tolerance });
        verdict = 'lump';
        break;
      }
    }
    if (verdict === null) return null;
  }
  return witnesses.length > 0 ? witnesses : null;
}

/**
 * Two operands proved to share a face or material: `joined` is their exact
 * pairwise fuse when the kernel builds it and it joins them; `shared` a point
 * strictly inside both, when one was found.
 */
interface ContactInterface {
  readonly left: number;
  readonly right: number;
  readonly joined: number | null;
  readonly shared: readonly [number, number, number] | null;
}

/**
 * The operand pairs that touch across an AREA or share material, found
 * cheapest first and only for pairs whose boxes meet:
 *
 * - a point strictly inside both (shared material);
 * - the exact pairwise fuse JOINS them: fewer face-connected components than
 *   the two operands hold together, strictly valid, with exactly their
 *   combined box (extent-relative tolerance);
 * - failing a fuse, a positive exact intersection.
 *
 * A pair touching only at a vertex or along an edge is no interface — no
 * wall can stand on a point or a line, and the fuse leaves its components
 * as they were — so it is left exactly as main leaves it; so is any pair
 * none of these proves. The fuse is kept: it is the reference for which
 * lumps the contact joins.
 */
function contactInterfaces(
  kernel: RemusKernel,
  solids: readonly number[]
): ContactInterface[] {
  const boxes = solids.map((solid) =>
    Array.from<number>(kernel.boundingBox(solid))
  );
  const components = solids.map(
    (solid) => faceComponentsOf(kernel, solid)?.length ?? Infinity
  );
  const interfaces: ContactInterface[] = [];
  for (let left = 0; left < solids.length; left += 1) {
    for (let right = left + 1; right < solids.length; right += 1) {
      const tolerance = Math.max(
        extentTolerance(boxes[left]!),
        extentTolerance(boxes[right]!)
      );
      if (!boxesMeet(boxes[left]!, boxes[right]!, tolerance)) continue;
      const a = solids[left]!;
      const b = solids[right]!;
      const shared = sharedInteriorPoint(kernel, a, b);
      let joined: number | null = null;
      try {
        const outcome = exactBooleanOutcome(kernel, 'fuse', a, b);
        if (outcome.status === 'ok') {
          const union = boxUnion(boxes[left]!, boxes[right]!);
          const box = Array.from<number>(kernel.boundingBox(outcome.solid));
          const unionTolerance = extentTolerance(union);
          if (
            (faceComponentsOf(kernel, outcome.solid)?.length ?? Infinity) <
              components[left]! + components[right]! &&
            validationReport(kernel, outcome.solid).errorCount === 0 &&
            boxWithin(box, union, unionTolerance) &&
            boxWithin(union, box, unionTolerance)
          ) {
            joined = outcome.solid;
          } else {
            releaseScratchSolid(kernel, outcome.solid);
          }
        }
      } catch {
        joined = null;
      }
      const overlapping =
        shared !== null ||
        (joined === null && solidsHavePositiveExactIntersection(kernel, a, b));
      if (joined !== null || overlapping) {
        interfaces.push({ left, right, joined, shared });
      }
    }
  }
  return interfaces;
}

/**
 * The witnesses one interface requires to end up in the same piece: the
 * lumps its pairwise fuse encloses together, read by winding against the
 * fuse. Without a fuse (the kernel refused it on an overlap,
 * esaueng/remus#1742), two single-lump operands and their shared point
 * form the one requirement; anything else cannot be stated and is null.
 * A witness the fuse does not enclose exactly once is null too: the fuse
 * itself lost material.
 */
function interfaceRequirements(
  kernel: RemusKernel,
  contact: ContactInterface,
  lumps: ReadonlyMap<number, readonly InteriorWitness[]>,
  budget: TriangleBudget
): InteriorWitness[][] | null {
  const left = lumps.get(contact.left)!;
  const right = lumps.get(contact.right)!;
  if (contact.joined === null) {
    if (left.length !== 1 || right.length !== 1) return null;
    return [
      [
        left[0]!,
        right[0]!,
        ...(contact.shared
          ? [{ point: contact.shared, tolerance: right[0]!.tolerance }]
          : [])
      ]
    ];
  }
  const set = windingSetOf(kernel, contact.joined, budget);
  if (set === null) return null;
  const classes = new Map<string, InteriorWitness[]>();
  for (const witness of [...left, ...right]) {
    const located = locateAmong(kernel, set, witness.point, budget);
    if (located === null || located.total !== 1) return null;
    classes.set(located.key, [...(classes.get(located.key) ?? []), witness]);
  }
  return [...classes.values()].filter((group) => group.length > 1);
}

/**
 * Whether every requirement holds in `result`: each required witness is
 * enclosed exactly once, and each requirement's witnesses by the same
 * components. A wall left standing in a contact the pairwise fuse merged
 * separates witnesses the fuse enclosed together, so it fails; lumps the
 * contact never joined are never compared, and nothing outside the
 * requirements enters the verdict.
 */
function requirementsHold(
  kernel: RemusKernel,
  result: number,
  requirements: readonly (readonly InteriorWitness[])[],
  budget: TriangleBudget
): boolean {
  if (requirements.length === 0) return true;
  const set = windingSetOf(kernel, result, budget);
  if (set === null) return false;
  return requirements.every((requirement) => {
    let signature: string | null = null;
    for (const witness of requirement) {
      const located = locateAmong(kernel, set, witness.point, budget);
      if (located === null || located.total !== 1) return false;
      if (signature === null) signature = located.key;
      else if (located.key !== signature) return false;
    }
    return true;
  });
}

/** A contact group: operands joined by interfaces, and their lumps. */
interface ContactGroup {
  readonly solids: readonly number[];
  /** Interior witnesses of every lump of every operand, per operand. */
  readonly witnesses: readonly (readonly InteriorWitness[])[];
}

/**
 * Fault injection for tests. Never set outside tests.
 *
 * - `pairwiseFuse`: the repair's pairwise fuse calls this instead of the
 *   kernel, so a test can hand the repair a bad merge and watch the
 *   preservation checks reject it.
 * - `fuseAll`: the union and the repair's `fuseAll` attempts call this
 *   instead of the kernel. Since esaueng/remus#1792 the pinned `fuseAll`
 *   merges cap-to-cap contact itself, so a test stands in a kernel that
 *   leaves touching operands in pieces (esaueng/remus#1738) to keep the
 *   gate's repair and refusal paths covered.
 *
 * The contact proof always reaches the real kernel.
 */
export const contactRepairFaults: {
  pairwiseFuse?: (
    kernel: RemusKernel,
    left: number,
    right: number
  ) => number | null;
  fuseAll?: (kernel: RemusKernel, solids: Uint32Array) => number;
} = {};

interface RepairPart {
  readonly id: number;
  readonly solid: number;
  readonly owned: boolean;
  readonly components: number;
  readonly volume: number;
  readonly box: readonly number[];
  /** Interior witnesses of every operand this part holds. */
  readonly witnesses: readonly InteriorWitness[];
  /** Volume of the smallest operand this part holds. */
  readonly smallest: number;
}

function boxesMeet(
  left: readonly number[],
  right: readonly number[],
  tolerance: number
): boolean {
  return [0, 1, 2].every(
    (axis) =>
      Math.min(left[axis + 3]!, right[axis + 3]!) -
        Math.max(left[axis]!, right[axis]!) >=
      -tolerance
  );
}

/** Whether `inner` lies inside `outer`, to `tolerance`. */
function boxWithin(
  inner: readonly number[],
  outer: readonly number[],
  tolerance: number
): boolean {
  return [0, 1, 2].every(
    (axis) =>
      inner[axis]! >= outer[axis]! - tolerance &&
      inner[axis + 3]! <= outer[axis + 3]! + tolerance
  );
}

/** The smallest box holding both. */
function boxUnion(left: readonly number[], right: readonly number[]): number[] {
  return [0, 1, 2, 3, 4, 5].map((index) =>
    index < 3
      ? Math.min(left[index]!, right[index]!)
      : Math.max(left[index]!, right[index]!)
  );
}

/** Volume slack for a result holding `total`, whose smallest operand is `smallest`. */
function volumeSlack(smallest: number, total: number): number {
  return Math.max(
    SMALLEST_OPERAND_VOLUME_RATIO * Math.abs(smallest),
    BODY_VOLUME_RESOLUTION * Math.abs(total)
  );
}

/**
 * Whether the exact B-rep classifier puts `point` inside `solid`.
 *
 * Witnesses use it alone. The tessellation-based second opinion
 * `strictlyInside` also asks cannot resolve a wall thinner than its chords,
 * so it misses every witness in a 0.01 mm tube. Nothing rests on this
 * classifier by itself: certification winds every witness against the
 * result's own boundary, so a misplaced witness fails closed there.
 */
function insideExactly(
  kernel: RemusKernel,
  solid: number,
  point: readonly [number, number, number],
  tolerance: number
): boolean {
  try {
    return (
      kernel.classifyPoint(solid, point[0], point[1], point[2], tolerance) ===
      'inside'
    );
  } catch {
    return false;
  }
}

/** Whether every witness lies inside `solid` by the exact classifier. */
function holdsWitnesses(
  kernel: RemusKernel,
  solid: number,
  witnesses: readonly InteriorWitness[]
): boolean {
  return witnesses.every((witness) =>
    insideExactly(kernel, solid, witness.point, witness.tolerance)
  );
}

/**
 * Re-fuse one contact group's operands, grouping them rather than folding
 * them in a fixed order.
 *
 * The two fuse entry points fail on complementary contacts. `fuseAll` misses
 * a cylinder cap resting on another cylinder cap (esaueng/remus#1738); the
 * pairwise `fuse` merges that, but refuses two parallel r20 cylinders that
 * overlap by 1 mm or less, whatever their cap planes (esaueng/remus#1742),
 * which `fuseAll` fuses when their caps are shared. A hub of two such bosses
 * standing on a flange needs both, in the right order: no fixed fold of the
 * pairwise fuse builds it, while `fuseAll` of the two bosses, then of that
 * with the flange, does. So pairs merge one at a time — `fuseAll` on any
 * pair first, the pairwise fuse only when no pair merges that way.
 *
 * A merge is counted on exact topology — the candidate has fewer boundary
 * components than its two parts together — and is accepted only if it also
 * PRESERVES their material, judged per operand: a point strictly inside
 * every operand either part holds must be strictly inside the candidate,
 * each part's box must lie inside the candidate's to a tolerance relative to
 * THAT part's size, the candidate's box inside their union's, and its volume
 * between the larger part's and their sum to a slack tied to the smallest
 * operand.
 *
 * Bounded: only pairs whose boxes meet are candidates, at most
 * {@link MAX_CONTACT_REPAIR_OPERANDS} operands are taken, and no pair of
 * parts is tried twice with the same entry point — at most two fuses per
 * pair of parts that ever coexist, O(n²) for n operands.
 *
 * Returns the regrouped solid, owned by the caller, or null when nothing
 * merged.
 */
function regroupTouchingOperands(
  kernel: RemusKernel,
  group: ContactGroup
): number | null {
  let nextId = 0;
  let parts: RepairPart[] = [];
  const describe = (
    solid: number,
    owned: boolean,
    witnesses: readonly InteriorWitness[],
    smallest: number | null
  ): RepairPart | null => {
    const components = faceComponentsOf(kernel, solid);
    if (components === null) return null;
    const volume = kernel.volume(solid, MEASUREMENT_DEFLECTION);
    return {
      id: nextId++,
      solid,
      owned,
      components: components.length,
      volume,
      box: Array.from<number>(kernel.boundingBox(solid)),
      witnesses,
      smallest: smallest ?? volume
    };
  };
  for (let index = 0; index < group.solids.length; index += 1) {
    const part = describe(
      group.solids[index]!,
      false,
      group.witnesses[index]!,
      null
    );
    if (part === null) return null;
    parts.push(part);
  }
  const attempt = (
    strategy: 'fuseAll' | 'fuse',
    left: RepairPart,
    right: RepairPart
  ): number | null => {
    try {
      if (strategy === 'fuseAll') {
        const pair = Uint32Array.from([left.solid, right.solid]);
        return contactRepairFaults.fuseAll
          ? contactRepairFaults.fuseAll(kernel, pair)
          : kernel.fuseAll(pair);
      }
      if (contactRepairFaults.pairwiseFuse) {
        return contactRepairFaults.pairwiseFuse(
          kernel,
          left.solid,
          right.solid
        );
      }
      const outcome = exactBooleanOutcome(
        kernel,
        'fuse',
        left.solid,
        right.solid
      );
      return outcome.status === 'ok' ? outcome.solid : null;
    } catch {
      return null;
    }
  };
  const preserves = (
    part: RepairPart,
    left: RepairPart,
    right: RepairPart
  ): boolean => {
    const union = boxUnion(left.box, right.box);
    const slack = volumeSlack(part.smallest, left.volume + right.volume);
    return (
      boxWithin(left.box, part.box, extentTolerance(left.box)) &&
      boxWithin(right.box, part.box, extentTolerance(right.box)) &&
      boxWithin(part.box, union, extentTolerance(union)) &&
      part.volume >= Math.max(left.volume, right.volume) - slack &&
      part.volume <= left.volume + right.volume + slack &&
      holdsWitnesses(kernel, part.solid, part.witnesses)
    );
  };
  const tried = { fuseAll: new Set<string>(), fuse: new Set<string>() };
  let merges = 0;
  try {
    for (;;) {
      let merged: {
        left: RepairPart;
        right: RepairPart;
        part: RepairPart;
      } | null = null;
      for (const strategy of ['fuseAll', 'fuse'] as const) {
        for (let i = 0; i < parts.length && !merged; i += 1) {
          for (let j = i + 1; j < parts.length && !merged; j += 1) {
            const left = parts[i]!;
            const right = parts[j]!;
            const key = `${left.id}:${right.id}`;
            if (
              tried[strategy].has(key) ||
              !boxesMeet(
                left.box,
                right.box,
                Math.max(extentTolerance(left.box), extentTolerance(right.box))
              )
            ) {
              continue;
            }
            tried[strategy].add(key);
            const solid = attempt(strategy, left, right);
            if (solid === null) continue;
            const part = describe(
              solid,
              true,
              [...left.witnesses, ...right.witnesses],
              Math.min(left.smallest, right.smallest)
            );
            if (
              part !== null &&
              part.components < left.components + right.components &&
              preserves(part, left, right)
            ) {
              merged = { left, right, part };
            } else {
              releaseScratchSolid(kernel, solid);
            }
          }
        }
        if (merged) break;
      }
      if (!merged) break;
      const { left, right, part } = merged;
      for (const spent of [left, right]) {
        if (spent.owned) releaseScratchSolid(kernel, spent.solid);
      }
      parts = [...parts.filter((p) => p !== left && p !== right), part];
      merges += 1;
    }
    if (merges === 0 || parts.length !== 1) return null;
    const only = parts[0]!;
    parts = [];
    return only.solid;
  } catch {
    return null;
  } finally {
    for (const part of parts) {
      if (part.owned) releaseScratchSolid(kernel, part.solid);
    }
  }
}

/**
 * Whether `candidate` holds the same material as the fused result it would
 * replace: every contact-group witness strictly inside it, the same box to a
 * tolerance relative to the body's size, and the same volume to a slack tied
 * to the smallest operand — an internal wall changes none of them.
 */
function sameMaterial(
  kernel: RemusKernel,
  candidate: number,
  fused: number,
  solids: readonly number[],
  witnesses: readonly InteriorWitness[]
): boolean {
  const fusedBox = Array.from<number>(kernel.boundingBox(fused));
  const candidateBox = Array.from<number>(kernel.boundingBox(candidate));
  const tolerance = extentTolerance(fusedBox);
  const fusedVolume = kernel.volume(fused, MEASUREMENT_DEFLECTION);
  const smallest = Math.min(
    ...solids.map((solid) => kernel.volume(solid, MEASUREMENT_DEFLECTION))
  );
  return (
    boxWithin(candidateBox, fusedBox, tolerance) &&
    boxWithin(fusedBox, candidateBox, tolerance) &&
    Math.abs(kernel.volume(candidate, MEASUREMENT_DEFLECTION) - fusedVolume) <=
      volumeSlack(smallest, fusedVolume) &&
    holdsWitnesses(kernel, candidate, witnesses)
  );
}

function unmergedContactRefusal(): AdapterRefusal {
  return new AdapterRefusal(
    'union_unmerged_contact',
    'Union refused: where these bodies only touch face to face, the exact ' +
      'kernel could not merge them, so the result would keep a hidden ' +
      'internal wall. Overlapping them slightly instead usually clears it.'
  );
}

/**
 * `exactFuseAll`, with every proven contact between operands certified as
 * merged — repaired where it is not, refused where it cannot be.
 *
 * WORKAROUND for two Remus defects, to be removed with this function and its
 * helpers once both are fixed upstream and the pin carries the fixes:
 * esaueng/remus#1738 (`fuseAll` leaves cap-to-cap cylinders unmerged) and
 * esaueng/remus#1742 (pairwise `fuse` refuses parallel cylinders overlapping
 * by 1 mm or less). `test/touching-cylinder-union.test.ts` holds the oracles
 * the plain `exactFuseAll` must then pass on its own. #1738 is fixed from
 * Remus 2026.1.141 (esaueng/remus#1768, #1792), whose `fuseAll` merges the
 * contact itself, so on the pin this gate now returns at step 1; it stays
 * until #1742 is fixed too.
 *
 * Before that fix `fuseAll` joined the groups it judged disjoint "directly
 * without a boolean", and that judgement missed planar contact between two
 * cylinder caps — a hub standing exactly on a flange — returning one
 * valid-looking solid that still held both caps: an internal wall the
 * viewport hides and every later face pick, fillet and cut works on.
 *
 * The gate is NARROW and certifies per contact INTERFACE:
 *
 * 1. A result in one face-connected component is returned as it is — main's
 *    behaviour, for the price of an edge-to-face read.
 * 2. Otherwise the operand pairs that touch across an area or share material
 *    are found ({@link contactInterfaces}); a vertex or edge contact is none.
 *    With none, the result is returned as it is: operands in no interface
 *    get no witness, no tessellation and no repair.
 * 3. Each interface states which lumps it joins — those its exact pairwise
 *    fuse encloses together ({@link interfaceRequirements}) — and is
 *    certified when they are enclosed together in the result
 *    ({@link requirementsHold}). Lumps of a compound operand that no contact
 *    joins are never compared.
 * 4. The interfaces' connected groups are the repair scope: a group with a
 *    failing interface is regrouped on its own operands
 *    ({@link regroupTouchingOperands}), and the rebuilt union replaces the
 *    fused one only if it holds the same material ({@link sameMaterial}) and
 *    every interface certifies.
 * 5. Inside an interface the gate fails CLOSED: a lump without a witness, a
 *    requirement that cannot be stated or resolved, the triangle budget, a
 *    group past {@link MAX_CONTACT_REPAIR_OPERANDS}, or a repair that does
 *    not certify refuses the union (`union_unmerged_contact`).
 *
 * Witness agreement is evidence at finitely many points: it shows the
 * contact's lumps are one piece where the witnesses sit, not that no doubled
 * sheet exists anywhere else inside that piece.
 *
 * Kept off `collapseShape`, where a disjoint pattern tool is in pieces by
 * design.
 */
export function fuseAllMergingFaceContacts(
  kernel: RemusKernel,
  solids: readonly number[],
  labels?: readonly string[]
): number {
  const fused = contactRepairFaults.fuseAll
    ? contactRepairFaults.fuseAll(kernel, Uint32Array.from(solids))
    : exactFuseAll(kernel, solids, labels);
  if (solids.length < 2) return fused;
  const components = faceComponentsOf(kernel, fused);
  if (components === null || components.length <= 1) return fused;
  const interfaces = contactInterfaces(kernel, solids);
  if (interfaces.length === 0) return fused;
  const scratch: number[] = interfaces.flatMap((contact) =>
    contact.joined === null ? [] : [contact.joined]
  );
  const refuse = (): never => {
    for (const solid of scratch) releaseScratchSolid(kernel, solid);
    releaseScratchSolid(kernel, fused);
    throw unmergedContactRefusal();
  };
  // What every interface requires, stated once against the pairwise fuses.
  const prepare: TriangleBudget = { triangles: MAX_CERTIFY_TRIANGLES };
  const lumps = new Map<number, InteriorWitness[]>();
  for (const contact of interfaces) {
    for (const index of [contact.left, contact.right]) {
      if (lumps.has(index)) continue;
      const witnesses = lumpWitnesses(kernel, solids[index]!, prepare);
      if (witnesses === null) refuse();
      lumps.set(index, witnesses!);
    }
  }
  const requirements: InteriorWitness[][][] = [];
  for (const contact of interfaces) {
    const stated = interfaceRequirements(kernel, contact, lumps, prepare);
    if (stated === null) refuse();
    requirements.push(stated!);
  }
  for (const solid of scratch.splice(0)) releaseScratchSolid(kernel, solid);
  // The interfaces' connected groups: the scope of any repair.
  const parent = solids.map((_solid, index) => index);
  const root = (index: number): number => {
    let current = index;
    while (parent[current] !== current) current = parent[current]!;
    return current;
  };
  for (const contact of interfaces) {
    parent[root(contact.right)] = root(contact.left);
  }
  const certify = (result: number): boolean[] => {
    const budget: TriangleBudget = { triangles: MAX_CERTIFY_TRIANGLES };
    return requirements.map((stated) =>
      requirementsHold(kernel, result, stated, budget)
    );
  };
  const certified = certify(fused);
  if (certified.every(Boolean)) return fused;
  const failingRoots = new Set(
    interfaces
      .filter((_contact, index) => !certified[index])
      .map((contact) => root(contact.left))
  );
  const failing: ContactGroup[] = [...failingRoots].map((groupRoot) => {
    const members = solids
      .map((_solid, index) => index)
      .filter((index) => root(index) === groupRoot);
    return {
      solids: members.map((index) => solids[index]!),
      witnesses: members.map((index) => lumps.get(index) ?? [])
    };
  });
  for (const group of failing) {
    if (group.witnesses.some((witnesses) => witnesses.length === 0)) refuse();
    const solid =
      group.solids.length <= MAX_CONTACT_REPAIR_OPERANDS
        ? regroupTouchingOperands(kernel, group)
        : null;
    if (solid === null) refuse();
    scratch.push(solid!);
  }
  const replaced = new Set(failing.flatMap((group) => group.solids));
  let rebuilt: number;
  try {
    rebuilt = kernel.fuseAll(
      Uint32Array.from([
        ...scratch,
        ...solids.filter((solid) => !replaced.has(solid))
      ])
    );
  } catch {
    return refuse();
  }
  for (const solid of scratch.splice(0)) releaseScratchSolid(kernel, solid);
  if (
    !sameMaterial(
      kernel,
      rebuilt,
      fused,
      solids,
      failing.flatMap((group) => group.witnesses.flat())
    ) ||
    !certify(rebuilt).every(Boolean)
  ) {
    releaseScratchSolid(kernel, rebuilt);
    return refuse();
  }
  releaseScratchSolid(kernel, fused);
  return rebuilt;
}

/**
 * Whether a union verdict means the body is not an acceptable solid: the
 * same question as "strict errors, or an open display projection",
 * answered from what the gate already measured.
 */
export function verdictRefusesUnion(verdict: StrictUnionVerdict): boolean {
  return verdict.strictErrors !== 0 || verdict.meshClosed !== true;
}

/**
 * Fuse a cluster into one solid, naming the member that refused.
 *
 * `labels` runs parallel to `solids`: a union passes the body names, a
 * pattern passes its instance numbers, and a caller with nothing meaningful
 * to say passes nothing rather than inventing a name.
 */
export function fuseUniformSolid(
  kernel: RemusKernel,
  solids: number[],
  labels?: readonly string[],
  onAccepted?: (solid: number) => void
): number {
  const fused = exactFuseAll(kernel, solids, labels);
  return unifyUnionFaces(kernel, fused, onAccepted);
}

/**
 * Bounds of one face's disposable display projection.
 *
 * Remus's numeric handles are entity-local: a face handle is not a solid
 * handle, even when the two happen to share the same integer. Passing a face
 * to `boundingBox` used to work accidentally while that integer also named a
 * live solid. Tessellating the face is the supported face-level query, and
 * its deflection matches the approximation allowance used by the caller.
 */
export function tessellatedFaceBounds(
  kernel: RemusKernel,
  face: number
): Float64Array {
  const mesh = kernel.tessellateFace(face, MEASUREMENT_DEFLECTION);
  try {
    const bounds = new Float64Array([
      Infinity,
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
      -Infinity
    ]);
    for (let index = 0; index + 2 < mesh.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const coordinate = mesh.positions[index + axis]!;
        bounds[axis] = Math.min(bounds[axis]!, coordinate);
        bounds[axis + 3] = Math.max(bounds[axis + 3]!, coordinate);
      }
    }
    if (!Array.from(bounds).every(Number.isFinite)) {
      throw new Error('The exact kernel returned an empty face projection.');
    }
    return bounds;
  } finally {
    mesh.free();
  }
}

function exactSharedSolidVolume(
  kernel: RemusKernel,
  left: number,
  right: number
): number {
  try {
    const common = kernel.booleanWithQuality('intersect', left, right, true);
    if (common.quality !== 'exact')
      throw new Error('Overlap measurement requires exact geometry.');
    return kernel.volume(common.solid, MEASUREMENT_DEFLECTION);
  } catch (intersectionError) {
    // An empty intersection can be refused by the single-solid API. A
    // successful exact union supplies the same measure by inclusion-exclusion;
    // failure of both constructions remains a refusal, never guessed zero.
    const union = kernel.booleanWithQuality('fuse', left, right, true);
    if (union.quality !== 'exact') throw intersectionError;
    const a = kernel.volume(left, MEASUREMENT_DEFLECTION);
    const b = kernel.volume(right, MEASUREMENT_DEFLECTION);
    const common = a + b - kernel.volume(union.solid, MEASUREMENT_DEFLECTION);
    const tolerance = Math.max(a, b) * 1e-8;
    if (
      !Number.isFinite(common) ||
      common < -tolerance ||
      common > Math.min(a, b) + tolerance
    ) {
      throw new Error('Exact union produced an inconsistent overlap volume.', {
        cause: intersectionError
      });
    }
    return Math.max(0, Math.min(common, a, b));
  }
}

/**
 * How much interior volume these solids share, summed over every pair.
 *
 * Zero means they can be summed safely. A positive figure means summing
 * double-counts, and its SIZE is what tells a caller afterwards whether a
 * fuse actually merged anything — which is why this returns a quantity
 * rather than the boolean the first cut of it returned. By inclusion-
 * exclusion the pairwise total is the exact correction where no three solids
 * share a region and an overestimate where they do, so it is a lower bound on
 * what a successful merge must remove, never an upper one.
 *
 * TOUCHING IS NOT OVERLAPPING, and the distinction is the whole point. Two
 * boxes meeting exactly on a face sum to their true union, so fusing them
 * would change topology and lineage while moving no number; two boxes that
 * interpenetrate are counted twice by any caller that sums per-solid volumes.
 * Only the second case is a defect, so only the second case is reported here.
 *
 * Bounding boxes filter first, so the exact intersect — much the more
 * expensive call, and the one that can throw — runs only on pairs that could
 * possibly share volume. A patterned row's boxes overlap only between
 * neighbours, so the kernel work stays near-linear in the instance count even
 * though the box scan is quadratic.
 *
 * The floor is a fraction of the pair's own bounding diagonal CUBED, not an
 * absolute figure. A volume is L^3: an absolute floor would call a
 * millimetre-scale overlap empty and a kilometre-scale rounding error real.
 * This is the same dimensional mistake this project has now found in the
 * kernel five times, and it is not worth making again here.
 */
export function sharedSolidVolume(
  kernel: RemusKernel,
  solids: number[],
  /** Only callers proving rigid equivalence may reuse an exact intersection. */
  pairClass?: (left: number, right: number) => string
): number {
  if (solids.length < 2) {
    return 0;
  }
  let total = 0;
  const exactByClass = new Map<string, number>();
  const boxes = solids.map((solid) => kernel.boundingBox(solid));
  for (let left = 0; left < solids.length; left += 1) {
    for (let right = left + 1; right < solids.length; right += 1) {
      const a = boxes[left]!;
      const b = boxes[right]!;
      const spans = [0, 1, 2].map(
        (axis) =>
          Math.min(a[axis + 3]!, b[axis + 3]!) - Math.max(a[axis]!, b[axis]!)
      );
      if (spans.some((span) => span <= 0)) {
        continue;
      }
      const diagonal = Math.hypot(
        Math.max(a[3]! - a[0]!, b[3]! - b[0]!),
        Math.max(a[4]! - a[1]!, b[4]! - b[1]!),
        Math.max(a[5]! - a[2]!, b[5]! - b[2]!)
      );
      const floor = diagonal ** 3 * 1e-9;
      // The box overlap is an upper bound on the shared volume, so a pair
      // whose boxes barely graze cannot clear the floor and need not be
      // intersected at all.
      if (spans[0]! * spans[1]! * spans[2]! <= floor) {
        continue;
      }
      let shared: number;
      try {
        const key = pairClass?.(left, right);
        const cached = key === undefined ? undefined : exactByClass.get(key);
        shared =
          cached ??
          exactSharedSolidVolume(kernel, solids[left]!, solids[right]!);
        if (key !== undefined) exactByClass.set(key, shared);
      } catch {
        // A refused intersection is not evidence of disjointness. The boxes
        // already say these two could share volume, so fail toward fusing: a
        // needless fuse costs time, a missed one reports a wrong volume. The
        // box overlap stands in for a figure the kernel would not give.
        total += spans[0]! * spans[1]! * spans[2]!;
        continue;
      }
      if (shared > floor) {
        total += shared;
      }
    }
  }
  return total;
}

export function inferenceBodyForShape(
  kernel: RemusKernel,
  shape: ExactShape,
  bodyId: BodyId,
  name: string
): ExtrudeInferenceBody {
  if (shape.solids.length === 0) {
    throw new Error(`Body "${name}" contains no exact solids.`);
  }
  const boxes = shape.solids.map((solid) => kernel.boundingBox(solid));
  return {
    bodyId,
    name,
    volume: shape.solids.reduce(
      (total, solid) => total + kernel.volume(solid, MEASUREMENT_DEFLECTION),
      0
    ),
    bbox: {
      min: {
        x: Math.min(...boxes.map((box) => box[0]!)),
        y: Math.min(...boxes.map((box) => box[1]!)),
        z: Math.min(...boxes.map((box) => box[2]!))
      },
      max: {
        x: Math.max(...boxes.map((box) => box[3]!)),
        y: Math.max(...boxes.map((box) => box[4]!)),
        z: Math.max(...boxes.map((box) => box[5]!))
      }
    }
  };
}

/**
 * The legacy distance API has no typed refusal twin. Only its explicit
 * certified-family refusal means unknown; malformed values and other errors
 * retain their failure behavior.
 */
export function certifiedSolidDistance(
  kernel: RemusKernel,
  left: number,
  right: number
): number | null {
  let distance: number | undefined;
  try {
    distance = kernel.solidToSolidDistance(left, right)[0];
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        'check: distance computation failed: a certified solid boundary minimum requires complete sphere pairs or straight-edged planar faces (including certified affine NURBS planes)'
    ) {
      return null;
    }
    throw error;
  }
  if (distance === undefined || !Number.isFinite(distance) || distance < 0) {
    throw new Error('The geometry kernel returned an invalid solid distance.');
  }
  return distance;
}

/** Fractions of the box overlap probed for a shared interior point. */
const INTERIOR_WITNESS_FRACTIONS = [0.5, 0.25, 0.75] as const;

function strictlyInside(
  kernel: RemusKernel,
  solid: number,
  point: readonly [number, number, number],
  tolerance: number
): boolean {
  try {
    // `classifyPoint` is the exact B-rep classifier (it resolves a sphere
    // wall to 1e-8 on the pin). `classifyPointRobust` is a tessellation-based
    // second opinion that errs toward "outside" near a curved wall, so
    // requiring both can only miss a witness, never invent one.
    return (
      kernel.classifyPoint(solid, point[0], point[1], point[2], tolerance) ===
        'inside' &&
      kernel.classifyPointRobust(
        solid,
        point[0],
        point[1],
        point[2],
        tolerance
      ) === 'inside'
    );
  } catch {
    return false;
  }
}

/**
 * A point strictly inside both solids, or null. Interiors are open, so
 * such a point proves positive shared volume without measuring it. That
 * matters where the kernel has no certified distance and refuses the exact
 * intersection (a box against a sphere or a 1 µm sliver on the pin), and
 * a gate reading "no proof" as "no contact" called overlapping bodies
 * disconnected. Only the boxes' common region is probed. A tangent or
 * stacked pair has a degenerate common box and never yields a witness, and
 * neither does a pair that merely shares a box.
 */
export function sharedInteriorPoint(
  kernel: RemusKernel,
  left: number,
  right: number
): readonly [number, number, number] | null {
  const a = kernel.boundingBox(left);
  const b = kernel.boundingBox(right);
  const min = [0, 1, 2].map((axis) => Math.max(a[axis]!, b[axis]!));
  const max = [0, 1, 2].map((axis) => Math.min(a[axis + 3]!, b[axis + 3]!));
  const spans = [0, 1, 2].map((axis) => max[axis]! - min[axis]!);
  const scale = Math.max(1, ...[...a, ...b].map((value) => Math.abs(value)));
  const minSpan = Math.min(...spans);
  if (!(minSpan > GEOMETRY_EPSILON * scale)) return null;
  // A point classified inside must clear the boundary by this much, so a
  // witness sits well off both walls rather than on a rounding error.
  const tolerance = Math.min(DIRECT_EDIT_TOLERANCE * scale, minSpan / 8);
  for (const fx of INTERIOR_WITNESS_FRACTIONS) {
    for (const fy of INTERIOR_WITNESS_FRACTIONS) {
      for (const fz of INTERIOR_WITNESS_FRACTIONS) {
        const point = [
          min[0]! + spans[0]! * fx,
          min[1]! + spans[1]! * fy,
          min[2]! + spans[2]! * fz
        ] as const;
        if (
          strictlyInside(kernel, left, point, tolerance) &&
          strictlyInside(kernel, right, point, tolerance)
        ) {
          return point;
        }
      }
    }
  }
  return null;
}

/**
 * Exact proof of shared material, never box overlap: a point strictly inside
 * both solids, or a positive exact intersection.
 */
export function solidsHavePositiveExactIntersection(
  kernel: RemusKernel,
  left: number,
  right: number
): boolean {
  if (sharedInteriorPoint(kernel, left, right) !== null) return true;
  let commonSolid: number | undefined;
  try {
    const common = exactBooleanOutcome(kernel, 'intersect', left, right);
    if (common.status !== 'ok') return false;
    commonSolid = common.solid;
    const volume = kernel.volume(commonSolid, MEASUREMENT_DEFLECTION);
    return Number.isFinite(volume) && volume > 0;
  } catch {
    return false;
  } finally {
    if (
      commonSolid !== undefined &&
      commonSolid !== left &&
      commonSolid !== right
    ) {
      kernel.deleteSolid(commonSolid);
    }
  }
}

/**
 * Whether two solids share material or meet exactly. Unsupported distance
 * stays unknown until exact intersection or validated fused topology proves
 * contact. The unchanged numerical tolerance cannot bridge a real box gap.
 */
export function solidsShareMaterialOrTouch(
  kernel: RemusKernel,
  left: number,
  right: number
): boolean {
  const operands = [left, right].map((solid) => {
    const box = kernel.boundingBox(solid);
    return {
      solid,
      bounds: {
        min: { x: box[0]!, y: box[1]!, z: box[2]! },
        max: { x: box[3]!, y: box[4]!, z: box[5]! }
      }
    };
  });
  const connectivity = analyzeUnionConnectivity(
    operands,
    (a, b) => certifiedSolidDistance(kernel, a, b),
    (a, b) => solidsHavePositiveExactIntersection(kernel, a, b)
  );
  if (connectivity.connected) return true;
  if (!connectivity.uncertain) return false;

  // Unsupported distance and no shared volume can still be exact face
  // contact. The actual exact fuse must be valid, closed, connected and
  // preserve both operands' extents before it can establish that contact.
  let fusedSolid: number | undefined;
  try {
    const fused = exactBooleanOutcome(kernel, 'fuse', left, right);
    if (fused.status !== 'ok') return false;
    fusedSolid = fused.solid;
    if (
      validationReport(kernel, fusedSolid).errorCount !== 0 ||
      !isFaceConnectedSolid(kernel, fusedSolid) ||
      !solidMeshIsClosed(kernel, fusedSolid)
    )
      return false;
    const box = kernel.boundingBox(fusedSolid);
    return operands.every(({ bounds }) =>
      (['x', 'y', 'z'] as const).every(
        (axis, index) =>
          box[index]! <= bounds.min[axis] + connectivity.contactTolerance &&
          box[index + 3]! >= bounds.max[axis] - connectivity.contactTolerance
      )
    );
  } catch {
    return false;
  } finally {
    if (
      fusedSolid !== undefined &&
      fusedSolid !== left &&
      fusedSolid !== right
    ) {
      kernel.deleteSolid(fusedSolid);
    }
  }
}

/** Whether any solid of one shape shares material with or touches the other. */
export function shapesShareMaterialOrTouch(
  kernel: RemusKernel,
  left: ExactShape,
  right: ExactShape
): boolean {
  for (const leftSolid of left.solids) {
    for (const rightSolid of right.solids) {
      if (solidsShareMaterialOrTouch(kernel, leftSolid, rightSolid)) {
        return true;
      }
    }
  }
  return false;
}

/** Exact common material between two body shapes; tangency returns zero. */
export function sharedShapeVolume(
  kernel: RemusKernel,
  left: ExactShape,
  right: ExactShape,
  leftBody: ExtrudeInferenceBody,
  rightBody: ExtrudeInferenceBody,
  /**
   * The volume at or below which the overlap counts as none. Defaults to the
   * scale of both bodies; a caller whose tool carries long empty travel
   * passes the target's own scale instead.
   */
  tolerance: number = extrudeVolumeTolerance(leftBody, rightBody)
): number {
  if (!extrudeBoundsCanShareVolume(leftBody.bbox, rightBody.bbox)) {
    return 0;
  }
  let total = 0;
  for (const leftSolid of left.solids) {
    const leftBox = kernel.boundingBox(leftSolid);
    for (const rightSolid of right.solids) {
      const rightBox = kernel.boundingBox(rightSolid);
      const pairBounds = (box: Float64Array): ExtrudeInferenceBody['bbox'] => ({
        min: { x: box[0]!, y: box[1]!, z: box[2]! },
        max: { x: box[3]!, y: box[4]!, z: box[5]! }
      });
      if (
        !extrudeBoundsCanShareVolume(pairBounds(leftBox), pairBounds(rightBox))
      ) {
        continue;
      }
      try {
        total += Math.max(
          0,
          exactSharedSolidVolume(kernel, leftSolid, rightSolid)
        );
      } catch (error) {
        throw new Error(
          'The exact kernel could not measure extrusion overlap; the stored operation was not changed.',
          { cause: error }
        );
      }
    }
  }
  return total > tolerance ? total : 0;
}

export function isFaceConnectedSolid(
  kernel: RemusKernel,
  solid: number
): boolean {
  try {
    return (
      countFaceConnectedComponents(
        kernel.getSolidFaces(solid),
        JSON.parse(kernel.edgeToFaceMap(solid)) as Record<string, number[]>
      ) === 1
    );
  } catch {
    return false;
  }
}
