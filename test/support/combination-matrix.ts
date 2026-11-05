/**
 * K10 combination qualification matrix: generated histories, independent
 * oracles and a committed per-cell ledger.
 *
 * A cell is one history (operand family × placement × boolean × modifier)
 * followed by one edit. Each cell resolves to exactly one state:
 *
 * - `qualified`: the edit built, the body is exact and exportable, the
 *   display mesh is closed and consistently oriented, and its volume agrees
 *   with an oracle computed here without the kernel;
 * - `typed-refusal`: the edit refused and the feature warning carries the
 *   kernel's typed classification (`kernelRefusal`);
 * - `untyped-refusal`: the edit refused with kernel prose only, which the
 *   product can only show as text;
 * - `wrong`: the edit built but an oracle disagrees.
 *
 * The ledger is a ratchet in both directions: a cell that changes state
 * fails until the ledger is edited in the same change, so an improvement is
 * recorded and a regression is a visible diff. See
 * docs/plans/kernel-robustness-plan-2026-11-05.md (WS1).
 */
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listNodesByKind,
  transformBody
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../../packages/kernel-adapter/src/boolean-result-validation';

export type CellState =
  'qualified' | 'typed-refusal' | 'untyped-refusal' | 'wrong';

export type Placement = 'off-axis' | 'tilted';
export type BooleanKind = 'union' | 'subtract';
export type FollowUp = 'none' | 'direct-grow' | 'direct-shrink' | 'source-grow';

export interface Cell {
  id: string;
  placement: Placement;
  boolean: BooleanKind;
  followUp: FollowUp;
}

export interface CellOutcome {
  state: CellState;
  /** What decided the state, for the failure message. */
  evidence: string;
}

const SPHERE_RADIUS = 73.5;
const SPHERE_CENTER = { x: 25.5, y: -1.5, z: 0 } as const;
const CYLINDER_RADIUS = 6;
const CYLINDER_HEIGHT = 64.10000000000001;
const GROW_RADIUS = 7;
const SHRINK_RADIUS = 5;
const TILT = { x: 20, y: 10, z: 0 } as const;

/** First slice: sphere × cylinder boss/bore, no modifier. */
export function sphereCylinderCells(): Cell[] {
  const cells: Cell[] = [];
  for (const placement of ['off-axis', 'tilted'] as const) {
    for (const boolean of ['union', 'subtract'] as const) {
      for (const followUp of [
        'none',
        'direct-grow',
        'direct-shrink',
        'source-grow'
      ] as const) {
        cells.push({
          id: `sphere×cylinder/${placement}/${boolean}/no-modifier/${followUp}`,
          placement,
          boolean,
          followUp
        });
      }
    }
  }
  return cells;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface CylinderFrame {
  base: Vec3;
  axis: Vec3;
  height: number;
}

interface History {
  document: ProjectDocument;
  sphere: BodyId;
  cylinder: BodyId;
  cylinderFeatureId: FeatureId;
}

function history(placement: Placement): History {
  let document = addPrimitiveFeature(
    createProjectDocument('Combination matrix', toUserId('user_k10_matrix')),
    {
      name: 'Sphere',
      bodyName: 'Sphere 1',
      primitiveKind: 'sphere',
      dimensions: { radius: SPHERE_RADIUS }
    }
  );
  const sphere = document.bodyOrder[0]!;
  document = transformBody(document, {
    name: 'Place sphere',
    targetBodyId: sphere,
    translation: SPHERE_CENTER
  }).document;
  document = addPrimitiveFeature(document, {
    name: 'Cylinder',
    bodyName: 'Cylinder 1',
    primitiveKind: 'cylinder',
    dimensions: { radius: CYLINDER_RADIUS, height: CYLINDER_HEIGHT }
  });
  const cylinder = document.bodyOrder[1]!;
  document = transformBody(document, {
    name: 'Move',
    targetBodyId: cylinder,
    translation: { x: 0, y: 0, z: 46 },
    ...(placement === 'tilted' ? { rotationDeg: TILT } : {})
  }).document;
  document = transformBody(document, {
    name: 'Move 2',
    targetBodyId: cylinder,
    translation: { x: 0, y: 0, z: 12 }
  }).document;
  const cylinderFeatureId = listNodesByKind(document, 'feature').find(
    (feature) => feature.name === 'Cylinder'
  )!.featureId;
  return { document, sphere, cylinder, cylinderFeatureId };
}

/**
 * The placed cylinder's frame, read from the operand before any boolean.
 * Only the placement comes from the kernel; every volume below is
 * integrated independently from it.
 */
function cylinderFrame(body: BodyRepresentation): CylinderFrame {
  const wall = body.topology?.faces.find(
    (face) => face.geometry?.surfaceType === 'cylinder'
  );
  const start = wall?.geometry?.axisStart;
  const end = wall?.geometry?.axisEnd;
  if (!start || !end) throw new Error('The cylinder operand has no wall axis.');
  const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const height = Math.hypot(delta.x, delta.y, delta.z);
  return {
    base: start,
    axis: { x: delta.x / height, y: delta.y / height, z: delta.z / height },
    height
  };
}

/**
 * Volume of a finite cylinder inside the sphere, by integrating over the
 * cylinder's cross-section the length of each axis-parallel chord that lies
 * in both solids. Midpoint rule in r² (equal-area rings) and angle.
 */
export function cylinderSphereOverlap(
  frame: CylinderFrame,
  radius: number
): number {
  const { axis } = frame;
  const helper =
    Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
  const cross = (a: Vec3, b: Vec3) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  });
  const uRaw = cross(axis, helper);
  const uLength = Math.hypot(uRaw.x, uRaw.y, uRaw.z);
  const u = { x: uRaw.x / uLength, y: uRaw.y / uLength, z: uRaw.z / uLength };
  const v = cross(axis, u);
  const rings = 600;
  const sectors = 720;
  const cell = (Math.PI * radius * radius) / (rings * sectors);
  let volume = 0;
  for (let i = 0; i < rings; i += 1) {
    const rho = radius * Math.sqrt((i + 0.5) / rings);
    for (let j = 0; j < sectors; j += 1) {
      const theta = (2 * Math.PI * (j + 0.5)) / sectors;
      const c = rho * Math.cos(theta);
      const s = rho * Math.sin(theta);
      const w = {
        x: frame.base.x + c * u.x + s * v.x - SPHERE_CENTER.x,
        y: frame.base.y + c * u.y + s * v.y - SPHERE_CENTER.y,
        z: frame.base.z + c * u.z + s * v.z - SPHERE_CENTER.z
      };
      const along = dot(w, axis);
      const halfChordSquared = SPHERE_RADIUS ** 2 - (dot(w, w) - along ** 2);
      if (halfChordSquared <= 0) continue;
      const halfChord = Math.sqrt(halfChordSquared);
      const enter = Math.max(0, -along - halfChord);
      const leave = Math.min(frame.height, -along + halfChord);
      if (leave > enter) volume += (leave - enter) * cell;
    }
  }
  return volume;
}

function expectedVolume(
  boolean: BooleanKind,
  frame: CylinderFrame,
  radius: number
): number {
  const sphere = (4 * Math.PI * SPHERE_RADIUS ** 3) / 3;
  const overlap = cylinderSphereOverlap(frame, radius);
  return boolean === 'union'
    ? sphere + Math.PI * radius * radius * frame.height - overlap
    : sphere - overlap;
}

function resultRadius(followUp: FollowUp): number {
  if (followUp === 'direct-grow' || followUp === 'source-grow') {
    return GROW_RADIUS;
  }
  if (followUp === 'direct-shrink') return SHRINK_RADIUS;
  return CYLINDER_RADIUS;
}

/** Runs one cell from an empty document. */
export async function runCell(
  adapter: ExactKernelAdapter,
  cell: Cell
): Promise<CellOutcome> {
  const source = history(cell.placement);
  const operands = await adapter.syncDocument(source.document);
  const frame = cylinderFrame(operands.bodyRepresentations[source.cylinder]!);
  const manager = new CommandManager(source.document);
  manager.execute(
    commandFactories.booleanBodies({
      name: cell.boolean === 'union' ? 'Union' : 'Subtract',
      operation: cell.boolean,
      targetBodyIds: [source.sphere, source.cylinder]
    })
  );
  const bodyId = manager.document.bodyOrder.at(-1)!;
  const base = await adapter.syncDocument(manager.document);
  if (base.warnings.length > 0) {
    return refusalOutcome(base, base.warnings);
  }
  let edited = manager.document;
  let editName: string | null = null;
  if (cell.followUp === 'source-grow') {
    editName = 'Cylinder';
    edited = manager.runTransaction('Resize source', [
      commandFactories.updateFeature({
        featureId: source.cylinderFeatureId,
        data: {
          dimensions: { radius: GROW_RADIUS, height: CYLINDER_HEIGHT }
        }
      })
    ]);
  } else if (cell.followUp !== 'none') {
    const wall = base.bodyRepresentations[bodyId]?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'cylinder' &&
        Math.abs((face.geometry.radius ?? 0) - CYLINDER_RADIUS) < 1e-6
    );
    const geometry = wall?.geometry;
    if (!wall || !geometry?.axisStart || !geometry.axisEnd) {
      return { state: 'wrong', evidence: 'no r = 6 wall on the result' };
    }
    editName = 'Resize Cylinder';
    edited = manager.runTransaction('Resize', [
      commandFactories.directEditBody({
        name: editName,
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall.hash,
          ...(wall.reference ? { faceReference: wall.reference } : {}),
          sourceRadius: CYLINDER_RADIUS,
          sourceAxisStart: geometry.axisStart,
          sourceAxisEnd: geometry.axisEnd,
          concavity: cell.boolean === 'union' ? 'boss' : 'hole',
          radius: resultRadius(cell.followUp)
        }
      })
    ]);
  }
  const derived = editName === null ? base : await adapter.syncDocument(edited);
  if (derived.warnings.length > 0) {
    return refusalOutcome(derived, derived.warnings);
  }
  const finalBodyId = edited.bodyOrder.at(-1)!;
  const body = derived.bodyRepresentations[finalBodyId];
  if (!body) return { state: 'wrong', evidence: 'no result body' };
  return qualify(body, cell, frame);
}

function refusalOutcome(
  derived: { featureWarnings?: Array<{ kernelRefusal?: unknown }> },
  warnings: readonly string[]
): CellOutcome {
  const typed = (derived.featureWarnings ?? []).some(
    (warning) => warning.kernelRefusal !== undefined
  );
  return {
    state: typed ? 'typed-refusal' : 'untyped-refusal',
    evidence: warnings.join(' | ')
  };
}

function qualify(
  body: BodyRepresentation,
  cell: Cell,
  frame: CylinderFrame
): CellOutcome {
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
  const radius = resultRadius(cell.followUp);
  const expected = expectedVolume(cell.boolean, frame, radius);
  const tolerance = Math.max(0.05, 1e-6 * expected);
  if (Math.abs(body.volume - expected) > tolerance) {
    return {
      state: 'wrong',
      evidence: `volume ${body.volume} differs from oracle ${expected}`
    };
  }
  const walls = (body.topology?.faces ?? []).filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs((face.geometry.radius ?? 0) - radius) < 1e-6
  );
  if (walls.length === 0) {
    return { state: 'wrong', evidence: `no analytic wall at r = ${radius}` };
  }
  return { state: 'qualified', evidence: `volume ${body.volume}` };
}
