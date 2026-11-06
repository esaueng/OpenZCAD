/**
 * K10 imported-twin family: the reference direct-edit scenarios R1–R9 of
 * docs/plans/kernel-robustness-plan-2026-11-05.md ("Reference behaviour:
 * direct edits on an imported blended body") on a synthetic,
 * redistributable twin of the recorded body.
 *
 * The twin is built from primitives — a round post standing in a block, the
 * post-to-block seam blended, the post's top rim and the block's vertical
 * edges rounded — exported through the app's STEP export path and imported
 * again with `importStepBody`. The imported document holds one
 * `imported-step` feature and nothing else, so every edit below takes the
 * local direct-edit route an import takes: there is no source dimension to
 * fall back on.
 *
 * Every volume oracle is computed here without the kernel: closed forms for
 * the block, the post and each blend (Pappus for circular blends), and the
 * numerically integrated block/post overlap of `combination-oracle.ts` for a
 * tilted post. The one place no closed form exists — a fillet on a single
 * straight edge whose ends run tangentially into earlier rounds — uses a
 * labelled interval oracle instead (`bounds`): the result must remove at
 * least the straight run's section and at most the whole tangent chain's.
 * A tilted post's seam blend has no closed form; the variants that would
 * need one record the build state only. The kernel's own volume is never
 * an oracle; the only kernel-to-kernel comparisons are replay determinism
 * and the native-versus-imported STEP round trip, both labelled as such.
 *
 * R8 (live preview of every drag) is viewport behaviour and is not a cell.
 */
import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  importStepBody,
  listNodesByKind,
  normalizeDocument,
  transformBody,
  withoutDerivedProjection
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type DirectEditOperation,
  type EdgeTopology,
  type FaceTopology,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../../apps/web/src/lib/interaction/faceOffsetPlan';
import {
  GENERIC_REFUSAL,
  plainRefusal
} from '../../apps/web/src/lib/refusalLanguage';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../../packages/kernel-adapter/src/boolean-result-validation';
import { blendCarrierSnapshot } from '../../packages/kernel-adapter/src/exact-measure';
import {
  CellTimeout,
  census,
  refusal,
  sameBody,
  sync,
  type CellOutcome,
  type Session
} from './combination-matrix';
import {
  cornerVolumeChange,
  directionToWorld,
  dot,
  norm,
  overlapWithError,
  place,
  sub,
  toWorld,
  vec,
  type Corner,
  type Placed,
  type Vec3
} from './combination-oracle';

// ---------------------------------------------------------------- the twin

type BlendKind = 'fillet' | 'chamfer';

export interface TwinVariant {
  id: string;
  /** The post's Move rotation; absent stands the post upright. */
  tilt?: Vec3;
  seam: { kind: BlendKind; size: number } | null;
  /** Why this variant exists, for the reproduction. */
  note: string;
}

const BLOCK = { width: 60, height: 40, depth: 20 } as const;
const POST = { radius: 6, height: 30 } as const;
const POST_BASE = vec(30, 20, 10);
const RIM_FILLET = 1;
const ROUND = 4;
const SEAM_FILLET = 2;
const SEAM_CHAMFER = 1.5;

export const TWIN_VARIANTS: readonly TwinVariant[] = [
  {
    id: 'upright',
    seam: { kind: 'fillet', size: SEAM_FILLET },
    note: 'axis-aligned post, filleted seam (fallback twin with closed-form oracles)'
  },
  {
    id: 'upright-chamfer',
    seam: { kind: 'chamfer', size: SEAM_CHAMFER },
    note: 'axis-aligned post, chamfered seam (fallback twin)'
  },
  {
    id: 'tilted',
    tilt: vec(0, 15, 0),
    seam: { kind: 'fillet', size: SEAM_FILLET },
    note: 'the reference shape: post tilted 15° about Y, filleted seam'
  },
  {
    id: 'tilted-chamfer',
    tilt: vec(0, 15, 0),
    seam: { kind: 'chamfer', size: SEAM_CHAMFER },
    note: 'post tilted 15° about Y, chamfered seam'
  },
  {
    id: 'tilted-unblended',
    tilt: vec(0, 15, 0),
    seam: null,
    note: 'post tilted 15° about Y, sharp seam (fallback while the tilted seam blend refuses)'
  },
  {
    id: 'tilted-x',
    tilt: vec(15, 0, 0),
    seam: { kind: 'fillet', size: SEAM_FILLET },
    note: 'post tilted 15° about X, the other horizontal axis'
  }
];

// --------------------------------------------------------------- the model

/** Corners of the block in order (x-min,y-min), (x-max,y-min), (x-max,y-max), (x-min,y-max). */
type Rounds = [number, number, number, number];

interface ChainBlend {
  loop: 'bottom' | 'top';
  kind: BlendKind;
  size: number;
  /** Only the straight run along the front (y-min) edge. */
  frontOnly?: true;
}

export interface TwinModel {
  block: { width: number; height: number; depth: number; origin: Vec3 };
  post: { radius: number; height: number };
  tilt?: Vec3;
  seam: { kind: BlendKind; size: number } | null;
  rim: number;
  rounds: Rounds;
  chains: ChainBlend[];
}

export function initialModel(variant: TwinVariant): TwinModel {
  return {
    block: { ...BLOCK, origin: vec(0, 0, 0) },
    post: { ...POST },
    ...(variant.tilt ? { tilt: variant.tilt } : {}),
    seam: variant.seam,
    rim: RIM_FILLET,
    rounds: [ROUND, ROUND, ROUND, ROUND],
    chains: []
  };
}

function postPlaced(model: TwinModel): Placed {
  return place(
    {
      family: 'cylinder',
      radius: model.post.radius,
      height: model.post.height
    },
    [
      model.tilt
        ? { translation: POST_BASE, rotationDeg: model.tilt }
        : { translation: POST_BASE }
    ]
  );
}

function blockPlaced(model: TwinModel): Placed {
  const { width, height, depth, origin } = model.block;
  return place({ family: 'box', width, height, depth }, [
    { translation: origin }
  ]);
}

const blockTop = (model: TwinModel) => model.block.origin.z + model.block.depth;

const lineChange = (length: number, kind: BlendKind, size: number) =>
  cornerVolumeChange(
    {
      kind: 'line',
      start: vec(0, 0, 0),
      end: vec(length, 0, 0),
      d1: [1, 0],
      d2: [0, 1],
      convex: true
    },
    kind,
    size
  );

/** A convex blend round a circular edge whose material lies inside its radius. */
export const convexCircleChange = (
  radius: number,
  kind: BlendKind,
  size: number
) =>
  cornerVolumeChange(
    {
      kind: 'circle',
      center: vec(0, 0, 0),
      axis: vec(0, 0, 1),
      radius,
      d1: [-1, 0],
      d2: [0, 1],
      convex: true
    },
    kind,
    size
  );

/** Volume change of one blend round the block's outer loop. */
function chainChange(model: TwinModel, chain: ChainBlend): number {
  const { width, height } = model.block;
  const [r0, r1, r2, r3] = model.rounds;
  const front = lineChange(width - r0 - r1, chain.kind, chain.size);
  if (chain.frontOnly) return front;
  const lines =
    front +
    lineChange(height - r1 - r2, chain.kind, chain.size) +
    lineChange(width - r2 - r3, chain.kind, chain.size) +
    lineChange(height - r3 - r0, chain.kind, chain.size);
  // Each rounded corner carries a quarter turn of the blend (Pappus).
  const arcs = model.rounds
    .map((radius) => convexCircleChange(radius, chain.kind, chain.size) / 4)
    .reduce((sum, value) => sum + value, 0);
  return lines + arcs;
}

interface Expectation {
  volume: number;
  error: number;
  /** How the oracle was derived, for the evidence. */
  basis: string;
}

/** Independent volume of the modelled twin. */
export function expectedVolume(model: TwinModel): Expectation {
  const { width, height, depth } = model.block;
  const r = model.post.radius;
  let volume = width * height * depth + Math.PI * r * r * model.post.height;
  let error = 0;
  let basis = 'closed form';
  if (model.tilt) {
    const overlap = overlapWithError(postPlaced(model), blockPlaced(model));
    volume -= overlap.value;
    error = overlap.error;
    basis = 'closed form + integrated overlap';
  } else {
    const inside = Math.max(
      0,
      Math.min(blockTop(model), POST_BASE.z + model.post.height) -
        Math.max(model.block.origin.z, POST_BASE.z)
    );
    volume -= Math.PI * r * r * inside;
  }
  for (const radius of model.rounds) {
    volume -= (1 - Math.PI / 4) * radius * radius * depth;
  }
  if (model.seam) {
    if (model.tilt) {
      throw new Error('A tilted seam blend has no closed form.');
    }
    // The concave seam wedge: outward along the block top, up the post wall.
    const seam: Corner = {
      kind: 'circle',
      center: vec(POST_BASE.x, POST_BASE.y, blockTop(model)),
      axis: vec(0, 0, 1),
      radius: r,
      d1: [1, 0],
      d2: [0, 1],
      convex: false
    };
    volume += cornerVolumeChange(seam, model.seam.kind, model.seam.size);
  }
  volume += convexCircleChange(r, 'fillet', model.rim);
  for (const chain of model.chains) volume += chainChange(model, chain);
  return { volume, error, basis };
}

function volumeTolerance(expected: Expectation): number {
  // The K10 tolerance, max(0.05 mm³, 1e-6·V), widened only by the oracle's
  // own two-resolution error estimate.
  return Math.max(4 * expected.error, 0.05, 1e-6 * Math.abs(expected.volume));
}

// ------------------------------------------------------------ the scenarios

type Edit =
  | { kind: 'cap-offset'; distance: number }
  | { kind: 'face-offset'; face: 'top' | 'front'; distance: number }
  | { kind: 'wall-radius'; radius: number }
  | { kind: 'blend-radius'; target: 'seam' | 'round-0'; radius: number }
  | {
      kind: 'blend-edges';
      loop: 'bottom' | 'top';
      op: BlendKind;
      size: number;
      frontOnly?: true;
    };

type Check =
  'oracle' | 'bounds' | 'refusal' | 'out-of-range' | 'rows' | 're-resolve';

export interface TwinCell {
  id: string;
  variant: string;
  scenario: string;
  edits: Edit[];
  check: Check;
}

interface ScenarioDef {
  /** `R<n>/<name>`. */
  id: string;
  edits: Edit[];
  check?: Check;
  /** Variants the scenario runs on. */
  on: readonly string[];
}

const ALL_BUILT = [
  'upright',
  'upright-chamfer',
  'tilted',
  'tilted-chamfer',
  'tilted-unblended'
];
const FILLET_SEAM = ['upright', 'tilted'];
const PRIMARY = ['upright', 'tilted', 'tilted-unblended'];

const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: 'R1/cap-up',
    edits: [{ kind: 'cap-offset', distance: 5 }],
    on: ALL_BUILT
  },
  {
    id: 'R1/cap-down',
    edits: [{ kind: 'cap-offset', distance: -5 }],
    on: ALL_BUILT
  },
  {
    id: 'R2/wall-grow',
    edits: [{ kind: 'wall-radius', radius: 7 }],
    on: ALL_BUILT
  },
  {
    id: 'R2/wall-shrink',
    edits: [{ kind: 'wall-radius', radius: 5 }],
    on: ALL_BUILT
  },
  {
    id: 'R3/top-up',
    edits: [{ kind: 'face-offset', face: 'top', distance: 2 }],
    on: ALL_BUILT
  },
  {
    id: 'R3/top-down',
    edits: [{ kind: 'face-offset', face: 'top', distance: -2 }],
    on: ALL_BUILT
  },
  {
    id: 'R3/front-out',
    edits: [{ kind: 'face-offset', face: 'front', distance: 3 }],
    on: PRIMARY
  },
  {
    id: 'R4/seam-grow',
    edits: [{ kind: 'blend-radius', target: 'seam', radius: 3 }],
    on: FILLET_SEAM
  },
  {
    id: 'R4/seam-shrink',
    edits: [{ kind: 'blend-radius', target: 'seam', radius: 1 }],
    on: FILLET_SEAM
  },
  {
    id: 'R4/seam-remove',
    edits: [{ kind: 'blend-radius', target: 'seam', radius: 0 }],
    on: FILLET_SEAM
  },
  {
    id: 'R4/round-grow',
    edits: [{ kind: 'blend-radius', target: 'round-0', radius: 6 }],
    on: PRIMARY
  },
  {
    id: 'R5/single-edge',
    edits: [
      {
        kind: 'blend-edges',
        loop: 'bottom',
        op: 'fillet',
        size: 3,
        frontOnly: true
      }
    ],
    check: 'bounds',
    on: PRIMARY
  },
  {
    // The size the r 3 refusal names as one that builds.
    id: 'R5/single-edge-small',
    edits: [
      {
        kind: 'blend-edges',
        loop: 'bottom',
        op: 'fillet',
        size: 1.5,
        frontOnly: true
      }
    ],
    check: 'bounds',
    on: PRIMARY
  },
  {
    // Equal to the corner rounds: every corner closes as a spherical vertex blend.
    id: 'R5/chain-equal-radius',
    edits: [{ kind: 'blend-edges', loop: 'bottom', op: 'fillet', size: ROUND }],
    on: ['upright']
  },
  {
    id: 'R5/sequential-chains',
    edits: [
      { kind: 'blend-edges', loop: 'bottom', op: 'fillet', size: ROUND },
      { kind: 'blend-edges', loop: 'top', op: 'fillet', size: 2 }
    ],
    on: ['upright']
  },
  {
    id: 'R5/sequential-chains-small',
    edits: [
      { kind: 'blend-edges', loop: 'bottom', op: 'fillet', size: ROUND },
      { kind: 'blend-edges', loop: 'top', op: 'fillet', size: 1.5 }
    ],
    on: ['upright']
  },
  {
    id: 'R6/tangent-chain',
    edits: [{ kind: 'blend-edges', loop: 'bottom', op: 'fillet', size: 3 }],
    on: PRIMARY
  },
  {
    id: 'R6/tangent-chain-small',
    edits: [{ kind: 'blend-edges', loop: 'bottom', op: 'fillet', size: 1.5 }],
    on: PRIMARY
  },
  {
    id: 'R6/chamfer-chain',
    edits: [{ kind: 'blend-edges', loop: 'top', op: 'chamfer', size: 1.5 }],
    on: ['upright']
  },
  {
    // A seam blend far larger than the post's 20 mm protrusion cannot fit.
    id: 'R7/invalid-blend',
    edits: [{ kind: 'blend-radius', target: 'seam', radius: 30 }],
    check: 'refusal',
    on: ['upright']
  },
  {
    id: 'R7/negative-blend',
    edits: [{ kind: 'blend-radius', target: 'seam', radius: -1 }],
    check: 'out-of-range',
    on: ['upright']
  },
  {
    id: 'R7/negative-fillet',
    edits: [{ kind: 'blend-edges', loop: 'bottom', op: 'fillet', size: -2 }],
    check: 'out-of-range',
    on: ['upright']
  },
  {
    id: 'R7/negative-wall',
    edits: [{ kind: 'wall-radius', radius: -1 }],
    check: 'out-of-range',
    on: ['upright']
  },
  {
    id: 'R9/rows',
    edits: [
      { kind: 'cap-offset', distance: 5 },
      { kind: 'face-offset', face: 'top', distance: 2 },
      { kind: 'blend-radius', target: 'round-0', radius: 6 }
    ],
    check: 'rows',
    on: PRIMARY
  },
  {
    id: 'R9/re-resolve',
    edits: [
      { kind: 'cap-offset', distance: 5 },
      { kind: 'blend-radius', target: 'round-0', radius: 6 }
    ],
    check: 're-resolve',
    on: PRIMARY
  }
];

/** The value R9/re-resolve moves its first row to. */
const RE_RESOLVED_CAP = 3;

/** Every imported-twin cell, in a stable order. */
export function importedTwinCells(): TwinCell[] {
  const cells: TwinCell[] = [];
  for (const variant of TWIN_VARIANTS) {
    cells.push({
      id: `imported-twin/${variant.id}/twin/import`,
      variant: variant.id,
      scenario: 'twin/import',
      edits: [],
      check: 'oracle'
    });
    for (const scenario of SCENARIOS) {
      if (!scenario.on.includes(variant.id)) continue;
      cells.push({
        id: `imported-twin/${variant.id}/${scenario.id}`,
        variant: variant.id,
        scenario: scenario.id,
        edits: scenario.edits,
        check: scenario.check ?? 'oracle'
      });
    }
  }
  return cells;
}

/** The CI slice: the reference twin's import and one fast edit per route. */
const TWIN_SMOKE = new Set([
  'imported-twin/upright/twin/import',
  'imported-twin/tilted/twin/import',
  'imported-twin/upright/R1/cap-up',
  'imported-twin/upright/R2/wall-grow',
  'imported-twin/upright/R4/seam-grow'
]);

export function twinSmokeCells(): TwinCell[] {
  return importedTwinCells().filter((cell) => TWIN_SMOKE.has(cell.id));
}

export function twinCampaignCells(): TwinCell[] {
  return importedTwinCells().filter((cell) => !TWIN_SMOKE.has(cell.id));
}

// ------------------------------------------------------- picking on a body

const LENGTH_TOLERANCE = 1e-6;

const faces = (body: BodyRepresentation) => body.topology?.faces ?? [];
const edges = (body: BodyRepresentation) => body.topology?.edges ?? [];

function postAxis(model: TwinModel): Vec3 {
  return directionToWorld(postPlaced(model), vec(0, 0, 1));
}

function planeFace(
  body: BodyRepresentation,
  normal: Vec3,
  point: Vec3
): FaceTopology | undefined {
  return faces(body).find((face) => {
    const g = face.geometry;
    if (g?.surfaceType !== 'plane' || !g.normal || g.featureType) return false;
    return (
      dot(g.normal, normal) > 1 - 1e-9 &&
      Math.abs(dot(sub(g.center, point), normal)) <= 1e-5
    );
  });
}

function blockFace(
  body: BodyRepresentation,
  model: TwinModel,
  which: 'top' | 'bottom' | 'front'
): FaceTopology | undefined {
  const { origin } = model.block;
  switch (which) {
    case 'top':
      return planeFace(body, vec(0, 0, 1), vec(0, 0, blockTop(model)));
    case 'bottom':
      return planeFace(body, vec(0, 0, -1), origin);
    case 'front':
      return planeFace(body, vec(0, -1, 0), origin);
  }
}

function postCap(
  body: BodyRepresentation,
  model: TwinModel
): FaceTopology | undefined {
  const top = toWorld(postPlaced(model), vec(0, 0, model.post.height));
  return planeFace(body, postAxis(model), top);
}

function postWall(
  body: BodyRepresentation,
  model: TwinModel
): FaceTopology | undefined {
  const axis = postAxis(model);
  return faces(body).find((face) => {
    const g = face.geometry;
    if (
      g?.surfaceType !== 'cylinder' ||
      g.featureType === 'blend' ||
      !g.axisStart ||
      !g.axisEnd
    ) {
      return false;
    }
    const along = sub(g.axisEnd, g.axisStart);
    return (
      Math.abs((g.radius ?? 0) - model.post.radius) <= LENGTH_TOLERANCE &&
      Math.abs(Math.abs(dot(along, axis)) / norm(along) - 1) <= 1e-9
    );
  });
}

/** The blend band of the seam, or the round at block corner 0. */
function blendBand(
  body: BodyRepresentation,
  model: TwinModel,
  target: 'seam' | 'round-0'
): FaceTopology | undefined {
  return faces(body).find((face) => {
    const carrier = blendCarrierSnapshot(face.geometry);
    if (!carrier) return false;
    if (target === 'seam') {
      return (
        model.seam !== null &&
        carrier.surfaceClass === 'torus' &&
        Math.abs(carrier.radius - model.seam.size) <= LENGTH_TOLERANCE
      );
    }
    const radius = model.rounds[0];
    const corner = vec(
      model.block.origin.x + radius,
      model.block.origin.y + radius,
      0
    );
    return (
      carrier.surfaceClass === 'cylinder' &&
      Math.abs(carrier.radius - radius) <= LENGTH_TOLERANCE &&
      Math.hypot(carrier.center.x - corner.x, carrier.center.y - corner.y) <=
        1e-5
    );
  });
}

function edgePoints(edge: EdgeTopology): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i + 2 < edge.points.length; i += 3) {
    points.push(vec(edge.points[i]!, edge.points[i + 1]!, edge.points[i + 2]!));
  }
  return points;
}

/** The block's outer loop on its top or bottom face; never the seam. */
function loopEdges(
  body: BodyRepresentation,
  model: TwinModel,
  loop: 'bottom' | 'top',
  frontOnly: boolean
): EdgeTopology[] {
  const face = blockFace(body, model, loop);
  if (!face) return [];
  const { origin, width, height } = model.block;
  const reach = Math.max(...model.rounds) + 1e-6;
  return edges(body).filter((edge) => {
    if (edge.displayRole === 'seam') return false;
    if (!edge.adjacentFaceHashes?.includes(face.hash)) return false;
    const points = edgePoints(edge);
    if (frontOnly) {
      return (
        edge.curve?.type === 'LINE' &&
        points.every((p) => Math.abs(p.y - origin.y) <= 1e-6)
      );
    }
    return points.every(
      (p) =>
        Math.min(
          p.x - origin.x,
          origin.x + width - p.x,
          p.y - origin.y,
          origin.y + height - p.y
        ) <= reach
    );
  });
}

// ------------------------------------------------------------ building it

interface Twin {
  step: string;
  native: BodyRepresentation;
  notes: string[];
}

type TwinBuild = { twin: Twin } | { refused: CellOutcome };

const twins = new Map<string, Promise<TwinBuild>>();

function twinFor(session: Session, variant: TwinVariant): Promise<TwinBuild> {
  let pending = twins.get(variant.id);
  if (!pending) {
    pending = buildTwin(session, variant);
    twins.set(variant.id, pending);
    // A timeout belongs to the cell that hit it, not to every later cell.
    pending.catch(() => twins.delete(variant.id));
  }
  return pending;
}

function stopped(outcome: CellOutcome, step: string): TwinBuild {
  return {
    refused: {
      ...outcome,
      evidence: `twin build, ${step}: ${outcome.evidence}`
    }
  };
}

function edgeInput(
  name: string,
  bodyId: BodyId,
  picked: EdgeTopology[],
  size: number
) {
  const references = picked.map((edge) => edge.reference);
  return {
    name,
    targetBodyId: bodyId,
    edgeHashes: picked.map((edge) => edge.hash),
    ...(references.every((reference) => reference !== undefined)
      ? { edgeReferences: references }
      : {}),
    size
  };
}

/** Native history of the twin, exported to STEP: the only time it exists. */
async function buildTwin(
  session: Session,
  variant: TwinVariant
): Promise<TwinBuild> {
  const model = initialModel(variant);
  let document = createProjectDocument(
    'Imported twin',
    toUserId('user_k10_twin')
  );
  document = addPrimitiveFeature(document, {
    name: 'Block',
    bodyName: 'Block 1',
    primitiveKind: 'box',
    dimensions: { ...BLOCK }
  });
  const block = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Post',
    bodyName: 'Post 1',
    primitiveKind: 'cylinder',
    dimensions: { ...POST }
  });
  const post = document.bodyOrder.at(-1)!;
  document = transformBody(document, {
    name: 'Place post',
    targetBodyId: post,
    translation: POST_BASE,
    ...(variant.tilt ? { rotationDeg: variant.tilt } : {})
  }).document;
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.booleanBodies({
      name: 'Union',
      operation: 'union',
      targetBodyIds: [block, post]
    })
  );
  let bodyId = manager.document.bodyOrder.at(-1)!;
  let derived = await sync(session, manager.document, bodyId);
  const notes: string[] = [];
  const union = refusal(derived, 'union');
  if (union) return stopped(union, 'union');

  const blendStep = async (
    label: string,
    picked: EdgeTopology[],
    kind: BlendKind,
    size: number
  ): Promise<CellOutcome | null> => {
    if (picked.length === 0) {
      return {
        state: 'wrong',
        evidence: `${label}: the modelled edge is not on the body`
      };
    }
    const input = edgeInput(label, bodyId, picked, size);
    manager.execute(
      kind === 'fillet'
        ? commandFactories.filletEdges(input)
        : commandFactories.chamferEdges(input)
    );
    bodyId = manager.document.bodyOrder.at(-1)!;
    derived = await sync(session, manager.document, bodyId);
    notes.push(`${label} on ${picked.length} edge(s)`);
    return refusal(derived, label);
  };

  const body = () => derived.bodyRepresentations[bodyId]!;
  if (variant.seam) {
    const wall = postWall(body(), model);
    const top = blockFace(body(), model, 'top');
    const seam = edges(body()).filter(
      (edge) =>
        edge.displayRole !== 'seam' &&
        wall !== undefined &&
        top !== undefined &&
        edge.adjacentFaceHashes?.includes(wall.hash) === true &&
        edge.adjacentFaceHashes.includes(top.hash)
    );
    const blocked = await blendStep(
      `seam ${variant.seam.kind}`,
      seam,
      variant.seam.kind,
      variant.seam.size
    );
    if (blocked) return stopped(blocked, `seam ${variant.seam.kind}`);
  }
  {
    const wall = postWall(body(), model);
    const cap = postCap(body(), model);
    const rim = edges(body()).filter(
      (edge) =>
        edge.displayRole !== 'seam' &&
        wall !== undefined &&
        cap !== undefined &&
        edge.adjacentFaceHashes?.includes(wall.hash) === true &&
        edge.adjacentFaceHashes.includes(cap.hash)
    );
    const blocked = await blendStep('rim fillet', rim, 'fillet', RIM_FILLET);
    if (blocked) return stopped(blocked, 'rim fillet');
  }
  {
    const vertical = edges(body()).filter((edge) => {
      if (edge.curve?.type !== 'LINE') return false;
      const points = edgePoints(edge);
      const first = points[0]!;
      const last = points.at(-1)!;
      return (
        Math.hypot(first.x - last.x, first.y - last.y) <= 1e-9 &&
        Math.abs(Math.abs(first.z - last.z) - BLOCK.depth) <= 1e-9
      );
    });
    const blocked = await blendStep('corner rounds', vertical, 'fillet', ROUND);
    if (blocked) return stopped(blocked, 'corner rounds');
  }
  const native = body();
  const step = await session.adapter.exportStep(
    { ...manager.document, derived },
    [bodyId]
  );
  const inspected = await session.adapter.inspectStep(step);
  if (!inspected.solid || !inspected.valid) {
    return {
      refused: {
        state: inspected.solid ? 'wrong' : 'untyped-refusal',
        evidence: `twin STEP export does not read back as a valid solid: ${inspected.reason ?? ''}`
      }
    };
  }
  return { twin: { step, native, notes } };
}

function importedDocument(twin: Twin): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  return importStepBody(
    createProjectDocument('Imported twin', toUserId('user_k10_twin')),
    {
      name: 'Twin',
      artifactId: 'artifact_k10_twin',
      sourceName: 'imported-twin.step',
      stepText: twin.step
    }
  );
}

// ------------------------------------------------------------- the oracles

function exactAndClosed(
  body: BodyRepresentation | undefined
): CellOutcome | null {
  if (!body) return { state: 'wrong', evidence: 'no result body' };
  if (!body.exportableStep) {
    return { state: 'wrong', evidence: 'result is not an exact solid' };
  }
  const closure = inspectTriangleMeshClosure(
    body.mesh.vertices,
    body.mesh.indices
  );
  if (!isClosedConsistentlyOrientedMesh(closure)) {
    return {
      state: 'wrong',
      evidence: `display mesh not closed: ${JSON.stringify(closure)}`
    };
  }
  return null;
}

/** The analytic blend bands a body carries, for a wrong-volume diagnosis. */
function blendSummary(body: BodyRepresentation): string {
  const bands = faces(body).flatMap((face) => {
    const carrier = blendCarrierSnapshot(face.geometry);
    if (!carrier) return [];
    const c = carrier.center;
    return [
      `${carrier.surfaceClass} r ${carrier.radius} at (${c.x.toFixed(3)}, ${c.y.toFixed(3)}, ${c.z.toFixed(3)})${face.geometry?.majorRadius !== undefined ? ` R ${face.geometry.majorRadius.toFixed(4)}` : ''}`
    ];
  });
  return bands.length > 0 ? bands.join(', ') : 'none';
}

function qualify(
  body: BodyRepresentation | undefined,
  model: TwinModel,
  notes: string[]
): CellOutcome {
  const broken = exactAndClosed(body);
  if (broken) return broken;
  const expected = expectedVolume(model);
  const tolerance = volumeTolerance(expected);
  if (Math.abs(body!.volume - expected.volume) > tolerance) {
    return {
      state: 'wrong',
      evidence: `volume ${body!.volume} differs from the ${expected.basis} oracle ${expected.volume} by ${body!.volume - expected.volume} (tolerance ${tolerance.toPrecision(3)}); ${census(body!)}; blends ${blendSummary(body!)}`
    };
  }
  return {
    state: 'qualified',
    evidence: [
      `volume ${body!.volume.toPrecision(12)} (${expected.basis} oracle ±${tolerance.toPrecision(2)})`,
      census(body!),
      ...notes
    ].join('; ')
  };
}

/**
 * Interval oracle for a blend on one straight edge whose ends run
 * tangentially into earlier rounds: no closed form, so the result must lie
 * between removing the straight run alone and removing the whole chain.
 */
function qualifyBounds(
  body: BodyRepresentation | undefined,
  before: TwinModel,
  chain: ChainBlend,
  notes: string[]
): CellOutcome {
  const broken = exactAndClosed(body);
  if (broken) return broken;
  const base = expectedVolume(before);
  const straight = expectedVolume({
    ...before,
    chains: [...before.chains, chain]
  });
  const whole = expectedVolume({
    ...before,
    chains: [
      ...before.chains,
      { loop: chain.loop, kind: chain.kind, size: chain.size }
    ]
  });
  const tolerance = volumeTolerance(base);
  const high = Math.max(straight.volume, whole.volume) + tolerance;
  const low = Math.min(straight.volume, whole.volume) - tolerance;
  const volume = body!.volume;
  if (volume < low || volume > high) {
    return {
      state: 'wrong',
      evidence: `volume ${volume} is outside the interval oracle [${low}, ${high}] (straight run to whole tangent chain)`
    };
  }
  const where =
    Math.abs(volume - whole.volume) <= tolerance
      ? 'the blend propagated round the tangent chain'
      : Math.abs(volume - straight.volume) <= tolerance
        ? 'the blend stopped at the straight run'
        : 'the blend ends inside the chain';
  return {
    state: 'qualified',
    evidence: [
      `volume ${volume.toPrecision(12)} within the interval oracle [${low.toPrecision(10)}, ${high.toPrecision(10)}]; ${where}`,
      census(body!),
      ...notes
    ].join('; ')
  };
}

// ---------------------------------------------------------------- editing

interface Stage {
  manager: CommandManager;
  derived: DerivedState;
  bodyId: BodyId;
  model: TwinModel;
  /** Feature id of each applied edit row, in order. */
  rows: FeatureId[];
  notes: string[];
}

interface Stopped {
  stopped: CellOutcome;
  stage: Stage;
  reachedKernel: boolean;
}

type Applied = { stage: Stage } | Stopped;

function newFeature(
  before: ProjectDocument,
  after: ProjectDocument
): FeatureId | undefined {
  const known = new Set(before.featureOrder);
  return after.featureOrder.find((id) => !known.has(id));
}

function nextModel(model: TwinModel, edit: Edit): TwinModel {
  switch (edit.kind) {
    case 'cap-offset':
      return {
        ...model,
        post: { ...model.post, height: model.post.height + edit.distance }
      };
    case 'face-offset':
      if (edit.face === 'top') {
        return {
          ...model,
          block: { ...model.block, depth: model.block.depth + edit.distance }
        };
      }
      return {
        ...model,
        block: {
          ...model.block,
          height: model.block.height + edit.distance,
          origin: sub(model.block.origin, vec(0, edit.distance, 0))
        }
      };
    case 'wall-radius':
      return { ...model, post: { ...model.post, radius: edit.radius } };
    case 'blend-radius':
      if (edit.target === 'seam') {
        return {
          ...model,
          seam:
            edit.radius === 0 || !model.seam
              ? null
              : { ...model.seam, size: edit.radius }
        };
      }
      return {
        ...model,
        rounds: [edit.radius, model.rounds[1], model.rounds[2], model.rounds[3]]
      };
    case 'blend-edges':
      return {
        ...model,
        chains: [
          ...model.chains,
          {
            loop: edit.loop,
            kind: edit.op,
            size: edit.size,
            ...(edit.frontOnly ? { frontOnly: true as const } : {})
          }
        ]
      };
  }
}

function describe(edit: Edit): string {
  switch (edit.kind) {
    case 'cap-offset':
      return `offset the post's top cap by ${edit.distance}`;
    case 'face-offset':
      return `offset the block's ${edit.face} face by ${edit.distance}`;
    case 'wall-radius':
      return `resize the post wall to r ${edit.radius}`;
    case 'blend-radius':
      return `resize the ${edit.target === 'seam' ? 'seam blend' : 'corner-0 round'} to r ${edit.radius}`;
    case 'blend-edges':
      return `${edit.op} the block's ${edit.frontOnly ? 'front ' : ''}${edit.loop} ${edit.frontOnly ? 'edge' : 'outer loop'} by ${edit.size}`;
  }
}

function pickFailure(stage: Stage, what: string): Applied {
  return {
    stage,
    stopped: {
      state: 'wrong',
      evidence: `${what} is not a face or edge of the imported body`
    },
    reachedKernel: false
  };
}

/** The command an edit becomes, or why it never became one. */
function commandFor(
  stage: Stage,
  edit: Edit
): { command: AnyCommand; route: string } | Applied {
  const body = stage.derived.bodyRepresentations[stage.bodyId]!;
  const { model } = stage;
  switch (edit.kind) {
    case 'cap-offset':
    case 'face-offset': {
      const face =
        edit.kind === 'cap-offset'
          ? postCap(body, model)
          : blockFace(body, model, edit.face);
      if (!face) return pickFailure(stage, describe(edit));
      const plan = planFaceOffset({
        document: { ...stage.manager.document, derived: stage.derived },
        bodyId: stage.bodyId,
        face,
        faceHash: face.hash,
        offset: edit.distance
      });
      if (!plan) {
        return {
          stage,
          stopped: {
            state: 'untyped-refusal',
            evidence: `${describe(edit)}: no offset plan`
          },
          reachedKernel: false
        };
      }
      if ('preflightRejection' in plan && plan.preflightRejection) {
        return {
          stage,
          stopped: {
            state: 'typed-refusal',
            evidence: `${describe(edit)}: planner refused — ${plan.preflightRejection}`
          },
          reachedKernel: false
        };
      }
      return { command: plan.command, route: plan.kind };
    }
    case 'wall-radius': {
      const wall = postWall(body, model);
      const g = wall?.geometry;
      if (!wall || !g?.axisStart || !g.axisEnd) {
        return pickFailure(stage, 'the post wall');
      }
      const operation: DirectEditOperation = {
        kind: 'resize-cylindrical-face',
        faceHash: wall.hash,
        ...(wall.reference ? { faceReference: wall.reference } : {}),
        sourceRadius: model.post.radius,
        sourceAxisStart: g.axisStart,
        sourceAxisEnd: g.axisEnd,
        concavity: 'boss',
        radius: edit.radius
      };
      return {
        command: commandFactories.directEditBody({
          name: 'Resize post',
          targetBodyId: stage.bodyId,
          operation
        }),
        route: 'resize-cylindrical-face'
      };
    }
    case 'blend-radius': {
      const band = blendBand(body, model, edit.target);
      const carrier = band && blendCarrierSnapshot(band.geometry);
      if (!band || !carrier) {
        return pickFailure(stage, `the ${edit.target} blend band`);
      }
      return {
        command: commandFactories.directEditBody({
          name: edit.radius === 0 ? 'Remove blend' : 'Resize blend',
          targetBodyId: stage.bodyId,
          operation: {
            kind: 'resize-blend',
            faceHash: band.hash,
            ...(band.reference ? { faceReference: band.reference } : {}),
            surfaceClass: carrier.surfaceClass,
            recordedRadius: carrier.radius,
            recordedCenter: carrier.center,
            recordedAxis: carrier.axis,
            newRadius: edit.radius
          }
        }),
        route: 'resize-blend'
      };
    }
    case 'blend-edges': {
      const picked = loopEdges(body, model, edit.loop, edit.frontOnly === true);
      if (picked.length === 0) return pickFailure(stage, describe(edit));
      const input = edgeInput(
        edit.op === 'fillet' ? 'Fillet' : 'Chamfer',
        stage.bodyId,
        picked,
        edit.size
      );
      return {
        command:
          edit.op === 'fillet'
            ? commandFactories.filletEdges(input)
            : commandFactories.chamferEdges(input),
        route: `${edit.op} on ${picked.length} edge(s)`
      };
    }
  }
}

async function apply(
  session: Session,
  stage: Stage,
  edit: Edit
): Promise<Applied> {
  let planned: ReturnType<typeof commandFor>;
  try {
    planned = commandFor(stage, edit);
  } catch (error) {
    return {
      stage,
      stopped: {
        state: 'typed-refusal',
        evidence: `${describe(edit)}: refused before building — ${error instanceof Error ? error.message : String(error)}`
      },
      reachedKernel: false
    };
  }
  if ('stage' in planned) return planned;
  const before = stage.manager.document;
  try {
    stage.manager.execute(planned.command);
  } catch (error) {
    return {
      stage,
      stopped: {
        state: 'typed-refusal',
        evidence: `${describe(edit)}: refused before building — ${error instanceof Error ? error.message : String(error)}`
      },
      reachedKernel: false
    };
  }
  const row = newFeature(before, stage.manager.document);
  const bodyId = stage.manager.document.bodyOrder.at(-1)!;
  const derived = await sync(session, stage.manager.document, bodyId);
  const next: Stage = {
    ...stage,
    derived,
    bodyId,
    model: nextModel(stage.model, edit),
    rows: row ? [...stage.rows, row] : stage.rows,
    notes: [...stage.notes, `${describe(edit)} via ${planned.route}`]
  };
  const refused = refusal(derived, describe(edit));
  return refused
    ? { stage: next, stopped: refused, reachedKernel: true }
    : { stage: next };
}

// ---------------------------------------------------------------- checking

/**
 * R7: a refusal must name its outcome in one plain sentence that is not the
 * generic fallback, and the body must stay what it was before the edit.
 */
function refusalVerdict(
  before: Stage,
  after: Stopped,
  outOfRange: boolean
): CellOutcome {
  const derived = after.stage.derived;
  const blocking = (derived.featureWarnings ?? []).find(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );
  const message = blocking?.message ?? after.stopped.evidence;
  const plain = plainRefusal(
    message.replace(/^Feature "[^"]*": /, ''),
    blocking?.kernelRefusal?.category
  );
  const evidence = [
    after.stopped.evidence,
    `shown as "${plain.message}"`,
    ...(outOfRange
      ? [after.reachedKernel ? 'reached the build' : 'refused before building']
      : [])
  ];
  if (after.reachedKernel) {
    const had = before.derived.bodyRepresentations[before.bodyId];
    // A refused feature that would have made a new body leaves its input
    // body standing instead; a refused direct edit keeps the same body id.
    const input = derived.bodyRepresentations[before.bodyId];
    const kept =
      derived.bodyRepresentations[after.stage.bodyId] ??
      (input && input.consumed !== true ? input : undefined);
    if (!had || !kept || !sameBody(had, kept)) {
      return {
        state: 'wrong',
        evidence: `${evidence.join('; ')}; the last valid body was not kept (${kept ? `${kept.volume} ${census(kept)}` : 'no body'} vs ${had?.volume} ${had ? census(had) : ''})`
      };
    }
    evidence.push('last valid body kept');
  }
  if (plain.message === GENERIC_REFUSAL) {
    return {
      state: 'untyped-refusal',
      evidence: `${evidence.join('; ')}; generic sentence`
    };
  }
  return { state: after.stopped.state, evidence: evidence.join('; ') };
}

function featureRows(document: ProjectDocument): string[] {
  return listNodesByKind(document, 'feature').map(
    (feature) => `${feature.featureKind}:${feature.name}`
  );
}

async function reopenMatches(
  session: Session,
  stage: Stage
): Promise<CellOutcome | null> {
  const before = stage.derived.bodyRepresentations[stage.bodyId]!;
  const reopened = normalizeDocument(
    JSON.parse(
      JSON.stringify(withoutDerivedProjection(stage.manager.document))
    ) as ProjectDocument
  );
  const derived = await sync(session, reopened, stage.bodyId);
  const refused = refusal(derived, 'reopen');
  if (refused) return refused;
  const after = derived.bodyRepresentations[stage.bodyId];
  if (!after || !sameBody(before, after)) {
    return {
      state: 'wrong',
      evidence: `reopened replay differs: ${after?.volume} ${after ? census(after) : ''} vs ${before.volume} ${census(before)}`
    };
  }
  return null;
}

/** R9: one listed row per edit, replay on reopen, undo and redo of the last. */
async function rowsVerdict(
  session: Session,
  stage: Stage,
  edits: number
): Promise<CellOutcome> {
  const rows = featureRows(stage.manager.document);
  if (
    rows[0]?.startsWith('imported-step:') !== true ||
    rows.length !== edits + 1
  ) {
    return {
      state: 'wrong',
      evidence: `history is not the import plus one row per edit: ${rows.join(', ')}`
    };
  }
  const verdict = qualify(
    stage.derived.bodyRepresentations[stage.bodyId],
    stage.model,
    stage.notes
  );
  if (verdict.state !== 'qualified') return verdict;
  const reopened = await reopenMatches(session, stage);
  if (reopened) return reopened;
  const before = stage.derived.bodyRepresentations[stage.bodyId]!;
  stage.manager.undo();
  const undone = await sync(session, stage.manager.document, stage.bodyId);
  const undoRefused = refusal(undone, 'undo');
  if (undoRefused) return undoRefused;
  stage.manager.redo();
  const redone = await sync(session, stage.manager.document, stage.bodyId);
  const redoRefused = refusal(redone, 'redo');
  if (redoRefused) return redoRefused;
  const after = redone.bodyRepresentations[stage.bodyId];
  if (!after || !sameBody(before, after)) {
    return {
      state: 'wrong',
      evidence: `redo differs: ${after?.volume} vs ${before.volume}`
    };
  }
  return {
    ...verdict,
    evidence: `${verdict.evidence}; rows ${rows.slice(1).join(', ')}; reopen and undo/redo reproduce volume and census`
  };
}

/** R9: editing the first row's value re-resolves every later row. */
async function reResolveVerdict(
  session: Session,
  stage: Stage
): Promise<CellOutcome> {
  const built = qualify(
    stage.derived.bodyRepresentations[stage.bodyId],
    stage.model,
    stage.notes
  );
  if (built.state !== 'qualified') return built;
  const first = listNodesByKind(stage.manager.document, 'feature').find(
    (feature) => feature.featureId === stage.rows[0]
  );
  if (!first || first.data.featureKind !== 'direct-edit') {
    return {
      state: 'wrong',
      evidence: `the first edit is not a direct-edit row: ${first?.featureKind}`
    };
  }
  const operation = first.data.operation;
  if (operation.kind !== 'offset-face') {
    return {
      state: 'wrong',
      evidence: `the first row is ${operation.kind}, not offset-face`
    };
  }
  stage.manager.execute(
    commandFactories.updateFeature({
      featureId: first.featureId,
      data: { operation: { ...operation, offset: RE_RESOLVED_CAP } }
    })
  );
  const derived = await sync(session, stage.manager.document, stage.bodyId);
  const refused = refusal(derived, 're-resolve');
  if (refused) return refused;
  const model = {
    ...stage.model,
    post: { ...stage.model.post, height: POST.height + RE_RESOLVED_CAP }
  };
  const verdict = qualify(
    derived.bodyRepresentations[stage.bodyId],
    model,
    stage.notes
  );
  if (verdict.state !== 'qualified') return verdict;
  return reopenMatches(session, { ...stage, derived, model }).then(
    (reopened) =>
      reopened ?? {
        ...verdict,
        evidence: `${verdict.evidence}; first row moved to ${RE_RESOLVED_CAP}, later rows re-resolved without re-picking; reopen reproduces`
      }
  );
}

// ----------------------------------------------------------------- running

/** Runs one imported-twin cell within `budgetMs`. */
export async function runTwinCell(
  adapter: ExactKernelAdapter,
  cell: TwinCell,
  budgetMs = 90_000
): Promise<CellOutcome> {
  const session: Session = { adapter, deadline: Date.now() + budgetMs };
  try {
    return await runTwinCellIn(session, cell);
  } catch (error) {
    if (error instanceof CellTimeout || Date.now() > session.deadline) {
      return { state: 'timeout', evidence: `exceeded ${budgetMs} ms` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      state: 'untyped-refusal',
      evidence: `threw: ${message.slice(0, 400)}`
    };
  }
}

async function runTwinCellIn(
  session: Session,
  cell: TwinCell
): Promise<CellOutcome> {
  const variant = TWIN_VARIANTS.find((entry) => entry.id === cell.variant)!;
  const build = await twinFor(session, variant);
  if ('refused' in build) return build.refused;
  const { twin } = build;
  const imported = importedDocument(twin);
  const manager = new CommandManager(imported.document);
  const derived = await sync(session, manager.document, imported.bodyId);
  const importRefused = refusal(derived, 'import');
  if (importRefused) return importRefused;
  let stage: Stage = {
    manager,
    derived,
    bodyId: imported.bodyId,
    model: initialModel(variant),
    rows: [],
    notes: []
  };
  if (cell.scenario === 'twin/import') {
    const rows = featureRows(manager.document);
    if (rows.length !== 1 || !rows[0]!.startsWith('imported-step:')) {
      return {
        state: 'wrong',
        evidence: `the import carries history: ${rows.join(', ')}`
      };
    }
    const body = derived.bodyRepresentations[imported.bodyId];
    const verdict = qualify(body, stage.model, twin.notes);
    if (verdict.state !== 'qualified' || !body) return verdict;
    // Kernel-to-kernel: the STEP round trip must not change the solid.
    if (
      Math.abs(body.volume - twin.native.volume) >
      1e-9 * twin.native.volume
    ) {
      return {
        state: 'wrong',
        evidence: `imported volume ${body.volume} differs from the native twin ${twin.native.volume}`
      };
    }
    const blends = faces(body).filter((face) =>
      blendCarrierSnapshot(face.geometry)
    ).length;
    return {
      ...verdict,
      evidence: `${verdict.evidence}; native ${census(twin.native)}, ${blends} analytic blend face(s) recognised on import`
    };
  }
  for (const [index, edit] of cell.edits.entries()) {
    const before = stage;
    const applied = await apply(session, stage, edit);
    if ('stopped' in applied) {
      if (cell.check === 'refusal' || cell.check === 'out-of-range') {
        return refusalVerdict(before, applied, cell.check === 'out-of-range');
      }
      return {
        ...applied.stopped,
        evidence:
          cell.edits.length > 1
            ? `row ${index + 1}: ${applied.stopped.evidence}`
            : applied.stopped.evidence
      };
    }
    stage = applied.stage;
  }
  const body = stage.derived.bodyRepresentations[stage.bodyId];
  switch (cell.check) {
    case 'refusal':
    case 'out-of-range':
      return {
        state: 'wrong',
        evidence: `an edit that cannot make a valid body built: ${body?.volume} ${body ? census(body) : ''}`
      };
    case 'bounds': {
      const chain = stage.model.chains.at(-1)!;
      return qualifyBounds(
        body,
        { ...stage.model, chains: stage.model.chains.slice(0, -1) },
        chain,
        stage.notes
      );
    }
    case 'rows':
      return rowsVerdict(session, stage, cell.edits.length);
    case 're-resolve':
      return reResolveVerdict(session, stage);
    default:
      return qualify(body, stage.model, stage.notes);
  }
}

/** A copy-pasteable description of the cell, for a reproduction. */
export function twinReproduction(cell: TwinCell): string {
  const variant = TWIN_VARIANTS.find((entry) => entry.id === cell.variant)!;
  const tilt = variant.tilt
    ? `rotate (${variant.tilt.x}°, ${variant.tilt.y}°, ${variant.tilt.z}°) then `
    : '';
  const lines = [
    `K10 cell ${cell.id} (${variant.note})`,
    `1. box ${JSON.stringify(BLOCK)}`,
    `2. cylinder ${JSON.stringify(POST)}; ${tilt}move (${POST_BASE.x}, ${POST_BASE.y}, ${POST_BASE.z})`,
    '3. union of [1, 2]',
    ...(variant.seam
      ? [`4. ${variant.seam.kind} the post/block seam by ${variant.seam.size}`]
      : []),
    `${variant.seam ? 5 : 4}. fillet the post's top rim by ${RIM_FILLET}, then the block's four vertical edges by ${ROUND}`,
    'Export STEP, import it into an empty project (no construction history), then:',
    ...cell.edits.map(
      (edit, index) => `  ${String.fromCharCode(97 + index)}. ${describe(edit)}`
    ),
    `Run: K10_CELL='${cell.id}' pnpm exec vitest run test/combination-matrix`
  ];
  return lines.join('\n');
}
