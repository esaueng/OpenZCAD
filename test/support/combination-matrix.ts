/**
 * K10 combination qualification matrix: generated histories, independent
 * oracles and committed per-cell ledgers.
 *
 * A cell is one history — operand pair × placement (× scale) × boolean ×
 * modifier — followed by one follow-up edit. Families, placements and the
 * applicability of each axis are data (`PAIRS`), so a new family is a new
 * entry rather than new runner code, and a cell id only ever depends on its
 * axis values, never on its position in the enumeration.
 *
 * Each cell resolves to exactly one state:
 *
 * - `qualified`: every step built, the body is exact and exportable, the
 *   display mesh is closed and consistently oriented, its volume agrees with
 *   an oracle computed without the kernel (`combination-oracle.ts`), and the
 *   follow-up's own oracle holds (replay determinism, route equivalence, a
 *   STEP round trip);
 * - `typed-refusal`: a step refused and the feature warning carries the
 *   kernel's typed classification (`kernelRefusal`), or the product planner
 *   refused before building;
 * - `untyped-refusal`: a step refused with prose only, or threw;
 * - `wrong`: everything built but an oracle disagrees — silent bad geometry;
 * - `timeout`: the cell exceeded its budget. Recorded, never hidden.
 *
 * The ledgers ratchet in both directions: a cell that changes state fails
 * until its ledger changes in the same PR. See
 * docs/plans/kernel-robustness-plan-2026-11-05.md (WS1).
 */
import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listNodesByKind,
  normalizeDocument,
  transformBody,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type EdgeTopology,
  type FaceTopology,
  type FeatureId,
  type PrimitiveKind,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../../apps/web/src/lib/interaction/faceOffsetPlan';
import { withCarriedSelections } from '../../apps/web/src/lib/topologyReferenceRepairs';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../../packages/kernel-adapter/src/boolean-result-validation';
import { blendCarrierSnapshot } from '../../packages/kernel-adapter/src/exact-measure';
import {
  closedFormVolume,
  cornerVolumeChange,
  directionToWorld,
  dot,
  norm,
  overlapWithError,
  place,
  seamWedge,
  sub,
  toWorld,
  vec,
  type Corner,
  type MoveStep,
  type Placed,
  type SolidModel,
  type Vec3
} from './combination-oracle';

export type CellState =
  'qualified' | 'typed-refusal' | 'untyped-refusal' | 'wrong' | 'timeout';

export const CELL_STATES: readonly CellState[] = [
  'qualified',
  'typed-refusal',
  'untyped-refusal',
  'wrong',
  'timeout'
];

export type BooleanKind =
  | 'union'
  | 'subtract'
  | 'intersect'
  | 'union-reversed'
  | 'subtract-reversed'
  | 'intersect-reversed';

export type ModifierKind =
  | 'no-modifier'
  | 'fillet-seam'
  | 'chamfer-seam'
  | 'fillet-edge'
  | 'chamfer-edge'
  | 'cap-offset';

export type FollowUp =
  | 'none'
  | 'source-grow'
  | 'source-shrink'
  | 'direct-grow'
  | 'direct-shrink'
  | 'direct-offset'
  | 'remove-blend'
  | 'undo-redo'
  | 'reopen'
  | 'step-roundtrip';

export interface Cell {
  id: string;
  pair: string;
  placement: string;
  scale: number;
  boolean: BooleanKind;
  modifier: ModifierKind;
  followUp: FollowUp;
}

export interface CellOutcome {
  state: CellState;
  /** What decided the state, for the failure message and the PR summary. */
  evidence: string;
}

// ---------------------------------------------------------------- the data

interface OperandDef {
  kind: PrimitiveKind;
  name: string;
  dims: Record<string, number>;
}

interface PlacementDef {
  id: string;
  a?: MoveStep[];
  b: MoveStep[];
  /** Overrides of the tool operand's dimensions for this placement. */
  bDims?: Record<string, number>;
  /** Booleans this placement leaves out (an empty intersect, say). */
  skip?: BooleanKind[];
  /** Extra scales the history is rebuilt at. */
  scales?: number[];
  /** The operands only touch, so a subtract leaves no tool wall. */
  contactOnly?: true;
  /** The tool stands upright through the target's top face. */
  upright?: boolean;
}

type EdgeDef = 'box-bottom-front' | 'cylinder-start-rim';
type CapDef = 'box-bottom' | 'cylinder-end';

interface PairDef {
  id: string;
  /** The target (first operand); the tool is `b`. */
  a: OperandDef;
  b: OperandDef;
  placements: PlacementDef[];
  /** Which operand's cross-section the overlap is integrated over. */
  footprint: 'a' | 'b';
  /** The source dimension a follow-up edits on the tool. */
  grow: { key: string; grow: number; shrink: number };
  /** The tool's wall is a cylinder a direct resize can target. */
  directResize?: boolean;
  /** Circular seam between an upright tool and the target's top face. */
  seam?: boolean;
  /** An edge no boolean touches, for the unrelated-edge modifiers. */
  edge?: { def: EdgeDef; operand: 'a' | 'b'; fillet: number; chamfer: number };
  /** A planar face a cap offset can push. */
  cap?: { def: CapDef; operand: 'a' | 'b'; skipPlacements?: string[] };
  /** Placements modifiers run on (the rest run without one). */
  modifierPlacements?: string[];
  /** Why a modifier family is left out of this pair. */
  excluded?: Partial<Record<ModifierKind, string>>;
}

const BOX: OperandDef = {
  kind: 'box',
  name: 'Box',
  dims: { width: 60, height: 60, depth: 20 }
};

const TILT = { x: 20, y: 10, z: 0 } as const;
const SLIVER = 1e-3;
const SEAM_FILLET = 2;
const SEAM_CHAMFER = 1.5;
const OFFSET = 5;
const EMPTY_INTERSECT: BooleanKind[] = ['intersect', 'intersect-reversed'];

const t = (x: number, y: number, z: number, rotationDeg?: Vec3): MoveStep =>
  rotationDeg
    ? { translation: vec(x, y, z), rotationDeg }
    : { translation: vec(x, y, z) };

export const PAIRS: readonly PairDef[] = [
  {
    // The 2026-11-05 report's geometry; ids predate the generic generator.
    id: 'sphere×cylinder',
    a: { kind: 'sphere', name: 'Sphere', dims: { radius: 73.5 } },
    b: {
      kind: 'cylinder',
      name: 'Cylinder',
      dims: { radius: 6, height: 64.10000000000001 }
    },
    placements: [
      { id: 'off-axis', a: [t(25.5, -1.5, 0)], b: [t(0, 0, 46), t(0, 0, 12)] },
      {
        id: 'tilted',
        a: [t(25.5, -1.5, 0)],
        b: [t(0, 0, 46, TILT), t(0, 0, 12)]
      }
    ],
    footprint: 'b',
    grow: { key: 'radius', grow: 7, shrink: 5 },
    directResize: true,
    cap: { def: 'cylinder-end', operand: 'b' },
    excluded: {
      'fillet-seam':
        'a sphere/cylinder seam fillet took 3.5–14 min per rebuild in the report (plan root cause 6)',
      'chamfer-seam': 'same seam as the fillet; no closed form on a sphere'
    }
  },
  {
    id: 'box×cylinder',
    a: BOX,
    b: { kind: 'cylinder', name: 'Cylinder', dims: { radius: 6, height: 30 } },
    placements: [
      { id: 'aligned', b: [t(30, 30, 10)], upright: true, scales: [1e-3, 1e3] },
      { id: 'off-centre', b: [t(41, 23, 10)], upright: true },
      { id: 'tilted', b: [t(30, 30, 8, TILT)] },
      {
        id: 'tangent',
        b: [t(66, 30, 5)],
        skip: EMPTY_INTERSECT,
        contactOnly: true
      },
      { id: 'coincident', b: [t(30, 30, 0)] },
      {
        id: 'stacked',
        b: [t(30, 30, 20)],
        skip: EMPTY_INTERSECT,
        contactOnly: true
      },
      { id: 'sliver', b: [t(30, 30, 20 - SLIVER)] }
    ],
    footprint: 'b',
    grow: { key: 'radius', grow: 7, shrink: 5 },
    directResize: true,
    seam: true,
    edge: { def: 'box-bottom-front', operand: 'a', fillet: 3, chamfer: 2 },
    cap: { def: 'box-bottom', operand: 'a', skipPlacements: ['coincident'] },
    modifierPlacements: ['aligned', 'off-centre', 'tilted']
  },
  {
    id: 'cylinder×cylinder',
    a: { kind: 'cylinder', name: 'Bar', dims: { radius: 10, height: 60 } },
    b: { kind: 'cylinder', name: 'Drill', dims: { radius: 6, height: 60 } },
    placements: [
      { id: 'aligned', a: [t(-30, 0, 0, vec(0, 90, 0))], b: [t(0, 0, -30)] },
      { id: 'off-centre', a: [t(-30, 0, 0, vec(0, 90, 0))], b: [t(0, 3, -30)] },
      {
        id: 'tilted',
        a: [t(-30, 0, 0, vec(0, 90, 0))],
        b: [t(0, 0, -30), t(0, 0, 0, vec(20, 0, 0))]
      },
      {
        id: 'tangent',
        a: [t(-30, 0, 0, vec(0, 90, 0))],
        b: [t(0, 16, -30)],
        skip: EMPTY_INTERSECT,
        contactOnly: true
      },
      {
        id: 'equal-radius',
        a: [t(-30, 0, 0, vec(0, 90, 0))],
        b: [t(0, 0, -30)],
        bDims: { radius: 10, height: 60 }
      }
    ],
    footprint: 'b',
    grow: { key: 'radius', grow: 7, shrink: 5 },
    directResize: true,
    edge: { def: 'cylinder-start-rim', operand: 'a', fillet: 2, chamfer: 1.5 },
    cap: { def: 'cylinder-end', operand: 'a' },
    modifierPlacements: ['aligned', 'off-centre', 'tilted']
  },
  {
    id: 'box×cone',
    a: BOX,
    b: {
      kind: 'cone',
      name: 'Cone',
      dims: { bottomRadius: 10, topRadius: 4, height: 30 }
    },
    placements: [
      { id: 'aligned', b: [t(30, 30, 32, vec(180, 0, 0))], upright: true },
      { id: 'off-centre', b: [t(38, 25, 32, vec(180, 0, 0))], upright: true },
      { id: 'tilted', b: [t(30, 30, 32, vec(195, 0, 0))] }
    ],
    footprint: 'b',
    grow: { key: 'bottomRadius', grow: 11, shrink: 9 },
    seam: true,
    edge: { def: 'box-bottom-front', operand: 'a', fillet: 3, chamfer: 2 },
    cap: { def: 'box-bottom', operand: 'a' }
  },
  {
    id: 'box×torus',
    a: BOX,
    b: {
      kind: 'torus',
      name: 'Torus',
      dims: { majorRadius: 15, minorRadius: 4 }
    },
    placements: [
      { id: 'aligned', b: [t(30, 30, 20)] },
      { id: 'off-centre', b: [t(33, 27, 20)] },
      { id: 'tilted', b: [t(30, 30, 20, vec(10, 0, 0))] },
      { id: 'tangent', b: [t(30, 30, 24)], skip: EMPTY_INTERSECT },
      { id: 'sliver', b: [t(30, 30, 24 - SLIVER)] },
      // The plane cuts the tube above its equator.
      { id: 'raised', b: [t(30, 30, 22)] }
    ],
    footprint: 'b',
    grow: { key: 'minorRadius', grow: 5, shrink: 3 },
    edge: { def: 'box-bottom-front', operand: 'a', fillet: 3, chamfer: 2 },
    cap: { def: 'box-bottom', operand: 'a' },
    modifierPlacements: ['aligned', 'off-centre', 'tilted', 'raised'],
    excluded: {
      'fillet-seam': 'the torus meets the plane tangentially; no closed form',
      'chamfer-seam': 'the torus meets the plane tangentially; no closed form'
    }
  },
  {
    id: 'box×sphere',
    a: BOX,
    b: { kind: 'sphere', name: 'Sphere', dims: { radius: 10 } },
    placements: [
      { id: 'aligned', b: [t(30, 30, 20)] },
      { id: 'off-centre', b: [t(36, 25, 20)] },
      { id: 'tangent', b: [t(30, 30, 30)], skip: EMPTY_INTERSECT },
      { id: 'sliver', b: [t(30, 30, 30 - SLIVER)] },
      // Every placement above centres the sphere on the face plane, so its
      // hemisphere seam lies in that plane; this one does not.
      { id: 'raised', b: [t(30, 30, 24)] }
    ],
    footprint: 'b',
    grow: { key: 'radius', grow: 12, shrink: 8 },
    edge: { def: 'box-bottom-front', operand: 'a', fillet: 3, chamfer: 2 },
    cap: { def: 'box-bottom', operand: 'a' },
    modifierPlacements: ['aligned', 'off-centre', 'raised'],
    excluded: {
      'fillet-seam': 'a sphere seam has a curved meridian; no closed form',
      'chamfer-seam': 'a sphere seam has a curved meridian; no closed form'
    }
  },
  {
    id: 'box×box',
    a: BOX,
    b: {
      kind: 'box',
      name: 'Block',
      dims: { width: 20, height: 20, depth: 20 }
    },
    placements: [
      { id: 'aligned', b: [t(20, 20, 10)] },
      { id: 'off-centre', b: [t(35, 8, 10)] },
      { id: 'tilted', b: [t(25, 15, 8, vec(15, 0, 30))] },
      { id: 'coincident', b: [t(0, 0, 20)], skip: EMPTY_INTERSECT },
      { id: 'sliver', b: [t(20, 20, 20 - SLIVER)] }
    ],
    footprint: 'b',
    grow: { key: 'width', grow: 24, shrink: 16 },
    edge: { def: 'box-bottom-front', operand: 'a', fillet: 3, chamfer: 2 },
    cap: { def: 'box-bottom', operand: 'a' },
    modifierPlacements: ['aligned', 'off-centre', 'tilted'],
    excluded: {
      'fillet-seam': 'a straight seam ends on concave corners; no closed form',
      'chamfer-seam': 'a straight seam ends on concave corners; no closed form'
    }
  }
];

const BOOLEANS: readonly BooleanKind[] = [
  'union',
  'subtract',
  'intersect',
  'union-reversed',
  'subtract-reversed',
  'intersect-reversed'
];
const MODIFIERS: readonly ModifierKind[] = [
  'no-modifier',
  'fillet-seam',
  'chamfer-seam',
  'fillet-edge',
  'chamfer-edge',
  'cap-offset'
];
const FOLLOW_UPS: readonly FollowUp[] = [
  'none',
  'source-grow',
  'source-shrink',
  'direct-grow',
  'direct-shrink',
  'direct-offset',
  'remove-blend',
  'undo-redo',
  'reopen',
  'step-roundtrip'
];

const isReversed = (kind: BooleanKind) => kind.endsWith('-reversed');
const forward = (kind: BooleanKind) =>
  kind.replace('-reversed', '') as 'union' | 'subtract' | 'intersect';

/** Whether the boolean keeps the target's untouched faces and edges. */
function keepsTarget(kind: BooleanKind): boolean {
  return kind === 'union' || kind === 'union-reversed' || kind === 'subtract';
}

/** Whether the tool's own cap survives the boolean. */
function keepsToolCap(pair: PairDef, kind: BooleanKind): boolean {
  if (pair.id === 'sphere×cylinder') {
    return (
      kind === 'union' ||
      kind === 'union-reversed' ||
      kind === 'subtract-reversed'
    );
  }
  return keepsTarget(kind);
}

function modifierApplies(
  pair: PairDef,
  placement: PlacementDef,
  kind: BooleanKind,
  modifier: ModifierKind
): boolean {
  if (modifier === 'no-modifier') return true;
  if (pair.excluded?.[modifier]) return false;
  if (isReversed(kind)) return false;
  if (
    pair.modifierPlacements &&
    !pair.modifierPlacements.includes(placement.id)
  ) {
    return false;
  }
  if (modifier === 'fillet-seam' || modifier === 'chamfer-seam') {
    return Boolean(pair.seam && placement.upright);
  }
  if (modifier === 'fillet-edge' || modifier === 'chamfer-edge') {
    return Boolean(pair.edge) && keepsTarget(kind);
  }
  return capApplies(pair, placement, kind);
}

function capApplies(
  pair: PairDef,
  placement: PlacementDef,
  kind: BooleanKind
): boolean {
  if (!pair.cap || pair.cap.skipPlacements?.includes(placement.id)) {
    return false;
  }
  return pair.cap.operand === 'a'
    ? keepsTarget(kind)
    : keepsToolCap(pair, kind);
}

function followUpApplies(
  pair: PairDef,
  placement: PlacementDef,
  kind: BooleanKind,
  modifier: ModifierKind,
  followUp: FollowUp,
  scaled: boolean
): boolean {
  if (scaled) {
    return (
      modifier === 'no-modifier' &&
      ['none', 'source-grow', 'step-roundtrip'].includes(followUp)
    );
  }
  if (isReversed(kind)) {
    return modifier === 'no-modifier' && ['none', 'reopen'].includes(followUp);
  }
  if (followUp === 'direct-grow' || followUp === 'direct-shrink') {
    if (!pair.directResize) return false;
    if (placement.contactOnly && kind === 'subtract') return false;
  }
  if (followUp === 'direct-offset' && !capApplies(pair, placement, kind)) {
    return false;
  }
  if (modifier === 'no-modifier') return followUp !== 'remove-blend';
  if (followUp === 'remove-blend') return modifier.startsWith('fillet');
  return ['none', 'source-grow', 'direct-grow', 'reopen'].includes(followUp);
}

function scaleToken(value: number): string {
  return value === 1 ? '' : `@${value.toExponential().replace('e+', 'e')}`;
}

/** Every cell of the matrix, in a stable order. */
export function allCells(): Cell[] {
  const cells: Cell[] = [];
  for (const pair of PAIRS) {
    for (const placement of pair.placements) {
      for (const scaleValue of [1, ...(placement.scales ?? [])]) {
        for (const kind of BOOLEANS) {
          if (placement.skip?.includes(kind)) continue;
          for (const modifier of MODIFIERS) {
            if (scaleValue !== 1 && modifier !== 'no-modifier') continue;
            if (!modifierApplies(pair, placement, kind, modifier)) continue;
            for (const followUp of FOLLOW_UPS) {
              if (
                !followUpApplies(
                  pair,
                  placement,
                  kind,
                  modifier,
                  followUp,
                  scaleValue !== 1
                )
              ) {
                continue;
              }
              cells.push({
                id: `${pair.id}/${placement.id}${scaleToken(scaleValue)}/${kind}/${modifier}/${followUp}`,
                pair: pair.id,
                placement: placement.id,
                scale: scaleValue,
                boolean: kind,
                modifier,
                followUp
              });
            }
          }
        }
      }
    }
  }
  return cells;
}

const SMOKE_EXTRA = new Set([
  // One cell per distinct defect family the campaign found, so CI shows
  // the moment any of them changes state.
  'box×torus/aligned/subtract/no-modifier/none',
  'box×cylinder/aligned/union/fillet-seam/direct-grow',
  'cylinder×cylinder/off-centre/subtract/no-modifier/source-grow',
  'cylinder×cylinder/aligned/union/no-modifier/none',
  'box×sphere/raised/union/no-modifier/none',
  'box×cylinder/aligned/union/no-modifier/none',
  'box×cylinder/aligned/union/no-modifier/source-grow',
  'box×cylinder/aligned/union/no-modifier/direct-grow',
  'box×cylinder/aligned/union/no-modifier/reopen',
  'box×cylinder/aligned/union/no-modifier/step-roundtrip',
  'box×cylinder/aligned/subtract/no-modifier/none',
  'box×cylinder/aligned/subtract/no-modifier/direct-grow',
  'box×cylinder/aligned/subtract/no-modifier/undo-redo',
  'box×cylinder/aligned/intersect/no-modifier/none',
  'box×cylinder/aligned/union/fillet-seam/none',
  'box×cylinder/aligned/union/fillet-seam/source-grow',
  'box×cylinder/aligned/subtract/chamfer-edge/none',
  'box×cylinder/aligned/union/cap-offset/none',
  'box×cylinder/coincident/subtract/no-modifier/none',
  'box×cylinder/aligned@1e3/union/no-modifier/none',
  'cylinder×cylinder/aligned/subtract/no-modifier/none',
  'cylinder×cylinder/aligned/subtract/no-modifier/direct-grow',
  'box×cone/aligned/subtract/no-modifier/none',
  'box×torus/aligned/union/no-modifier/none',
  'box×sphere/aligned/subtract/no-modifier/none',
  'box×box/coincident/union/no-modifier/none'
]);

const FIRST_SLICE = (cell: Cell) =>
  cell.pair === 'sphere×cylinder' &&
  (cell.boolean === 'union' || cell.boolean === 'subtract') &&
  cell.modifier === 'no-modifier' &&
  ['none', 'direct-grow', 'direct-shrink', 'source-grow'].includes(
    cell.followUp
  );

/** The CI slice: the first slice plus one representative per family. */
export function smokeCells(): Cell[] {
  return allCells().filter(
    (cell) => FIRST_SLICE(cell) || SMOKE_EXTRA.has(cell.id)
  );
}

/** The scheduled/full campaign: everything the CI slice does not run. */
export function campaignCells(): Cell[] {
  const smoke = new Set(smokeCells().map((cell) => cell.id));
  return allCells().filter((cell) => !smoke.has(cell.id));
}

export function cellById(id: string): Cell | undefined {
  return allCells().find((cell) => cell.id === id);
}

export function exclusions(): Array<{
  pair: string;
  modifier: string;
  reason: string;
}> {
  return PAIRS.flatMap((pair) =>
    Object.entries(pair.excluded ?? {}).map(([modifier, reason]) => ({
      pair: pair.id,
      modifier,
      reason: reason
    }))
  );
}

// --------------------------------------------------------------- the model

interface OperandModel {
  def: OperandDef;
  dims: Record<string, number>;
  /** Local steps prepended by a cap offset, then the placement's Moves. */
  steps: MoveStep[];
}

interface Model {
  pair: PairDef;
  placement: PlacementDef;
  scale: number;
  boolean: BooleanKind;
  a: OperandModel;
  b: OperandModel;
  modifier?: {
    kind: 'fillet' | 'chamfer';
    target: 'seam' | 'edge';
    size: number;
  };
}

function scaledSteps(steps: readonly MoveStep[], s: number): MoveStep[] {
  return steps.map((step) => ({
    translation: vec(
      step.translation.x * s,
      step.translation.y * s,
      step.translation.z * s
    ),
    ...(step.rotationDeg ? { rotationDeg: step.rotationDeg } : {})
  }));
}

function scaledDims(dims: Record<string, number>, s: number) {
  return Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, v * s]));
}

function initialModel(cell: Cell): Model {
  const pair = PAIRS.find((entry) => entry.id === cell.pair)!;
  const placement = pair.placements.find(
    (entry) => entry.id === cell.placement
  )!;
  const s = cell.scale;
  return {
    pair,
    placement,
    scale: s,
    boolean: cell.boolean,
    a: {
      def: pair.a,
      dims: scaledDims(pair.a.dims, s),
      steps: scaledSteps(placement.a ?? [], s)
    },
    b: {
      def: pair.b,
      dims: scaledDims({ ...pair.b.dims, ...placement.bDims }, s),
      steps: scaledSteps(placement.b, s)
    }
  };
}

function solidOf(operand: OperandModel): SolidModel {
  const d = operand.dims;
  switch (operand.def.kind) {
    case 'box':
      return {
        family: 'box',
        width: d.width!,
        height: d.height!,
        depth: d.depth!
      };
    case 'cylinder':
      return { family: 'cylinder', radius: d.radius!, height: d.height! };
    case 'sphere':
      return { family: 'sphere', radius: d.radius! };
    case 'cone':
      return {
        family: 'cone',
        bottomRadius: d.bottomRadius!,
        topRadius: d.topRadius!,
        height: d.height!
      };
    case 'torus':
      return {
        family: 'torus',
        majorRadius: d.majorRadius!,
        minorRadius: d.minorRadius!
      };
  }
}

const placed = (operand: OperandModel): Placed =>
  place(solidOf(operand), operand.steps);

function material(kind: BooleanKind): (inA: boolean, inB: boolean) => boolean {
  switch (kind) {
    case 'union':
    case 'union-reversed':
      return (a, b) => a || b;
    case 'subtract':
      return (a, b) => a && !b;
    case 'subtract-reversed':
      return (a, b) => b && !a;
    default:
      return (a, b) => a && b;
  }
}

/** The modelled seam: an upright round tool through the box's top face. */
function seamCorner(model: Model): Corner | null {
  const box = placed(model.a);
  const tool = placed(model.b);
  const top = toWorld(box, vec(0, 0, model.a.dims.depth!)).z;
  const axis = directionToWorld(tool, vec(0, 0, 1));
  const solid = tool.solid;
  if (solid.family !== 'cylinder' && solid.family !== 'cone') return null;
  const localZ = (top - tool.translation.z) / axis.z;
  const slope =
    solid.family === 'cone'
      ? (solid.topRadius - solid.bottomRadius) / solid.height
      : 0;
  const radius =
    solid.family === 'cone'
      ? solid.bottomRadius + slope * localZ
      : solid.radius;
  const center = toWorld(tool, vec(0, 0, localZ));
  // Meridian coordinates (radial, world z) with the seam at the origin. The
  // box is z < 0; the tool is radial < k·z, k its radius change per world z.
  const k = slope / axis.z;
  const length = Math.hypot(1, k);
  const wedge = seamWedge(
    { along: [1, 0], outward: [0, 1] },
    { along: [k / length, 1 / length], outward: [1 / length, -k / length] },
    material(model.boolean)
  );
  if (!wedge) return null;
  return { kind: 'circle', center, axis: vec(0, 0, 1), radius, ...wedge };
}

function edgeCorner(model: Model): Corner | null {
  const def = model.pair.edge;
  if (!def) return null;
  const operand = placed(def.operand === 'a' ? model.a : model.b);
  if (def.def === 'box-bottom-front') {
    const width = (def.operand === 'a' ? model.a : model.b).dims.width!;
    return {
      kind: 'line',
      start: toWorld(operand, vec(0, 0, 0)),
      end: toWorld(operand, vec(width, 0, 0)),
      d1: [1, 0],
      d2: [0, 1],
      convex: true
    };
  }
  const solid = operand.solid;
  if (solid.family !== 'cylinder') return null;
  return {
    kind: 'circle',
    center: toWorld(operand, vec(0, 0, 0)),
    axis: directionToWorld(operand, vec(0, 0, 1)),
    radius: solid.radius,
    // Meridian (radial, along the axis into the bar).
    d1: [-1, 0],
    d2: [0, 1],
    convex: true
  };
}

function modifierCorner(model: Model): Corner | null {
  if (!model.modifier) return null;
  return model.modifier.target === 'seam'
    ? seamCorner(model)
    : edgeCorner(model);
}

interface Expectation {
  volume: number;
  /** Oracle error estimate (two-resolution difference), already ≥ 0. */
  error: number;
}

const expectations = new Map<string, Expectation>();

function expectedVolume(model: Model): Expectation {
  const key = JSON.stringify([
    model.pair.id,
    model.a.dims,
    model.a.steps,
    model.b.dims,
    model.b.steps,
    model.boolean,
    model.modifier
  ]);
  const memo = expectations.get(key);
  if (memo) return memo;
  const result = computeExpectedVolume(model);
  expectations.set(key, result);
  return result;
}

function computeExpectedVolume(model: Model): Expectation {
  const a = placed(model.a);
  const b = placed(model.b);
  const va = closedFormVolume(a.solid);
  const vb = closedFormVolume(b.solid);
  const overlap =
    model.pair.footprint === 'b'
      ? overlapWithError(b, a)
      : overlapWithError(a, b);
  let volume: number;
  switch (forward(model.boolean)) {
    case 'union':
      volume = va + vb - overlap.value;
      break;
    case 'subtract':
      volume = isReversed(model.boolean)
        ? vb - overlap.value
        : va - overlap.value;
      break;
    default:
      volume = overlap.value;
  }
  const corner = modifierCorner(model);
  if (model.modifier && corner) {
    volume += cornerVolumeChange(
      corner,
      model.modifier.kind,
      model.modifier.size
    );
  }
  return { volume, error: overlap.error };
}

function capPlane(model: Model): { point: Vec3; normal: Vec3 } | null {
  const cap = model.pair.cap;
  if (!cap) return null;
  const operand = cap.operand === 'a' ? model.a : model.b;
  const p = placed(operand);
  if (cap.def === 'box-bottom') {
    return {
      point: toWorld(
        p,
        vec(operand.dims.width! / 2, operand.dims.height! / 2, 0)
      ),
      normal: directionToWorld(p, vec(0, 0, -1))
    };
  }
  return {
    point: toWorld(p, vec(0, 0, operand.dims.height!)),
    normal: directionToWorld(p, vec(0, 0, 1))
  };
}

/** The model after the cap plane moves outward by `distance`. */
function offsetCap(model: Model, distance: number): Model {
  const cap = model.pair.cap!;
  const key = cap.operand;
  const operand = model[key];
  const next: OperandModel = {
    ...operand,
    dims: { ...operand.dims },
    steps: [...operand.steps]
  };
  if (cap.def === 'box-bottom') {
    next.dims.depth = next.dims.depth! + distance;
    next.steps = [{ translation: vec(0, 0, -distance) }, ...next.steps];
  } else {
    next.dims.height = next.dims.height! + distance;
  }
  return { ...model, [key]: next };
}

function withToolDimension(model: Model, key: string, value: number): Model {
  return {
    ...model,
    b: { ...model.b, dims: { ...model.b.dims, [key]: value } }
  };
}

// --------------------------------------------------------------- the runner

export interface Session {
  adapter: ExactKernelAdapter;
  deadline: number;
}

export class CellTimeout extends Error {}

export async function sync(
  session: Session,
  document: ProjectDocument,
  bodyId?: BodyId
): Promise<DerivedState> {
  if (Date.now() > session.deadline) throw new CellTimeout('budget spent');
  return session.adapter.syncDocument(
    document,
    undefined,
    undefined,
    undefined,
    {
      cancellation: { isCancelled: () => Date.now() > session.deadline },
      ...(bodyId ? { lineageDemand: [bodyId] } : {})
    }
  );
}

/**
 * A sync on a new adapter: a reload, with no memory of any earlier build.
 * A reopen check on the session's own adapter could not tell a document
 * that rebuilds from one the session only rebuilds from memory.
 */
export async function coldSync(
  session: Session,
  document: ProjectDocument,
  bodyId?: BodyId
): Promise<DerivedState> {
  const adapter = await createExactKernelAdapter();
  try {
    return await sync({ ...session, adapter }, document, bodyId);
  } finally {
    adapter.dispose();
  }
}

/**
 * Commits a validated edit the way the app does (`executeCommand`): when the
 * rebuild carried a hash-only fillet/chamfer selection, the new hashes land
 * in the same revision. The committed document must then rebuild the same
 * body cold, since nothing else will remember the old edges. Returns the
 * manager holding the committed document, or the cell's outcome when the
 * carry could not be stored or does not survive a reload.
 */
export async function commitWithCarry(
  session: Session,
  before: ProjectDocument,
  label: string,
  commands: AnyCommand[],
  derived: DerivedState,
  bodyId: BodyId
): Promise<{ manager: CommandManager } | { stopped: CellOutcome }> {
  const manager = new CommandManager(before);
  const carried = withCarriedSelections(before, commands, derived);
  if ('refusal' in carried) {
    return {
      stopped: {
        state: 'wrong',
        evidence: `the carried selection could not be stored: ${carried.refusal}`
      }
    };
  }
  manager.runTransaction(label, carried.commands);
  if (carried.commands.length === commands.length) return { manager };
  const cold = await coldSync(session, manager.document, bodyId);
  const refused = refusal(cold, 'cold reopen after the carry');
  if (refused) return { stopped: refused };
  const shown = derived.bodyRepresentations[bodyId];
  const reopened = cold.bodyRepresentations[bodyId];
  if (!shown || !reopened || !sameBody(shown, reopened)) {
    return {
      stopped: {
        state: 'wrong',
        evidence: `the carried edit reopens differently: ${reopened?.volume} ${reopened ? census(reopened) : ''} vs ${shown?.volume}`
      }
    };
  }
  return { manager };
}

/** The refusal a sync carries, or null when every feature built. */
export function refusal(
  derived: DerivedState,
  step: string
): CellOutcome | null {
  const featureWarnings = derived.featureWarnings ?? [];
  const blocking = featureWarnings.filter(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );
  const advisory = new Set(
    featureWarnings
      .filter(
        (warning) =>
          warning.kind === 'advisory' || warning.kind === 'suppressed'
      )
      .map((warning) => warning.message)
  );
  const unexplained = derived.warnings.filter(
    (message) => !advisory.has(message)
  );
  if (blocking.length === 0 && unexplained.length === 0) return null;
  const typed = blocking.find((warning) => warning.kernelRefusal);
  const text = (
    blocking.length > 0 ? blocking.map((w) => w.message) : unexplained
  )
    .join(' | ')
    .slice(0, 400);
  return typed
    ? {
        state: 'typed-refusal',
        evidence: `${step}: ${typed.kernelRefusal!.family}/${typed.kernelRefusal!.category}/${typed.kernelRefusal!.code} — ${text}`
      }
    : { state: 'untyped-refusal', evidence: `${step}: ${text}` };
}

function lengthTolerance(model: Model): number {
  return 1e-6 * Math.max(1, 60 * model.scale);
}

function close(a: Vec3, b: Vec3, tolerance: number): boolean {
  return norm(sub(a, b)) <= tolerance;
}

/** Result edges lying on the modelled corner, matched by exact curve data. */
function cornerEdges(
  body: BodyRepresentation,
  corner: Corner,
  tolerance: number
): EdgeTopology[] {
  return (body.topology?.edges ?? []).filter((edge) => {
    if (edge.displayRole === 'seam') return false;
    if (corner.kind === 'circle') {
      const circle = edge.curve?.circle;
      return (
        circle !== undefined &&
        Math.abs(circle.radius - corner.radius) <= tolerance &&
        close(circle.center, corner.center, tolerance) &&
        Math.abs(Math.abs(dot(circle.axis, corner.axis)) - 1) <= 1e-9
      );
    }
    const p = edge.points;
    if (edge.curve?.type !== 'LINE' || p.length < 6) return false;
    const first = vec(p[0]!, p[1]!, p[2]!);
    const last = vec(p[p.length - 3]!, p[p.length - 2]!, p[p.length - 1]!);
    return (
      (close(first, corner.start, tolerance) &&
        close(last, corner.end, tolerance)) ||
      (close(first, corner.end, tolerance) &&
        close(last, corner.start, tolerance))
    );
  });
}

function capFace(
  body: BodyRepresentation,
  plane: { point: Vec3; normal: Vec3 },
  tolerance: number
) {
  return (body.topology?.faces ?? []).find((face) => {
    const g = face.geometry;
    if (g?.surfaceType !== 'plane' || !g.normal || !g.center) return false;
    return (
      dot(g.normal, plane.normal) > 1 - 1e-9 &&
      Math.abs(dot(sub(g.center, plane.point), plane.normal)) <= tolerance
    );
  });
}

function toolWall(
  body: BodyRepresentation,
  model: Model,
  tolerance: number
): FaceTopology | undefined {
  const axis = directionToWorld(placed(model.b), vec(0, 0, 1));
  return (body.topology?.faces ?? []).find((face) => {
    const g = face.geometry;
    if (g?.surfaceType !== 'cylinder' || !g.axisStart || !g.axisEnd)
      return false;
    const along = sub(g.axisEnd, g.axisStart);
    return (
      Math.abs((g.radius ?? 0) - model.b.dims.radius!) <= tolerance &&
      Math.abs(Math.abs(dot(along, axis)) / norm(along) - 1) <= 1e-9
    );
  });
}

interface Stage {
  manager: CommandManager;
  derived: DerivedState;
  bodyId: BodyId;
  model: Model;
  toolFeatureId: FeatureId;
  modifierFeatureId?: FeatureId;
  /** What a non-qualified build said, when the history already stopped. */
  stopped?: CellOutcome;
  /** Planner route a cap offset took, for the evidence. */
  notes: string[];
}

/** Builds the history document: two placed primitives. */
export function historyDocument(cell: Cell): {
  document: ProjectDocument;
  a: BodyId;
  b: BodyId;
  toolFeatureId: FeatureId;
} {
  const model = initialModel(cell);
  let document = createProjectDocument(
    'Combination matrix',
    toUserId('user_k10_matrix')
  );
  const bodies: BodyId[] = [];
  for (const [key, label] of [
    ['a', model.a.def.name],
    ['b', model.b.def.name]
  ] as const) {
    const operand = model[key];
    document = addPrimitiveFeature(document, {
      name: label,
      bodyName: `${label} 1`,
      primitiveKind: operand.def.kind,
      dimensions: operand.dims
    });
    const bodyId = document.bodyOrder.at(-1)!;
    bodies.push(bodyId);
    operand.steps.forEach((step, index) => {
      document = transformBody(document, {
        name: index === 0 ? `Place ${label}` : `Move ${label} ${index + 1}`,
        targetBodyId: bodyId,
        translation: step.translation,
        ...(step.rotationDeg ? { rotationDeg: step.rotationDeg } : {})
      }).document;
    });
  }
  const toolFeatureId = listNodesByKind(document, 'feature').find(
    (feature) => feature.name === model.b.def.name
  )!.featureId;
  return { document, a: bodies[0]!, b: bodies[1]!, toolFeatureId };
}

function modifierModel(model: Model, modifier: ModifierKind): Model {
  const s = model.scale;
  switch (modifier) {
    case 'fillet-seam':
      return {
        ...model,
        modifier: { kind: 'fillet', target: 'seam', size: SEAM_FILLET * s }
      };
    case 'chamfer-seam':
      return {
        ...model,
        modifier: { kind: 'chamfer', target: 'seam', size: SEAM_CHAMFER * s }
      };
    case 'fillet-edge':
      return {
        ...model,
        modifier: {
          kind: 'fillet',
          target: 'edge',
          size: model.pair.edge!.fillet * s
        }
      };
    case 'chamfer-edge':
      return {
        ...model,
        modifier: {
          kind: 'chamfer',
          target: 'edge',
          size: model.pair.edge!.chamfer * s
        }
      };
    default:
      return model;
  }
}

async function offsetCapStep(
  session: Session,
  stage: Stage,
  distance: number,
  label: string
): Promise<Stage> {
  const plane = capPlane(stage.model)!;
  const body = stage.derived.bodyRepresentations[stage.bodyId]!;
  const face = capFace(body, plane, lengthTolerance(stage.model));
  if (!face) {
    return {
      ...stage,
      stopped: {
        state: 'wrong',
        evidence: `${label}: the modelled cap plane is not a face of the result`
      }
    };
  }
  const plan = planFaceOffset({
    document: { ...stage.manager.document, derived: stage.derived },
    bodyId: stage.bodyId,
    face,
    faceHash: face.hash,
    offset: distance
  });
  if (!plan) {
    return {
      ...stage,
      stopped: {
        state: 'untyped-refusal',
        evidence: `${label}: no offset plan`
      }
    };
  }
  if ('preflightRejection' in plan && plan.preflightRejection) {
    return {
      ...stage,
      stopped: {
        state: 'typed-refusal',
        evidence: `${label}: planner refused — ${plan.preflightRejection}`
      }
    };
  }
  stage.manager.execute(plan.command);
  const bodyId = stage.manager.document.bodyOrder.at(-1)!;
  const derived = await sync(session, stage.manager.document, bodyId);
  const next: Stage = {
    ...stage,
    derived,
    bodyId,
    model: offsetCap(stage.model, distance),
    notes: [...stage.notes, `${label} via ${plan.kind}`]
  };
  const refused = refusal(derived, label);
  return refused ? { ...next, stopped: refused } : next;
}

/** Runs the history up to and including the modifier. */
async function buildStage(session: Session, cell: Cell): Promise<Stage> {
  const source = historyDocument(cell);
  const manager = new CommandManager(source.document);
  const targets = isReversed(cell.boolean)
    ? [source.b, source.a]
    : [source.a, source.b];
  const op = forward(cell.boolean);
  manager.execute(
    commandFactories.booleanBodies({
      name:
        op === 'union' ? 'Union' : op === 'subtract' ? 'Subtract' : 'Intersect',
      operation: op,
      targetBodyIds: targets
    })
  );
  let bodyId = manager.document.bodyOrder.at(-1)!;
  let derived = await sync(session, manager.document, bodyId);
  let model = initialModel(cell);
  const stage: Stage = {
    manager,
    derived,
    bodyId,
    model,
    toolFeatureId: source.toolFeatureId,
    notes: []
  };
  const refused = refusal(derived, 'boolean');
  if (refused) return { ...stage, stopped: refused };
  if (cell.modifier === 'no-modifier') return stage;
  if (cell.modifier === 'cap-offset') {
    return offsetCapStep(session, stage, OFFSET * cell.scale, 'cap offset');
  }
  model = modifierModel(model, cell.modifier);
  const corner = modifierCorner(model);
  if (!corner) {
    return {
      ...stage,
      stopped: {
        state: 'wrong',
        evidence: 'the boolean leaves no modelled edge to blend'
      }
    };
  }
  const edges = cornerEdges(
    derived.bodyRepresentations[bodyId]!,
    corner,
    lengthTolerance(model)
  );
  if (edges.length === 0) {
    return {
      ...stage,
      stopped: {
        state: 'wrong',
        evidence: `the modelled ${corner.kind} edge is not on the result`
      }
    };
  }
  const references = edges.map((edge) => edge.reference);
  const input = {
    name: cell.modifier.startsWith('fillet') ? 'Fillet edges' : 'Chamfer edges',
    targetBodyId: bodyId,
    edgeHashes: edges.map((edge) => edge.hash),
    ...(references.every((reference) => reference !== undefined)
      ? { edgeReferences: references }
      : {}),
    size: model.modifier!.size
  };
  const command = cell.modifier.startsWith('fillet')
    ? commandFactories.filletEdges(input)
    : commandFactories.chamferEdges(input);
  manager.execute(command);
  const modifierFeatureId = (
    command.payload as { ids: { featureId: FeatureId } }
  ).ids.featureId;
  bodyId = manager.document.bodyOrder.at(-1)!;
  derived = await sync(session, manager.document, bodyId);
  const next: Stage = {
    ...stage,
    derived,
    bodyId,
    model,
    modifierFeatureId,
    notes: [
      `${edges.length} edge(s), references ${input.edgeReferences ? 'kept' : 'hash-only'}`
    ]
  };
  const blocked = refusal(derived, cell.modifier);
  return blocked ? { ...next, stopped: blocked } : next;
}

export function census(body: BodyRepresentation): string {
  return `${body.topology?.faces.length ?? 0}f/${body.topology?.edges.length ?? 0}e`;
}

function volumeTolerance(model: Model, expected: Expectation): number {
  // The first slice's documented tolerance, max(0.05 mm³, 1e-6·V), at the
  // cell's scale, widened only by the oracle's own two-resolution error
  // estimate. Never derived from the kernel result.
  return Math.max(
    4 * expected.error,
    0.05 * model.scale ** 3,
    1e-6 * Math.abs(expected.volume)
  );
}

/** The exact-success oracles for one built body. */
function qualify(
  body: BodyRepresentation | undefined,
  model: Model,
  notes: string[]
): CellOutcome {
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
  const expected = expectedVolume(model);
  const tolerance = volumeTolerance(model, expected);
  if (Math.abs(body.volume - expected.volume) > tolerance) {
    return {
      state: 'wrong',
      evidence: `volume ${body.volume} differs from oracle ${expected.volume} by ${body.volume - expected.volume} (tolerance ${tolerance.toPrecision(3)})`
    };
  }
  return {
    state: 'qualified',
    evidence: [
      `volume ${body.volume.toPrecision(12)} (oracle ±${tolerance.toPrecision(2)})`,
      census(body),
      ...notes
    ].join('; ')
  };
}

/** After a radius edit, the tool wall the stage had must sit at the new radius. */
function wallCheck(
  body: BodyRepresentation | undefined,
  model: Model,
  before: Stage
): CellOutcome | null {
  if (!model.pair.directResize || !body) return null;
  const had = before.derived.bodyRepresentations[before.bodyId];
  if (!had || !toolWall(had, before.model, lengthTolerance(before.model)))
    return null;
  const tolerance = lengthTolerance(model);
  return toolWall(body, model, tolerance)
    ? null
    : {
        state: 'wrong',
        evidence: `no analytic tool wall at r = ${model.b.dims.radius}`
      };
}

export function sameBody(
  left: BodyRepresentation,
  right: BodyRepresentation
): boolean {
  return (
    Math.abs(left.volume - right.volume) <=
      1e-9 * Math.max(1, Math.abs(left.volume)) &&
    census(left) === census(right)
  );
}

async function sourceEdit(
  session: Session,
  stage: Stage,
  value: number
): Promise<{ stage: Stage; refused?: CellOutcome }> {
  const key = stage.model.pair.grow.key;
  const before = stage.manager.document;
  let manager = new CommandManager(before);
  const feature = listNodesByKind(manager.document, 'feature').find(
    (node) => node.featureId === stage.toolFeatureId
  )!;
  const dims =
    feature.data.featureKind === 'primitive' ? feature.data.dimensions : {};
  const edit = commandFactories.updateFeature(
    {
      featureId: stage.toolFeatureId,
      data: { dimensions: { ...dims, [key]: value } }
    },
    `Resize ${stage.model.b.def.name}`
  );
  manager.execute(edit);
  const bodyId = manager.document.bodyOrder.at(-1)!;
  const derived = await sync(session, manager.document, bodyId);
  const refused = refusal(derived, 'source edit');
  if (!refused) {
    const committed = await commitWithCarry(
      session,
      before,
      edit.label,
      [edit],
      derived,
      bodyId
    );
    if ('stopped' in committed) {
      return { stage: { ...stage, manager, derived, bodyId }, refused: committed.stopped };
    }
    manager = committed.manager;
  }
  const next: Stage = {
    ...stage,
    manager,
    derived,
    bodyId,
    model: withToolDimension(stage.model, key, value)
  };
  return refused ? { stage: next, refused } : { stage: next };
}

async function directResize(
  session: Session,
  stage: Stage,
  radius: number
): Promise<{ stage: Stage; refused?: CellOutcome }> {
  const body = stage.derived.bodyRepresentations[stage.bodyId]!;
  const wall = toolWall(body, stage.model, lengthTolerance(stage.model));
  const geometry = wall?.geometry;
  if (!wall || !geometry?.axisStart || !geometry.axisEnd) {
    return {
      stage,
      refused: {
        state: 'wrong',
        evidence: 'no tool wall on the result to resize'
      }
    };
  }
  const manager = new CommandManager(stage.manager.document);
  const op = stage.model.boolean;
  manager.execute(
    commandFactories.directEditBody({
      name: 'Resize Cylinder',
      targetBodyId: stage.bodyId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: wall.hash,
        ...(wall.reference ? { faceReference: wall.reference } : {}),
        sourceRadius: stage.model.b.dims.radius!,
        sourceAxisStart: geometry.axisStart,
        sourceAxisEnd: geometry.axisEnd,
        concavity: op === 'subtract' ? 'hole' : 'boss',
        radius
      }
    })
  );
  const bodyId = manager.document.bodyOrder.at(-1)!;
  const derived = await sync(session, manager.document, bodyId);
  const next: Stage = {
    ...stage,
    manager,
    derived,
    bodyId,
    model: withToolDimension(stage.model, 'radius', radius)
  };
  const refused = refusal(derived, 'direct resize');
  return refused ? { stage: next, refused } : { stage: next };
}

function compareRoutes(
  direct: BodyRepresentation,
  source: BodyRepresentation,
  model: Model
): CellOutcome | null {
  const tolerance = volumeTolerance(model, expectedVolume(model));
  const bboxGap = Math.max(
    norm(sub(direct.bbox.min, source.bbox.min)),
    norm(sub(direct.bbox.max, source.bbox.max))
  );
  if (
    Math.abs(direct.volume - source.volume) > tolerance ||
    bboxGap > 1e-5 * Math.max(1, 60 * model.scale)
  ) {
    return {
      state: 'wrong',
      evidence: `direct and source routes differ: volume ${direct.volume} vs ${source.volume}, bbox gap ${bboxGap}`
    };
  }
  return null;
}

async function followUp(
  session: Session,
  cell: Cell,
  stage: Stage
): Promise<CellOutcome> {
  const body = () => stage.derived.bodyRepresentations[stage.bodyId];
  const grow = stage.model.pair.grow;
  const s = cell.scale;
  switch (cell.followUp) {
    case 'none': {
      return qualify(body(), stage.model, stage.notes);
    }
    case 'source-grow':
    case 'source-shrink': {
      const value =
        (cell.followUp === 'source-grow' ? grow.grow : grow.shrink) * s;
      const { stage: next, refused } = await sourceEdit(session, stage, value);
      if (refused) return refused;
      const out = next.derived.bodyRepresentations[next.bodyId];
      return (
        wallCheck(out, next.model, stage) ??
        qualify(out, next.model, stage.notes)
      );
    }
    case 'direct-grow':
    case 'direct-shrink': {
      const value =
        (cell.followUp === 'direct-grow' ? grow.grow : grow.shrink) * s;
      const { stage: next, refused } = await directResize(
        session,
        stage,
        value
      );
      if (refused) return refused;
      const out = next.derived.bodyRepresentations[next.bodyId];
      const verdict =
        wallCheck(out, next.model, stage) ??
        qualify(out, next.model, stage.notes);
      if (verdict.state !== 'qualified' || !out) return verdict;
      // Route equivalence: the same radius through the source dimension.
      const viaSource = await sourceEdit(session, stage, value);
      if (viaSource.refused) {
        return {
          ...verdict,
          evidence: `${verdict.evidence}; source route refused, no equivalence check`
        };
      }
      return (
        compareRoutes(
          out,
          viaSource.stage.derived.bodyRepresentations[viaSource.stage.bodyId]!,
          next.model
        ) ?? {
          ...verdict,
          evidence: `${verdict.evidence}; matches the source route`
        }
      );
    }
    case 'direct-offset': {
      const next = await offsetCapStep(
        session,
        stage,
        OFFSET * s,
        'direct offset'
      );
      if (next.stopped) return next.stopped;
      return qualify(
        next.derived.bodyRepresentations[next.bodyId],
        next.model,
        next.notes
      );
    }
    case 'remove-blend': {
      const band = (body()?.topology?.faces ?? []).find((face) => {
        const carrier = blendCarrierSnapshot(face.geometry);
        return (
          carrier &&
          Math.abs(carrier.radius - stage.model.modifier!.size) <=
            lengthTolerance(stage.model)
        );
      });
      const carrier = band && blendCarrierSnapshot(band.geometry);
      if (!band || !carrier) {
        return {
          state: 'wrong',
          evidence: 'no analytic blend band at the fillet radius'
        };
      }
      const manager = new CommandManager(stage.manager.document);
      manager.execute(
        commandFactories.directEditBody({
          name: 'Remove blend',
          targetBodyId: stage.bodyId,
          operation: {
            kind: 'resize-blend',
            faceHash: band.hash,
            ...(band.reference ? { faceReference: band.reference } : {}),
            surfaceClass: carrier.surfaceClass,
            recordedRadius: carrier.radius,
            recordedCenter: carrier.center,
            recordedAxis: carrier.axis,
            newRadius: 0
          }
        })
      );
      const bodyId = manager.document.bodyOrder.at(-1)!;
      const derived = await sync(session, manager.document, bodyId);
      const refused = refusal(derived, 'remove blend');
      if (refused) return refused;
      const plain = { ...stage.model, modifier: undefined };
      const out = derived.bodyRepresentations[bodyId];
      const verdict = qualify(out, plain, stage.notes);
      if (verdict.state !== 'qualified' || !out) return verdict;
      // Route equivalence: deleting the fillet from history.
      const history = new CommandManager(stage.manager.document);
      history.execute(
        commandFactories.deleteFeature({ featureId: stage.modifierFeatureId! })
      );
      const historyBody = history.document.bodyOrder.at(-1)!;
      const viaHistory = await sync(session, history.document, historyBody);
      if (refusal(viaHistory, 'delete fillet')) {
        return {
          ...verdict,
          evidence: `${verdict.evidence}; history route refused`
        };
      }
      return (
        compareRoutes(
          out,
          viaHistory.bodyRepresentations[historyBody]!,
          plain
        ) ?? {
          ...verdict,
          evidence: `${verdict.evidence}; matches deleting the fillet`
        }
      );
    }
    case 'undo-redo': {
      const before = body()!;
      stage.manager.undo();
      const undone = await sync(session, stage.manager.document);
      const undoRefused = refusal(undone, 'undo');
      if (undoRefused) return undoRefused;
      stage.manager.redo();
      const bodyId = stage.manager.document.bodyOrder.at(-1)!;
      const redone = await sync(session, stage.manager.document, bodyId);
      const refused = refusal(redone, 'redo');
      if (refused) return refused;
      const after = redone.bodyRepresentations[bodyId];
      if (!after || !sameBody(before, after)) {
        return {
          state: 'wrong',
          evidence: `redo differs: ${after?.volume} ${after ? census(after) : ''} vs ${before.volume} ${census(before)}`
        };
      }
      return qualify(after, stage.model, [
        ...stage.notes,
        'redo reproduces volume and census'
      ]);
    }
    case 'reopen': {
      const before = body()!;
      const stored = JSON.parse(
        JSON.stringify(withoutDerivedProjection(stage.manager.document))
      ) as ProjectDocument;
      const reopened = normalizeDocument(stored);
      const bodyId = reopened.bodyOrder.at(-1)!;
      const derived = await coldSync(session, reopened, bodyId);
      const refused = refusal(derived, 'reopen');
      if (refused) return refused;
      const after = derived.bodyRepresentations[bodyId];
      if (!after || !sameBody(before, after)) {
        return {
          state: 'wrong',
          evidence: `reopened body differs: ${after?.volume} ${after ? census(after) : ''} vs ${before.volume} ${census(before)}`
        };
      }
      return qualify(after, stage.model, [
        ...stage.notes,
        'reopen reproduces volume and census'
      ]);
    }
    case 'step-roundtrip': {
      const verdict = qualify(body(), stage.model, stage.notes);
      if (verdict.state !== 'qualified') return verdict;
      const step = await session.adapter.exportStep(
        { ...stage.manager.document, derived: stage.derived },
        [stage.bodyId]
      );
      const inspected = await session.adapter.inspectStep(step);
      if (!inspected.solid) {
        // The reader refused our own file: a refusal, not bad geometry.
        return {
          state: 'untyped-refusal',
          evidence: `STEP reimport refused: ${inspected.reason ?? 'no solid'}`
        };
      }
      if (!inspected.valid) {
        return {
          state: 'wrong',
          evidence: `STEP reimport is not a valid solid: ${inspected.reason ?? ''}`
        };
      }
      const expected = expectedVolume(stage.model);
      const tolerance = volumeTolerance(stage.model, expected);
      if (Math.abs(inspected.volume - expected.volume) > tolerance) {
        return {
          state: 'wrong',
          evidence: `STEP reimport volume ${inspected.volume} differs from oracle ${expected.volume}`
        };
      }
      return {
        ...verdict,
        evidence: `${verdict.evidence}; STEP round trip ${inspected.volume.toPrecision(12)}`
      };
    }
  }
}

/** Runs one cell from an empty document within `budgetMs`. */
export async function runCell(
  adapter: ExactKernelAdapter,
  cell: Cell,
  budgetMs = 90_000
): Promise<CellOutcome> {
  const session: Session = { adapter, deadline: Date.now() + budgetMs };
  try {
    const stage = await buildStage(session, cell);
    if (stage.stopped) return stage.stopped;
    return await followUp(session, cell, stage);
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

// ------------------------------------------------- shrinking and reporting

/** A copy-pasteable description of the cell's history, for a reproduction. */
export function reproduction(cell: Cell): string {
  const model = initialModel(cell);
  const steps = (operand: OperandModel) =>
    operand.steps
      .map((step) => {
        const r = step.rotationDeg;
        const move = `move (${step.translation.x}, ${step.translation.y}, ${step.translation.z})`;
        return r ? `rotate (${r.x}°, ${r.y}°, ${r.z}°) then ${move}` : move;
      })
      .join(', ');
  const lines = [
    `K10 cell ${cell.id}`,
    `1. ${model.a.def.kind} ${JSON.stringify(model.a.dims)}${model.a.steps.length ? `; ${steps(model.a)}` : ''}`,
    `2. ${model.b.def.kind} ${JSON.stringify(model.b.dims)}; ${steps(model.b)}`,
    `3. ${forward(cell.boolean)} of ${isReversed(cell.boolean) ? '[2, 1]' : '[1, 2]'}`
  ];
  if (cell.modifier !== 'no-modifier') {
    const sized = modifierModel(model, cell.modifier).modifier;
    lines.push(
      `4. ${cell.modifier}${sized ? ` size ${sized.size}` : ` by ${OFFSET * cell.scale}`}`
    );
  }
  if (cell.followUp !== 'none') {
    lines.push(
      `${lines.length}. ${cell.followUp} (${model.pair.grow.key} → grow ${model.pair.grow.grow * cell.scale} / shrink ${model.pair.grow.shrink * cell.scale})`
    );
  }
  lines.push(
    `Run: K10_CELL='${cell.id}' pnpm exec vitest run test/combination-matrix`
  );
  return lines.join('\n');
}

/**
 * Greedy shrinker: drops the follow-up, then the modifier, then collapses
 * the scale, placement and boolean, keeping each simplification while the
 * cell still lands in the same non-qualified state. Each probe is a full
 * cell run, so this is opt-in (`K10_SHRINK=1`).
 */
export async function shrinkCell(
  adapter: ExactKernelAdapter,
  cell: Cell,
  state: CellState
): Promise<Cell> {
  let current = cell;
  const pair = PAIRS.find((entry) => entry.id === cell.pair)!;
  const tries: Array<(c: Cell) => Partial<Cell>> = [
    () => ({ followUp: 'none' }),
    () => ({ modifier: 'no-modifier' }),
    () => ({ scale: 1 }),
    () => ({ placement: pair.placements[0]!.id }),
    (c) => ({ boolean: forward(c.boolean) }),
    () => ({ boolean: 'union' })
  ];
  for (const patch of tries) {
    const candidateAxes = { ...current, ...patch(current) };
    const candidate = allCells().find(
      (entry) =>
        entry.pair === candidateAxes.pair &&
        entry.placement === candidateAxes.placement &&
        entry.scale === candidateAxes.scale &&
        entry.boolean === candidateAxes.boolean &&
        entry.modifier === candidateAxes.modifier &&
        entry.followUp === candidateAxes.followUp
    );
    if (!candidate || candidate.id === current.id) continue;
    if ((await runCell(adapter, candidate)).state === state)
      current = candidate;
  }
  return current;
}

export function summarize(
  states: Record<string, CellState>
): Record<CellState, number> {
  const counts = Object.fromEntries(
    CELL_STATES.map((state) => [state, 0])
  ) as Record<CellState, number>;
  for (const state of Object.values(states)) counts[state] += 1;
  return counts;
}
