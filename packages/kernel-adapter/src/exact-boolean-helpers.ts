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
import { analyzeUnionConnectivity, type UnionBounds } from './union-connectivity';
import type { ExactShape } from './exact-types';
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
  heldLinearDeflection?: number,
  /**
   * How many separate groups the operands form, when the caller has already
   * proved it (the Union feature's connectivity pass). Omitted, the gate
   * works it out itself — and only on the rare path that needs it.
   */
  contactGroups?: number
): UnifiedUnion {
  return unifyUnionFacesChecked(
    kernel,
    // `exactFuseAll` refuses by name on a non-exact pair; only a fused
    // solid reaches the gate.
    fuseAllMergingFaceContacts(kernel, solids, labels, contactGroups),
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
 * What one solid's boundary says about how many pieces of material it holds.
 *
 * `components` is exact: face-connected boundary components from the
 * kernel's edge-to-face map. Each component's sign is judged on its own:
 * `certainPieces` enclose positive volume beyond doubt, `certainCavities`
 * negative, and `uncertain` could be either. `pieces` is the full count, or
 * null while any component is uncertain.
 *
 * Raw components are not pieces. A body with an enclosed cavity has a second
 * boundary component — the void's — and it is legitimate: its faces point
 * into the void, away from the material, so it encloses negative volume. Two
 * pieces of material that should have merged each enclose positive volume.
 */
export interface MaterialCensus {
  readonly components: number;
  readonly certainPieces: number;
  readonly certainCavities: number;
  readonly uncertain: number;
  readonly pieces: number | null;
}

/** Display deflection of a refined pass, relative to the component's extent. */
const REFINED_DEFLECTION_RATIO = 1e-4;

interface ComponentSum {
  volume: number;
  /** Σ over triangles of the determinant's absolute-product permanent / 6. */
  permanent: number;
  triangles: number;
  curvedArea: number;
  deflection: number;
  low: [number, number, number];
  high: [number, number, number];
}

/**
 * Accumulates one face's display triangles into `sum`, about `origin`.
 *
 * Each triangle contributes det(a, b, c) / 6. Alongside it the sum carries
 * what its rounding can be bounded by: the permanent (the determinant with
 * every product made absolute), whose ε multiple bounds the error of
 * evaluating each determinant, and the triangle count, which bounds the
 * error of adding them up (recursive summation of n terms errs by at most
 * γ(n−1) times the sum of their magnitudes, itself at most the permanent).
 */
function accumulateFace(
  kernel: RemusKernel,
  face: number,
  deflection: number,
  origin: readonly [number, number, number],
  sum: ComponentSum
): void {
  const curved = kernel.getSurfaceType(face) !== 'plane';
  const mesh = kernel.tessellateFace(face, deflection);
  try {
    const p = mesh.positions;
    const index = mesh.indices;
    for (let t = 0; t + 2 < index.length; t += 3) {
      const a = index[t]! * 3;
      const b = index[t + 1]! * 3;
      const c = index[t + 2]! * 3;
      const ax = p[a]! - origin[0];
      const ay = p[a + 1]! - origin[1];
      const az = p[a + 2]! - origin[2];
      const bx = p[b]! - origin[0];
      const by = p[b + 1]! - origin[1];
      const bz = p[b + 2]! - origin[2];
      const cx = p[c]! - origin[0];
      const cy = p[c + 1]! - origin[1];
      const cz = p[c + 2]! - origin[2];
      sum.volume +=
        (ax * (by * cz - bz * cy) -
          ay * (bx * cz - bz * cx) +
          az * (bx * cy - by * cx)) /
        6;
      sum.permanent +=
        (Math.abs(ax) * (Math.abs(by * cz) + Math.abs(bz * cy)) +
          Math.abs(ay) * (Math.abs(bx * cz) + Math.abs(bz * cx)) +
          Math.abs(az) * (Math.abs(bx * cy) + Math.abs(by * cx))) /
        6;
      sum.triangles += 1;
      for (const [x, y, z] of [
        [ax, ay, az],
        [bx, by, bz],
        [cx, cy, cz]
      ] as const) {
        sum.low[0] = Math.min(sum.low[0], x);
        sum.low[1] = Math.min(sum.low[1], y);
        sum.low[2] = Math.min(sum.low[2], z);
        sum.high[0] = Math.max(sum.high[0], x);
        sum.high[1] = Math.max(sum.high[1], y);
        sum.high[2] = Math.max(sum.high[2], z);
      }
      if (curved) {
        const ux = bx - ax;
        const uy = by - ay;
        const uz = bz - az;
        const vx = cx - ax;
        const vy = cy - ay;
        const vz = cz - az;
        sum.curvedArea +=
          Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) /
          2;
      }
    }
  } finally {
    mesh.free();
  }
}

/**
 * How far a component's summed volume can be from the enclosed volume of the
 * surface it approximates: floating-point rounding (γ(n+5) times the
 * permanent — five roundings inside each determinant, up to n − 1 in the
 * sum), plus the chord error of curved faces, bounded by the deflection
 * times their area. Planar faces tessellate exactly. The chord term is an
 * engineering bound — the mesh lies within the deflection of the surface —
 * not a certified one.
 */
function componentBand(sum: ComponentSum): number {
  const k = sum.triangles + 5;
  const gamma = (k * Number.EPSILON) / (1 - k * Number.EPSILON);
  return gamma * sum.permanent + sum.curvedArea * sum.deflection;
}

function emptySum(deflection: number): ComponentSum {
  return {
    volume: 0,
    permanent: 0,
    triangles: 0,
    curvedArea: 0,
    deflection,
    low: [Infinity, Infinity, Infinity],
    high: [-Infinity, -Infinity, -Infinity]
  };
}

/**
 * Count a solid's pieces of material. Null only when the kernel cannot
 * describe the boundary at all.
 *
 * Volumes are summed about the body's own box centre rather than the world
 * origin: about the world origin a body parked at (1e7, 1e7, 1e7) sums
 * determinants of order 1e21 to a volume of order 1e5, and cancellation left
 * nothing of the sign. A component whose volume lies inside its band
 * ({@link componentBand}) is measured again at a deflection relative to its
 * OWN extent, so a fine feature — a 0.1 mm pin, a thin tube wall — is judged
 * at its own scale rather than the body's. Only a component still inside its
 * band after that is uncertain, and it is uncertain alone: the other
 * components keep their certain signs.
 *
 * A solid in one component is one piece without tessellating anything, which
 * is every ordinary result.
 */
export function materialCensus(
  kernel: RemusKernel,
  solid: number
): MaterialCensus | null {
  try {
    const faces = Array.from<number>(kernel.getSolidFaces(solid));
    const edgeToFaces = JSON.parse(kernel.edgeToFaceMap(solid)) as Record<
      string,
      number[]
    >;
    const components = countFaceConnectedComponents(faces, edgeToFaces);
    if (components <= 1) {
      return {
        components,
        certainPieces: components,
        certainCavities: 0,
        uncertain: 0,
        pieces: components
      };
    }
    const parent = new Map(faces.map((face) => [face, face]));
    const root = (face: number): number => {
      let current = face;
      while (parent.get(current) !== current) current = parent.get(current)!;
      return current;
    };
    for (const adjacent of Object.values(edgeToFaces)) {
      for (const face of adjacent.slice(1)) {
        const left = root(adjacent[0]!);
        const right = root(face);
        if (left !== right) parent.set(right, left);
      }
    }
    const box = kernel.boundingBox(solid);
    const origin = [
      (box[0]! + box[3]!) / 2,
      (box[1]! + box[4]!) / 2,
      (box[2]! + box[5]!) / 2
    ] as const;
    const facesOf = new Map<number, number[]>();
    for (const face of faces) {
      const component = root(face);
      facesOf.set(component, [...(facesOf.get(component) ?? []), face]);
    }
    let certainPieces = 0;
    let certainCavities = 0;
    let uncertain = 0;
    for (const componentFaces of facesOf.values()) {
      let sum = emptySum(MEASUREMENT_DEFLECTION);
      for (const face of componentFaces) {
        accumulateFace(kernel, face, sum.deflection, origin, sum);
      }
      if (Math.abs(sum.volume) <= componentBand(sum)) {
        const extent = Math.hypot(
          sum.high[0] - sum.low[0],
          sum.high[1] - sum.low[1],
          sum.high[2] - sum.low[2]
        );
        const refined = extent * REFINED_DEFLECTION_RATIO;
        if (refined > 0 && refined < sum.deflection) {
          sum = emptySum(refined);
          for (const face of componentFaces) {
            accumulateFace(kernel, face, refined, origin, sum);
          }
        }
      }
      if (
        !Number.isFinite(sum.volume) ||
        Math.abs(sum.volume) <= componentBand(sum)
      ) {
        uncertain += 1;
      } else if (sum.volume > 0) {
        certainPieces += 1;
      } else {
        certainCavities += 1;
      }
    }
    return {
      components,
      certainPieces,
      certainCavities,
      uncertain,
      pieces: uncertain === 0 ? certainPieces : null
    };
  } catch {
    return null;
  }
}

/** Pieces of material, or null when unknown. See {@link materialCensus}. */
export function solidMaterialPieces(
  kernel: RemusKernel,
  solid: number
): number | null {
  return materialCensus(kernel, solid)?.pieces ?? null;
}

/** Operand count above which the contact repair is not attempted. */
export const MAX_CONTACT_REPAIR_OPERANDS = 12;

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
 * triangle of each planar face (exact, unlike a chord of a curved one), at
 * steps down to 1e-5 of the solid's extent for thin walls.
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
  for (const face of Array.from<number>(kernel.getSolidFaces(solid))) {
    if (kernel.getSurfaceType(face) !== 'plane') continue;
    const mesh = kernel.tessellateFace(face, MEASUREMENT_DEFLECTION);
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
      if (strictlyInside(kernel, solid, point, step / 4)) {
        return { point, tolerance: step / 4 };
      }
    }
  }
  return null;
}

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

/** Whether every witness lies strictly inside `solid`. */
function holdsWitnesses(
  kernel: RemusKernel,
  solid: number,
  witnesses: readonly InteriorWitness[]
): boolean {
  return witnesses.every((witness) =>
    strictlyInside(kernel, solid, witness.point, witness.tolerance)
  );
}

/**
 * Re-fuse operands that `fuseAll` left in more pieces than they should be,
 * grouping them rather than folding them in a fixed order.
 *
 * The two fuse entry points fail on complementary contacts. `fuseAll` misses
 * a cylinder cap resting on another cylinder cap (esaueng/remus#1738); the
 * pairwise `fuse` merges that, but refuses two parallel r20 cylinders that
 * overlap by 1 mm or less, whatever their cap planes (esaueng/remus#1742),
 * which `fuseAll` fuses when their caps are shared. A hub of two such bosses
 * standing on a flange needs both, in the right order: no fixed fold of the
 * pairwise fuse builds it, while `fuseAll` of the two bosses, then of that
 * with the flange, does. So pairs merge one at a time — `fuseAll` on any pair first, the
 * pairwise fuse only when no pair merges that way.
 *
 * A merge is counted on exact topology — the candidate has fewer boundary
 * components than its two parts together — and is accepted only if it also
 * PRESERVES their material, judged per operand rather than against the
 * whole: a point strictly inside every operand either part holds must be
 * strictly inside the candidate, each part's box must lie inside the
 * candidate's to a tolerance relative to THAT part's size, the candidate's
 * box inside their union's, and its volume between the larger part's and
 * their sum to a slack tied to the smallest operand. A candidate that loses a
 * 0.5 mm boss off a 2 m flange at (1e7, 1e7, 1e7) fails the boss's witness,
 * its box and its volume, where coordinate-scaled tolerances passed it.
 *
 * Bounded: only pairs whose boxes meet are candidates, at most
 * {@link MAX_CONTACT_REPAIR_OPERANDS} operands are taken, and no pair of
 * parts is tried twice with the same entry point, so a run costs at most two
 * fuses per pair of parts that ever coexist — O(n²) for n operands — and it
 * runs only when the plain `fuseAll` result is in pieces or cannot be read.
 * An operand with no interior witness cannot be proved preserved, so no
 * regroup is attempted.
 *
 * Returns the regrouped solid, owned by the caller, or null when nothing
 * merged.
 */
function regroupTouchingOperands(
  kernel: RemusKernel,
  solids: readonly number[]
): number | null {
  let nextId = 0;
  let parts: RepairPart[] = [];
  const describe = (
    solid: number,
    owned: boolean,
    witnesses: readonly InteriorWitness[],
    smallest: number | null
  ): RepairPart | null => {
    const census = materialCensus(kernel, solid);
    if (census === null) return null;
    const volume = kernel.volume(solid, MEASUREMENT_DEFLECTION);
    return {
      id: nextId++,
      solid,
      owned,
      components: census.components,
      volume,
      box: Array.from<number>(kernel.boundingBox(solid)),
      witnesses,
      smallest: smallest ?? volume
    };
  };
  for (const solid of solids) {
    const witness = operandInteriorWitness(kernel, solid);
    if (witness === null) return null;
    const part = describe(solid, false, [witness], null);
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
        return kernel.fuseAll(Uint32Array.from([left.solid, right.solid]));
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
    if (merges === 0) return null;
    if (parts.length === 1) {
      const only = parts[0]!;
      parts = [];
      return only.solid;
    }
    // What could not merge stays apart, exactly as `fuseAll` keeps it.
    return kernel.fuseAll(Uint32Array.from(parts.map((part) => part.solid)));
  } catch {
    return null;
  } finally {
    for (const part of parts) {
      if (part.owned) releaseScratchSolid(kernel, part.solid);
    }
  }
}

/** How many separate groups the operands form, or null when uncertain. */
function operandContactGroups(
  kernel: RemusKernel,
  solids: readonly number[]
): number | null {
  try {
    const connectivity = analyzeUnionConnectivity(
      solids.map((solid) => {
        const box = kernel.boundingBox(solid);
        return {
          solid,
          bounds: {
            min: { x: box[0]!, y: box[1]!, z: box[2]! },
            max: { x: box[3]!, y: box[4]!, z: box[5]! }
          }
        };
      }),
      (left, right) => certifiedSolidDistance(kernel, left, right),
      (left, right) =>
        solidsHavePositiveExactIntersection(kernel, left, right) ||
        solidsShareMaterialOrTouch(kernel, left, right)
    );
    return connectivity.uncertain ? null : connectivity.componentCount;
  } catch {
    return null;
  }
}

/**
 * Whether `candidate` holds the same material as the fused result it would
 * replace: every operand's interior witness strictly inside it, the same box
 * to a tolerance relative to the body's size, and the same volume to a slack
 * tied to the smallest operand — an internal wall changes none of them.
 */
function sameMaterial(
  kernel: RemusKernel,
  candidate: number,
  fused: number,
  solids: readonly number[]
): boolean {
  const witnesses: InteriorWitness[] = [];
  for (const solid of solids) {
    const witness = operandInteriorWitness(kernel, solid);
    if (witness === null) return false;
    witnesses.push(witness);
  }
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

/**
 * `exactFuseAll`, with the face contacts it leaves unmerged merged — or, when
 * that cannot be done, refused by name rather than shipped.
 *
 * WORKAROUND for two Remus defects, to be removed with this function, its
 * regroup and its census once both are fixed upstream and the pin carries
 * the fixes: esaueng/remus#1738 (`fuseAll` leaves cap-to-cap cylinders
 * unmerged) and esaueng/remus#1742 (pairwise `fuse` refuses parallel
 * cylinders overlapping by 1 mm or less). `test/touching-cylinder-union.test.ts`
 * holds the oracles the plain `exactFuseAll` must then pass on its own.
 *
 * `fuseAll` joins the groups it judges disjoint "directly without a boolean".
 * On the pinned Remus that judgement misses planar contact between two
 * cylinder caps — a hub standing exactly on a flange, coaxial or not, either
 * operand order — and returns one valid-looking solid that still holds both
 * caps: the flange top stays a full disc under the hub, an internal wall the
 * viewport hides and every face pick, offset, fillet and later cut then works
 * on. A fillet of the hub foot came out convex, and a bore cut dropped the
 * hub. Box-on-box, a cylinder on a box and a cone on a cylinder merge
 * correctly.
 *
 * The fused result is read with {@link materialCensus}:
 *
 * - One piece (including any enclosed cavities): returned as it is. Every
 *   ordinary union pays only an edge-to-face read.
 * - Anything else — more than one certain piece, or any uncertain component:
 *   regrouped ({@link regroupTouchingOperands}). The regrouped solid replaces
 *   the fused one only with fewer boundary components AND the same material
 *   ({@link sameMaterial}).
 * - Then, if the CERTAIN pieces alone outnumber the groups the operands are
 *   proved to form, refused (`union_unmerged_contact`) — a hidden internal
 *   wall is never returned silently. Uncertain components neither add to
 *   that count nor excuse it: a 0.1 mm pin beside eleven 1 mm pins cannot
 *   hide the eleven.
 *
 * What is never refused is a body whose only evidence of extra pieces is
 * uncertain, or whose operands' contact cannot be proved: an untrustworthy
 * measurement is not evidence against a body.
 *
 * Kept off `collapseShape`, where a disjoint pattern tool is in pieces by
 * design.
 */
export function fuseAllMergingFaceContacts(
  kernel: RemusKernel,
  solids: readonly number[],
  labels?: readonly string[],
  contactGroups?: number
): number {
  const fused = exactFuseAll(kernel, solids, labels);
  if (solids.length < 2) return fused;
  const census = materialCensus(kernel, fused);
  if (census === null || census.components <= 1) return fused;
  if (census.uncertain === 0 && census.certainPieces <= 1) return fused;
  let result = fused;
  let resultCensus = census;
  if (solids.length <= MAX_CONTACT_REPAIR_OPERANDS) {
    const regrouped = regroupTouchingOperands(kernel, solids);
    if (regrouped !== null) {
      const regroupedCensus = materialCensus(kernel, regrouped);
      if (
        regroupedCensus !== null &&
        regroupedCensus.components < census.components &&
        sameMaterial(kernel, regrouped, fused, solids)
      ) {
        releaseScratchSolid(kernel, fused);
        result = regrouped;
        resultCensus = regroupedCensus;
      } else {
        releaseScratchSolid(kernel, regrouped);
      }
    }
  }
  if (resultCensus.certainPieces <= 1) return result;
  const groups = contactGroups ?? operandContactGroups(kernel, solids);
  if (groups !== null && resultCensus.certainPieces > groups) {
    releaseScratchSolid(kernel, result);
    throw new AdapterRefusal(
      'union_unmerged_contact',
      'Union refused: where these bodies only touch face to face, the exact ' +
        'kernel could not merge them, so the result would keep a hidden ' +
        'internal wall. Overlapping them slightly instead usually clears it.'
    );
  }
  return result;
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
    if (commonSolid !== undefined && commonSolid !== left && commonSolid !== right) {
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
    ) return false;
    const box = kernel.boundingBox(fusedSolid);
    return operands.every(({ bounds }) =>
      (['x', 'y', 'z'] as const).every((axis, index) =>
        box[index]! <= bounds.min[axis] + connectivity.contactTolerance &&
        box[index + 3]! >= bounds.max[axis] - connectivity.contactTolerance
      )
    );
  } catch {
    return false;
  } finally {
    if (fusedSolid !== undefined && fusedSolid !== left && fusedSolid !== right) {
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
