import type { FaceDistanceMoveMode, Vector3 } from '@openzcad/shared';

import type { RemusKernel } from './remus-runtime';
import { readFacePlaneFrame } from './exact-face-plane-frame';
import { DIRECT_EDIT_TOLERANCE, dot, normalized } from './exact-math';
import { readMeshQuality } from './exact-shape-utils';
import { requireValidSolid } from './kernel-validation';
import {
  MEASUREMENT_DEFLECTION,
  faceHandlesByFingerprint,
  faceWitnessOf
} from './exact-witnesses';
import { topologyHashOfWitness } from './topology-lineage';
import {
  decodeRemusMoveFacesJournal,
  type RemusMoveFacesRelation
} from './remus-lineage';
import { moveFacesJournalFaceMap } from './exact-lineage-builders';

export interface RemusOpposingPlanarFacePair {
  faceA: number;
  faceB: number;
  distance: number;
  overlapArea: number;
  faceAreaA: number;
  faceAreaB: number;
  normal: [number, number, number];
  faceABordersBlend: boolean;
  faceBBordersBlend: boolean;
}

const finitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

function safeHandle(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Strictly decodes the bounded kernel proof payload; malformed data is fatal. */
export function queryOpposingPlanarFacePairs(
  kernel: RemusKernel,
  solid: number
): RemusOpposingPlanarFacePair[] {
  const parsed: unknown = JSON.parse(kernel.getOpposingPlanarFacePairs(solid));
  if (!Array.isArray(parsed)) {
    throw new Error('Planar face-pair query returned a non-array payload.');
  }
  return parsed.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Planar face-pair query returned an invalid record.');
    }
    const pair = value as Partial<RemusOpposingPlanarFacePair>;
    const normal = pair.normal;
    if (
      !safeHandle(pair.faceA) ||
      !safeHandle(pair.faceB) ||
      pair.faceA === pair.faceB ||
      !finitePositive(pair.distance) ||
      !finitePositive(pair.overlapArea) ||
      !finitePositive(pair.faceAreaA) ||
      !finitePositive(pair.faceAreaB) ||
      !Array.isArray(normal) ||
      normal.length !== 3 ||
      !normal.every(
        (component) =>
          typeof component === 'number' && Number.isFinite(component)
      ) ||
      Math.abs(Math.hypot(normal[0], normal[1], normal[2]) - 1) > 1e-6 ||
      typeof pair.faceABordersBlend !== 'boolean' ||
      typeof pair.faceBBordersBlend !== 'boolean'
    ) {
      throw new Error('Planar face-pair query returned incomplete geometry.');
    }
    return pair as RemusOpposingPlanarFacePair;
  });
}

export function measuredOpposingPlanarFacePair(
  kernel: RemusKernel,
  solid: number,
  faceA: number,
  faceB: number
): RemusOpposingPlanarFacePair {
  const matching = queryOpposingPlanarFacePairs(kernel, solid).filter(
    (pair) =>
      (pair.faceA === faceA && pair.faceB === faceB) ||
      (pair.faceA === faceB && pair.faceB === faceA)
  );
  if (matching.length !== 1) {
    throw new Error(
      'The selected faces are no longer one opposing parallel planar pair.'
    );
  }
  const pair = matching[0]!;
  if (pair.faceA === faceA) {
    return pair;
  }
  return {
    faceA,
    faceB,
    distance: pair.distance,
    overlapArea: pair.overlapArea,
    faceAreaA: pair.faceAreaB,
    faceAreaB: pair.faceAreaA,
    normal: [-pair.normal[0], -pair.normal[1], -pair.normal[2]],
    faceABordersBlend: pair.faceBBordersBlend,
    faceBBordersBlend: pair.faceABordersBlend
  };
}

function coplanarFaceGroup(
  kernel: RemusKernel,
  solid: number,
  selectedFace: number
): Uint32Array {
  const selected = readFacePlaneFrame(kernel, selectedFace);
  if (
    selected?.surfaceType !== 'plane' ||
    !selected.normal ||
    selected.planeOffset === undefined
  ) {
    throw new Error('The selected face is no longer planar.');
  }
  const selectedNormal = selected.normal;
  const selectedOffset = selected.planeOffset;
  const scale = Math.max(1, Math.abs(selectedOffset));
  const planeTolerance = Math.max(DIRECT_EDIT_TOLERANCE, scale * 1e-8);
  const group = Array.from(kernel.getSolidFaces(solid)).filter((face) => {
    const candidate = readFacePlaneFrame(kernel, face);
    return (
      candidate?.surfaceType === 'plane' &&
      candidate.normal !== undefined &&
      candidate.planeOffset !== undefined &&
      dot(candidate.normal, selectedNormal) >= 1 - 1e-8 &&
      Math.abs(candidate.planeOffset - selectedOffset) <= planeTolerance
    );
  });
  if (!group.includes(selectedFace)) {
    throw new Error('The selected planar face group cannot be resolved.');
  }
  return Uint32Array.from(group);
}

function faceFingerprint(kernel: RemusKernel, face: number): number {
  return topologyHashOfWitness('face', faceWitnessOf(kernel, face));
}

function unchangedFaceAfterMove(
  kernel: RemusKernel,
  solid: number,
  sourceHash: number
): number {
  const matches = faceHandlesByFingerprint(kernel, solid).get(sourceHash) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'The opposite face could not be re-identified after the first symmetric move.'
        : 'The opposite face became ambiguous after the first symmetric move.'
    );
  }
  return matches[0]!;
}

/**
 * One move through the journaled entry point, with its source-to-result face
 * map read back against the solid the kernel actually built.
 *
 * The journal is history, not geometry: when the entry point refuses, the
 * plain move builds the same solid without it and lineage falls back to
 * unchanged witnesses. Either way the acceptance gates below still prove the
 * geometry before anything is published.
 */
function journaledMove(
  kernel: RemusKernel,
  solid: number,
  faces: Uint32Array,
  distance: number
): { solid: number; relation: RemusMoveFacesRelation | null } {
  const sourceFaces = Array.from(kernel.getSolidFaces(solid));
  let journal: { solid: number; op: number };
  try {
    journal = decodeRemusMoveFacesJournal(
      kernel.moveFacesJournaled(solid, faces, distance)
    );
  } catch {
    return { solid: kernel.moveFaces(solid, faces, distance), relation: null };
  }
  const relation = moveFacesJournalFaceMap(
    kernel,
    journal.op,
    sourceFaces,
    Array.from(kernel.getSolidFaces(journal.solid))
  );
  return { solid: journal.solid, relation };
}

/**
 * Compose the two legs of a symmetric move into one source-to-final map.
 * Either leg falling back to the unjournaled entry point refuses the whole
 * composition: a half-traced history is not evidence. Merge conflicts poison
 * their original sources even where only one leg saw the merge, so a source
 * the journal refused can never ride the unchanged-witness fallback.
 */
function composeMoveFacesRelations(
  first: RemusMoveFacesRelation | null,
  second: RemusMoveFacesRelation | null
): RemusMoveFacesRelation | null {
  if (!first || !second) {
    return null;
  }
  const conflictedSources = new Set<number>(first.conflictedSources);
  const finalClaimants = new Map<number, number[]>();
  for (const [source, intermediate] of first.faceMap) {
    if (first.conflictedSources.has(source)) {
      continue;
    }
    const final = second.faceMap.get(intermediate);
    if (final === undefined) {
      if (second.conflictedSources.has(intermediate)) {
        conflictedSources.add(source);
      }
      continue;
    }
    finalClaimants.set(final, [...(finalClaimants.get(final) ?? []), source]);
  }
  const faceMap = new Map<number, number>();
  for (const [final, sources] of finalClaimants) {
    if (sources.length !== 1) {
      for (const source of sources) {
        conflictedSources.add(source);
      }
      continue;
    }
    faceMap.set(sources[0]!, final);
  }
  return { faceMap, conflictedSources };
}

function moveFacePair(
  kernel: RemusKernel,
  solid: number,
  faceA: number,
  faceB: number,
  mode: FaceDistanceMoveMode,
  delta: number
): { solid: number; relation: RemusMoveFacesRelation | null } {
  if (!Number.isFinite(delta) || Math.abs(delta) <= DIRECT_EDIT_TOLERANCE) {
    throw new Error('Face-distance move must be a finite non-zero distance.');
  }
  if (mode === 'symmetric') {
    const oppositeHash = faceFingerprint(kernel, faceB);
    const first = journaledMove(
      kernel,
      solid,
      coplanarFaceGroup(kernel, solid, faceA),
      delta / 2
    );
    const intermediateOpposite = unchangedFaceAfterMove(
      kernel,
      first.solid,
      oppositeHash
    );
    const second = journaledMove(
      kernel,
      first.solid,
      coplanarFaceGroup(kernel, first.solid, intermediateOpposite),
      delta / 2
    );
    return {
      solid: second.solid,
      relation: composeMoveFacesRelations(first.relation, second.relation)
    };
  }
  const movingFace = mode === 'one-sided-first' ? faceA : faceB;
  return journaledMove(
    kernel,
    solid,
    coplanarFaceGroup(kernel, solid, movingFace),
    delta
  );
}

function pairAxis(pair: RemusOpposingPlanarFacePair): Vector3 {
  const axis = normalized({
    x: pair.normal[0],
    y: pair.normal[1],
    z: pair.normal[2]
  });
  if (!axis) {
    throw new Error('Face-distance proof returned a degenerate normal.');
  }
  return axis;
}

function projectedCoordinate(point: Vector3, axis: Vector3): number {
  return dot(point, axis);
}

function requireMovedPair(
  kernel: RemusKernel,
  output: number,
  source: RemusOpposingPlanarFacePair,
  mode: FaceDistanceMoveMode,
  desiredDistance: number
): void {
  const sourceA = readFacePlaneFrame(kernel, source.faceA);
  const sourceB = readFacePlaneFrame(kernel, source.faceB);
  if (
    sourceA?.surfaceType !== 'plane' ||
    sourceB?.surfaceType !== 'plane' ||
    !sourceA.normal ||
    !sourceB.normal
  ) {
    throw new Error('Face-distance proof endpoints are no longer planar.');
  }
  const axis = pairAxis(source);
  const delta = desiredDistance - source.distance;
  const firstMove =
    mode === 'symmetric' ? delta / 2 : mode === 'one-sided-first' ? delta : 0;
  const secondMove =
    mode === 'symmetric' ? delta / 2 : mode === 'one-sided-second' ? delta : 0;
  const expectedA = projectedCoordinate(sourceA.center, axis) + firstMove;
  const expectedB = projectedCoordinate(sourceB.center, axis) - secondMove;
  const tolerance = Math.max(
    DIRECT_EDIT_TOLERANCE * 10,
    Math.abs(desiredDistance) * 1e-6
  );
  const matching = queryOpposingPlanarFacePairs(kernel, output).filter(
    (candidate) => {
      if (
        Math.abs(candidate.distance - desiredDistance) > tolerance ||
        dot(pairAxis(candidate), axis) < 1 - 1e-6
      ) {
        return false;
      }
      const candidateA = readFacePlaneFrame(kernel, candidate.faceA);
      const candidateB = readFacePlaneFrame(kernel, candidate.faceB);
      return (
        candidateA?.surfaceType === 'plane' &&
        candidateB?.surfaceType === 'plane' &&
        Math.abs(projectedCoordinate(candidateA.center, axis) - expectedA) <=
          tolerance &&
        Math.abs(projectedCoordinate(candidateB.center, axis) - expectedB) <=
          tolerance
      );
    }
  );
  if (matching.length !== 1) {
    throw new Error(
      'The changed face-distance rebuild did not reproduce one exact measured pair.'
    );
  }
}

export function rebuildFaceDistance(
  kernel: RemusKernel,
  solid: number,
  source: RemusOpposingPlanarFacePair,
  mode: FaceDistanceMoveMode,
  desiredDistance: number
): { solid: number; relation: RemusMoveFacesRelation | null } {
  if (
    !Number.isFinite(desiredDistance) ||
    desiredDistance <= DIRECT_EDIT_TOLERANCE
  ) {
    throw new Error('Face distance must be greater than zero.');
  }
  const moved = moveFacePair(
    kernel,
    solid,
    source.faceA,
    source.faceB,
    mode,
    desiredDistance - source.distance
  );
  const output = moved.solid;
  requireValidSolid(
    kernel,
    output,
    `Setting the face distance to ${desiredDistance} does not produce a valid solid.`
  );
  const meshQuality = readMeshQuality(
    kernel.meshQuality(output, MEASUREMENT_DEFLECTION)
  );
  if (!meshQuality.isWatertight) {
    throw new Error(
      `Setting the face distance to ${desiredDistance} does not produce a watertight tessellation.`
    );
  }
  requireMovedPair(kernel, output, source, mode, desiredDistance);
  return moved;
}

/** Returns the accepted changed distance, or null when this mode is unsupported. */
export function proveChangedFaceDistance(
  kernel: RemusKernel,
  solid: number,
  source: RemusOpposingPlanarFacePair,
  mode: FaceDistanceMoveMode
): number | null {
  const delta = Math.max(source.distance * 0.01, DIRECT_EDIT_TOLERANCE * 100);
  const changedDistance = source.distance + delta;
  const checkpoint = kernel.checkpoint();
  try {
    rebuildFaceDistance(kernel, solid, source, mode, changedDistance);
    return changedDistance;
  } catch {
    return null;
  } finally {
    kernel.restore(checkpoint);
    kernel.discardCheckpoint(checkpoint);
  }
}

export function pairNormalVector(pair: RemusOpposingPlanarFacePair): Vector3 {
  return { x: pair.normal[0], y: pair.normal[1], z: pair.normal[2] };
}

export function faceDistancePairScore(
  pair: RemusOpposingPlanarFacePair
): number {
  return pair.overlapArea * Math.max(pair.faceAreaA, pair.faceAreaB);
}
