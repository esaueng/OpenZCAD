/**
 * Deterministic seeded direct-edit chain generator, per-step verifier,
 * end-of-chain cold replay + STEP roundtrip check, and failure-preserving
 * chain shrinker for K10 CAD part QA Phase P2.
 *
 * See docs/plans/cad-part-qa-plan-2026-11-22.md ("Long chains" and "Phases").
 */

import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  listFeaturesInOrder,
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type {
  BodyId,
  BodyRepresentation,
  DerivedState,
  DirectEditOperation,
  FaceGeometry,
  FaceTopology,
  FeatureId,
  FeatureNode,
  FeatureWarning,
  ProjectDocument,
  Vector3
} from '@openzcad/shared';

import type { DirectEditFixtureFace } from '../../apps/web/src/lib/directEditFixture';
import { validatedFeatureRejection } from '../../apps/web/src/lib/featureValidation';
import { planFaceOffset } from '../../apps/web/src/lib/interaction/faceOffsetPlan';
import { GENERIC_REFUSAL } from '../../apps/web/src/lib/refusalLanguage';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../../packages/kernel-adapter/src/boolean-result-validation';
import { blendCarrierSnapshot } from '../../packages/kernel-adapter/src/exact-measure';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import {
  CellTimeout,
  census,
  coldSync,
  commitWithCarry,
  refusal,
  sync,
  type CellOutcome,
  type CellState,
  type Session
} from '../support/combination-matrix';
import type { LedgerRunner } from '../support/combination-matrix-suite';
import { faceCensus } from './ladder-oracles';
import { CAP_JOIN_PINS, CHAIN_REFUSAL_PINS } from './pins';
import {
  checkConstructionAccuracy,
  referencePart,
  type PartName,
  type ReferencePart
} from './reference-parts';
import { faceSelector, resolveFixtureFace } from './resolve';

export type ChainPartName = 'A' | 'B' | 'C' | 'D';

export const PR_SLICE_PARTS: readonly ChainPartName[] = ['A', 'B', 'C', 'D'];
export const PR_SLICE_SEEDS: readonly number[] = [1, 2, 3];
export const PR_SLICE_LENGTH = 20;
export const DEFAULT_CHAIN_LENGTH = 60;

/** One concrete step in a direct-edit chain. */
export type ChainStep =
  | {
      kind: 'offset-face';
      stepId: string;
      face: DirectEditFixtureFace;
      offset: number;
      probeLimit?: boolean;
    }
  | {
      kind: 'resize-blend';
      stepId: string;
      face: DirectEditFixtureFace;
      delta: number;
      probeLimit?: boolean;
    }
  | {
      kind: 'resize-cylinder';
      stepId: string;
      face: DirectEditFixtureFace;
      delta: number;
      probeLimit?: boolean;
    }
  | {
      kind: 'edit-earlier';
      stepId: string;
      targetStepId: string;
      delta: number;
    }
  | {
      kind: 'undo';
      stepId: string;
      redoAfter: boolean;
    }
  | {
      kind: 'reopen';
      stepId: string;
    };

export interface ChainCell {
  id: string;
  part: PartName;
  seed: number;
  length: number;
  /**
   * Explicit step script for deterministic replay or shrinking.
   * Absent on generated seeded cells, which derive steps from `seed` and
   * `length` against the live body.
   */
  steps?: readonly ChainStep[];
}

export type ChainOracle =
  | 'refusal-typed'
  | 'refusal-explanation'
  | 'refusal-unchanged'
  | 'refusal-pin'
  | 'approximation-disclosure'
  | 'solid-validity'
  | 'mesh-closure'
  | 'offset-shape-oracle'
  | 'carry-commit'
  | 'undo-exact'
  | 'redo-exact'
  | 'reopen-exact'
  | 'cold-replay'
  | 'step-roundtrip'
  | 'unexpected-throw'
  | 'timeout';

/**
 * Exact failure identity preserved by `shrinkChain`. A candidate
 * simplification is kept only when its failure matches every field here, so a
 * different oracle or refusal category cannot replace the original failure.
 */
export interface FailureSignature {
  state: Exclude<CellState, 'qualified'>;
  oracle: ChainOracle;
  refusalCategory?: string;
  refusalCode?: string;
  wrongCheck?: string;
}

export function sameFailureSignature(
  left: FailureSignature | undefined,
  right: FailureSignature | undefined
): boolean {
  if (!left || !right) return false;
  return (
    left.state === right.state &&
    left.oracle === right.oracle &&
    left.refusalCategory === right.refusalCategory &&
    left.refusalCode === right.refusalCode &&
    left.wrongCheck === right.wrongCheck
  );
}

export interface ExecutedStep {
  index: number;
  step: ChainStep;
  status:
    | 'committed'
    | 'refused'
    | 'undone'
    | 'undone-redone'
    | 'reopened'
    | 'skipped';
  volumeBefore: number;
  volumeAfter: number;
  faceCountBefore: number;
  faceCountAfter: number;
  refusalMessage?: string;
  kernelRefusal?: FeatureWarning['kernelRefusal'];
  /** The `CHAIN_REFUSAL_PINS` entry that pins this refusal. */
  pin?: string;
  /** Feature the refusal is attributed to, and its position in history. */
  refusedFeature?: string;
  advisories?: string[];
}

export interface ChainRunSummary {
  built: number;
  refused: number;
  undos: number;
  redos: number;
  editsEarlier: number;
  reopens: number;
  elapsedMs: number;
}

export interface ChainRunResult {
  outcome: CellOutcome;
  failure?: FailureSignature;
  failureStepIndex?: number;
  recordedSteps: ChainStep[];
  executed: ExecutedStep[];
  finalVolume: number;
  finalCensus: string[];
  summary: ChainRunSummary;
}

export interface ChainStepHookContext {
  stepIndex: number;
  step: ChainStep;
  status: ExecutedStep['status'];
  body: BodyRepresentation;
  document: ProjectDocument;
  executed: readonly ExecutedStep[];
}

export interface ChainRunOptions {
  budgetMs?: number;
  /**
   * Optional per-step hook used by shrinker contract tests to inject a
   * deterministic synthetic oracle failure on top of real kernel execution.
   */
  extraStepOracle?: (
    context: ChainStepHookContext
  ) => { failure: FailureSignature; evidence: string } | null;
}

export interface ChainShrinkOptions extends ChainRunOptions {
  /** Maximum candidate runs during shrinking (default 80). */
  maxProbes?: number;
  /**
   * Wall-clock time (ms since epoch) after which no further candidate runs.
   * The shrink returns the smallest reproducing history found by then.
   */
  deadline?: number;
  /** Optional precomputed baseline run to avoid re-running the original cell. */
  baseline?: ChainRunResult;
}

/**
 * The only approximation a chain edit may disclose: the fitted cap join the
 * P1 ladder pinned. Any other approximate result fails the disclosure oracle.
 */
const ALLOWED_EDIT_ADVISORIES = new Set(
  CAP_JOIN_PINS.map((pin) => pin.message)
);

// ---------------------------------------------------------------- PRNG

export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(part: PartName, seed: number): number {
  let hash = 2166136261;
  for (let i = 0; i < part.length; i += 1) {
    hash ^= part.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= seed >>> 0;
  hash = Math.imul(hash, 16777619);
  return hash >>> 0;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function cleanDecimal(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------- cell catalog

export function chainCellId(
  part: PartName,
  seed: number,
  length: number
): string {
  return `${part}/seed-${seed}/${length}`;
}

export function prSliceChainCells(
  length = PR_SLICE_LENGTH,
  seeds: readonly number[] = PR_SLICE_SEEDS
): ChainCell[] {
  const cells: ChainCell[] = [];
  for (const part of PR_SLICE_PARTS) {
    for (const seed of seeds) {
      cells.push({
        id: chainCellId(part, seed, length),
        part,
        seed,
        length
      });
    }
  }
  return cells;
}

// ----------------------------------------------------- reference caching

const referenceCache = new WeakMap<
  ExactKernelAdapter,
  Map<PartName, ReferencePart>
>();

async function initialReferencePart(
  session: Session,
  part: PartName
): Promise<ReferencePart> {
  let byPart = referenceCache.get(session.adapter);
  if (!byPart) {
    byPart = new Map();
    referenceCache.set(session.adapter, byPart);
  }
  const existing = byPart.get(part);
  if (existing) return existing;
  const built = await referencePart(session, part);
  byPart.set(part, built);
  return built;
}

// ----------------------------------------------------- geometry helpers

function historyLengths(document: ProjectDocument) {
  return {
    features: listFeaturesInOrder(document).length,
    commands: document.commandLog.length,
    entries: document.editHistory?.entries.length ?? 0,
    cursor: document.editHistory?.cursor ?? 0
  };
}

function sameHistoryLengths(
  left: ReturnType<typeof historyLengths>,
  right: ReturnType<typeof historyLengths>
): boolean {
  return (
    left.features === right.features &&
    left.commands === right.commands &&
    left.entries === right.entries &&
    left.cursor === right.cursor
  );
}

/** Bit-identical volume, topology counts and sorted surface census. */
function sameExactSnapshot(
  left: BodyRepresentation,
  right: BodyRepresentation
): boolean {
  if (left.volume !== right.volume) return false;
  if (census(left) !== census(right)) return false;
  const a = faceCensus(left);
  const b = faceCensus(right);
  if (a.length !== b.length) return false;
  return a.every((type, index) => type === b[index]);
}

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function planeOffsetOf(geometry: FaceGeometry): number | null {
  if (geometry.surfaceType !== 'plane' || !geometry.normal) return null;
  return dot(geometry.normal, geometry.center);
}

function round6(value: number | undefined): number {
  return value === undefined ? 0 : Math.round(value * 1e6);
}

/** Deterministic geometric ordering independent of kernel handle numbering. */
function sortFacesCanonically(faces: readonly FaceTopology[]): FaceTopology[] {
  return [...faces].sort((left, right) => {
    const a = left.geometry;
    const b = right.geometry;
    const typeA = a?.surfaceType ?? '';
    const typeB = b?.surfaceType ?? '';
    if (typeA !== typeB) return typeA < typeB ? -1 : 1;
    const keysA = [
      round6(a?.center.x),
      round6(a?.center.y),
      round6(a?.center.z),
      round6(a?.normal?.x),
      round6(a?.normal?.y),
      round6(a?.normal?.z),
      round6(a?.area)
    ];
    const keysB = [
      round6(b?.center.x),
      round6(b?.center.y),
      round6(b?.center.z),
      round6(b?.normal?.x),
      round6(b?.normal?.y),
      round6(b?.normal?.z),
      round6(b?.area)
    ];
    for (let i = 0; i < keysA.length; i += 1) {
      if (keysA[i]! !== keysB[i]!) return keysA[i]! - keysB[i]!;
    }
    return left.hash - right.hash;
  });
}

function isUniquelyResolvable(
  body: BodyRepresentation,
  face: FaceTopology
): DirectEditFixtureFace | null {
  if (!face.geometry) return null;
  const selector = faceSelector(face);
  try {
    const resolved = resolveFixtureFace(body, selector);
    return resolved.hash === face.hash ? selector : null;
  } catch {
    return null;
  }
}

interface ResolvableFace {
  face: FaceTopology;
  selector: DirectEditFixtureFace;
}

function candidateOffsetFaces(body: BodyRepresentation): ResolvableFace[] {
  const faces = sortFacesCanonically(body.topology?.faces ?? []);
  const result: ResolvableFace[] = [];
  for (const face of faces) {
    if (
      face.geometry?.surfaceType !== 'plane' ||
      face.geometry.normal === undefined
    ) {
      continue;
    }
    const selector = isUniquelyResolvable(body, face);
    if (selector) result.push({ face, selector });
  }
  return result;
}

function candidateBlendFaces(body: BodyRepresentation): ResolvableFace[] {
  const faces = sortFacesCanonically(body.topology?.faces ?? []);
  const seenRegions = new Set<string>();
  const result: ResolvableFace[] = [];
  for (const face of faces) {
    const carrier = blendCarrierSnapshot(face.geometry);
    if (!carrier || face.geometry?.editableDimension !== 'blendRadius') {
      continue;
    }
    const regionKey =
      face.geometry.blendRegionKey ??
      `${carrier.surfaceClass}:${round6(carrier.radius)}:${round6(carrier.center.x)}:${round6(carrier.center.y)}:${round6(carrier.center.z)}`;
    if (seenRegions.has(regionKey)) continue;
    const selector = isUniquelyResolvable(body, face);
    if (selector) {
      seenRegions.add(regionKey);
      result.push({ face, selector });
    }
  }
  return result;
}

function candidateCylinderFaces(body: BodyRepresentation): ResolvableFace[] {
  const faces = sortFacesCanonically(body.topology?.faces ?? []);
  const result: ResolvableFace[] = [];
  for (const face of faces) {
    const g = face.geometry;
    if (
      g?.surfaceType !== 'cylinder' ||
      g.featureType === 'blend' ||
      g.radius === undefined ||
      !g.axisStart ||
      !g.axisEnd
    ) {
      continue;
    }
    const selector = isUniquelyResolvable(body, face);
    if (selector) result.push({ face, selector });
  }
  return result;
}

function bodySpanAlongNormal(
  body: BodyRepresentation,
  normal: Vector3
): number {
  const dx = body.bbox.max.x - body.bbox.min.x;
  const dy = body.bbox.max.y - body.bbox.min.y;
  const dz = body.bbox.max.z - body.bbox.min.z;
  return (
    Math.abs(normal.x) * dx + Math.abs(normal.y) * dy + Math.abs(normal.z) * dz
  );
}

// -------------------------------------------------- strict solid & STEP

async function verifyStepSolid(
  session: Session,
  document: ProjectDocument,
  derived: DerivedState,
  body: BodyRepresentation,
  checkCensus: boolean
): Promise<{ failure: FailureSignature; evidence: string } | null> {
  const oracle: ChainOracle = checkCensus ? 'step-roundtrip' : 'solid-validity';
  const step = await session.adapter.exportStep({ ...document, derived }, [
    body.bodyId
  ]);
  const io = await loadRemusTranslators();
  const kernel = new RemusKernel();
  try {
    const solids = [
      ...kernel.deserializeSolids(io.importStep(new TextEncoder().encode(step)))
    ];
    if (solids.length !== 1) {
      return {
        failure: {
          state: 'wrong',
          oracle,
          wrongCheck: 'step-solid-count'
        },
        evidence: `STEP reimport produced ${solids.length} solids instead of 1`
      };
    }
    const solid = solids[0]!;
    const strictErrors = kernel.validateSolid(solid);
    if (strictErrors !== 0) {
      return {
        failure: {
          state: 'wrong',
          oracle,
          wrongCheck: 'validate-solid-nonzero'
        },
        evidence: `strict validateSolid reported ${strictErrors} error(s)`
      };
    }
    const stepVolume = kernel.volume(solid, 0.001);
    const volTol = Math.max(0.05, 1e-6 * Math.abs(body.volume));
    if (Math.abs(stepVolume - body.volume) > volTol) {
      return {
        failure: {
          state: 'wrong',
          oracle,
          wrongCheck: 'step-volume-mismatch'
        },
        evidence: `STEP volume ${stepVolume} differs from body volume ${body.volume} (tol ${volTol})`
      };
    }
    if (checkCensus) {
      const importedCensus = Array.from(kernel.getSolidFaces(solid))
        .map((face) => kernel.getSurfaceType(face))
        .sort();
      const expectedCensus = faceCensus(body);
      if (
        importedCensus.length !== expectedCensus.length ||
        importedCensus.some((type, index) => type !== expectedCensus[index])
      ) {
        return {
          failure: {
            state: 'wrong',
            oracle: 'step-roundtrip',
            wrongCheck: 'step-census-mismatch'
          },
          evidence: `STEP face census ${importedCensus.join(',')} differs from body census ${expectedCensus.join(',')}`
        };
      }
    }
    return null;
  } finally {
    kernel.free();
  }
}

function checkBuildGeometry(
  body: BodyRepresentation | undefined
): { failure: FailureSignature; evidence: string } | null {
  if (!body || !body.topology) {
    return {
      failure: {
        state: 'wrong',
        oracle: 'solid-validity',
        wrongCheck: 'missing-body-or-topology'
      },
      evidence: 'build succeeded without a body representation or topology'
    };
  }
  if (!body.exportableStep) {
    return {
      failure: {
        state: 'wrong',
        oracle: 'solid-validity',
        wrongCheck: 'not-exportable-step'
      },
      evidence: 'built body is not an exact exportable solid'
    };
  }
  if (!Number.isFinite(body.volume) || body.volume <= 0) {
    return {
      failure: {
        state: 'wrong',
        oracle: 'solid-validity',
        wrongCheck: 'nonpositive-volume'
      },
      evidence: `built body has invalid volume ${body.volume}`
    };
  }
  const closure = inspectTriangleMeshClosure(
    body.mesh.vertices,
    body.mesh.indices
  );
  if (!isClosedConsistentlyOrientedMesh(closure)) {
    return {
      failure: {
        state: 'wrong',
        oracle: 'mesh-closure',
        wrongCheck: 'mesh-open-or-inconsistent'
      },
      evidence: `display mesh is not closed and consistently oriented: ${JSON.stringify(closure)}`
    };
  }
  return null;
}

/**
 * Oracle 10 + moved-face check for a committed `offset-face` edit.
 *
 * Whenever the face census did not change:
 * - verifies a planar face with the same normal sits at the moved plane
 *   offset (`beforePlaneOffset + offset`), catching silent wrong-face moves;
 * - verifies the volume moved in the sign of `offset`;
 * - when the live pre-step body proves a constant-section rigid move (a
 *   chamfered cylinder cap on Part D whose cap + cone translate rigidly),
 *   verifies `after.volume - before.volume === section * offset`.
 */
function checkOffsetShapeOracle(
  part: PartName,
  before: BodyRepresentation,
  after: BodyRepresentation,
  picked: FaceTopology,
  offset: number
): { failure: FailureSignature; evidence: string } | null {
  const beforeGeo = picked.geometry;
  if (!beforeGeo?.normal) return null;
  const beforeD = planeOffsetOf(beforeGeo);
  if (beforeD === null) return null;
  const expectedD = beforeD + offset;
  const movedPlanes = (after.topology?.faces ?? []).filter((candidate) => {
    const g = candidate.geometry;
    if (g?.surfaceType !== 'plane' || !g.normal) return false;
    if (dot(g.normal, beforeGeo.normal!) < 1 - 1e-6) return false;
    const d = planeOffsetOf(g);
    return d !== null && Math.abs(d - expectedD) < 1e-4;
  });
  if (movedPlanes.length === 0) {
    return {
      failure: {
        state: 'wrong',
        oracle: 'offset-shape-oracle',
        wrongCheck: 'moved-face-missing'
      },
      evidence: `offset by ${offset} mm left no planar face at expected plane offset ${expectedD}`
    };
  }
  const deltaV = after.volume - before.volume;
  if (offset > 0 && deltaV <= 0) {
    return {
      failure: {
        state: 'wrong',
        oracle: 'offset-shape-oracle',
        wrongCheck: 'volume-sign-wrong'
      },
      evidence: `positive offset +${offset} mm did not increase volume (delta ${deltaV})`
    };
  }
  if (offset < 0 && deltaV >= 0) {
    return {
      failure: {
        state: 'wrong',
        oracle: 'offset-shape-oracle',
        wrongCheck: 'volume-sign-wrong'
      },
      evidence: `negative offset ${offset} mm did not decrease volume (delta ${deltaV})`
    };
  }
  // Exact constant-section check when the live body proves a rigid prismatic
  // translation (Part D chamfered cylinder cap: cap + chamfer translate with
  // full cylinder section π r²).
  if (part === 'D') {
    const beforeCensus = faceCensus(before);
    const afterCensus = faceCensus(after);
    const cyls = (before.topology?.faces ?? []).filter(
      (f) => f.geometry?.surfaceType === 'cylinder' && f.geometry.radius
    );
    if (
      cyls.length === 1 &&
      beforeCensus.length === afterCensus.length &&
      beforeCensus.every((t, i) => t === afterCensus[i])
    ) {
      const r = cyls[0]!.geometry!.radius!;
      const expectedDelta = Math.PI * r * r * offset;
      const tol = Math.max(0.05, 1e-6 * Math.abs(expectedDelta));
      if (Math.abs(deltaV - expectedDelta) > tol) {
        return {
          failure: {
            state: 'wrong',
            oracle: 'offset-shape-oracle',
            wrongCheck: 'constant-section-volume-mismatch'
          },
          evidence: `Part D cap offset by ${offset} mm changed volume by ${deltaV}, expected π·${r}²·${offset} = ${expectedDelta} ± ${tol}`
        };
      }
    }
  }
  return null;
}

function checkApproximationDisclosure(
  initial: ReferencePart,
  warnings: readonly FeatureWarning[],
  chainFeatureIds: ReadonlySet<FeatureId>
): { failure: FailureSignature; evidence: string } | null {
  const withoutAllowedEditAdvisory = warnings.filter(
    (warning) =>
      !(
        warning.kind === 'advisory' &&
        warning.featureId !== undefined &&
        chainFeatureIds.has(warning.featureId) &&
        ALLOWED_EDIT_ADVISORIES.has(warning.message)
      )
  );
  try {
    checkConstructionAccuracy(initial, [...withoutAllowedEditAdvisory]);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failure: {
        state: 'wrong',
        oracle: 'approximation-disclosure',
        wrongCheck: 'unexpected-approximation'
      },
      evidence: message
    };
  }
}

// -------------------------------------------------- command construction

function buildStepCommand(
  step: Exclude<ChainStep, { kind: 'undo' | 'reopen' }>,
  document: ProjectDocument,
  bodyId: BodyId,
  body: BodyRepresentation,
  stepIdToFeatureId: ReadonlyMap<string, FeatureId>
): { command: AnyCommand; pickedFace?: FaceTopology } | null {
  switch (step.kind) {
    case 'offset-face': {
      let face: FaceTopology;
      try {
        face = resolveFixtureFace(body, step.face);
      } catch {
        return null;
      }
      const plan = planFaceOffset({
        document,
        bodyId,
        face,
        faceHash: face.hash,
        offset: step.offset,
        localOnly: true
      });
      if (!plan) return null;
      return { command: plan.command, pickedFace: face };
    }
    case 'resize-blend': {
      let face: FaceTopology;
      try {
        face = resolveFixtureFace(body, step.face);
      } catch {
        return null;
      }
      const carrier = blendCarrierSnapshot(face.geometry);
      if (!carrier) return null;
      const newRadius = cleanDecimal(carrier.radius + step.delta);
      return {
        pickedFace: face,
        command: commandFactories.directEditBody({
          name: 'Resize blend',
          targetBodyId: bodyId,
          operation: {
            kind: 'resize-blend',
            faceHash: face.hash,
            ...(face.reference ? { faceReference: face.reference } : {}),
            surfaceClass: carrier.surfaceClass,
            recordedRadius: carrier.radius,
            recordedCenter: carrier.center,
            recordedAxis: carrier.axis,
            newRadius
          }
        })
      };
    }
    case 'resize-cylinder': {
      let face: FaceTopology;
      try {
        face = resolveFixtureFace(body, step.face);
      } catch {
        return null;
      }
      const g = face.geometry;
      if (
        g?.surfaceType !== 'cylinder' ||
        g.radius === undefined ||
        !g.axisStart ||
        !g.axisEnd
      ) {
        return null;
      }
      const newRadius = cleanDecimal(g.radius + step.delta);
      return {
        pickedFace: face,
        command: commandFactories.directEditBody({
          name: 'Resize cylindrical face',
          targetBodyId: bodyId,
          operation: {
            kind: 'resize-cylindrical-face',
            faceHash: face.hash,
            ...(face.reference ? { faceReference: face.reference } : {}),
            sourceRadius: g.radius,
            sourceAxisStart: g.axisStart,
            sourceAxisEnd: g.axisEnd,
            concavity: g.featureType === 'through-hole' ? 'hole' : 'boss',
            radius: newRadius
          }
        })
      };
    }
    case 'edit-earlier': {
      const targetFeatureId = stepIdToFeatureId.get(step.targetStepId);
      if (!targetFeatureId) return null;
      const feature = listFeaturesInOrder(document).find(
        (node): node is FeatureNode => node.featureId === targetFeatureId
      );
      if (!feature || feature.data.featureKind !== 'direct-edit') return null;
      const op = feature.data.operation;
      let updated: DirectEditOperation | null = null;
      if (op.kind === 'offset-face' && typeof op.offset === 'number') {
        const nextOffset = cleanDecimal(op.offset + step.delta);
        if (Math.abs(nextOffset) <= 1e-6) return null;
        updated = { ...op, offset: nextOffset };
      } else if (
        op.kind === 'resize-blend' &&
        typeof op.newRadius === 'number'
      ) {
        const nextRadius = cleanDecimal(op.newRadius + step.delta);
        updated = { ...op, newRadius: nextRadius };
      } else if (
        op.kind === 'resize-cylindrical-face' &&
        typeof op.radius === 'number'
      ) {
        const nextRadius = cleanDecimal(op.radius + step.delta);
        updated = { ...op, radius: nextRadius };
      }
      if (!updated) return null;
      return {
        command: commandFactories.updateFeature(
          {
            featureId: targetFeatureId,
            data: { operation: updated }
          },
          `Edit ${feature.name}`
        )
      };
    }
  }
}

// -------------------------------------------------- step generation

interface GeneratorState {
  stepIndex: number;
  length: number;
  body: BodyRepresentation;
  document: ProjectDocument;
  canUndo: boolean;
  justUndid: boolean;
  editableSteps: readonly { stepId: string; featureId: FeatureId }[];
}

function generateNextStep(rng: () => number, state: GeneratorState): ChainStep {
  const stepId = `step-${state.stepIndex}`;
  const stepNumber = state.stepIndex + 1;

  // Reopen every 20th step. A reopen as the final step would repeat the
  // end-of-chain cold replay exactly, so a 20-step slice reopens at step 10
  // instead, and later undo steps cross the reopened history.
  if (
    (stepNumber % 20 === 0 && stepNumber < state.length) ||
    (state.length === 20 && stepNumber === 10)
  ) {
    return { kind: 'reopen', stepId };
  }

  const actionRoll = rng();
  // ~10% undo (50% followed by redo)
  if (state.canUndo && !state.justUndid && actionRoll < 0.1) {
    const redoAfter = rng() < 0.5;
    return { kind: 'undo', stepId, redoAfter };
  }

  // ~5% edit an earlier committed direct-edit step's value
  if (
    state.editableSteps.length > 0 &&
    actionRoll >= 0.1 &&
    actionRoll < 0.15
  ) {
    const target = pick(rng, state.editableSteps);
    const delta = pick(rng, [-0.5, -0.25, 0.25, 0.5]);
    return {
      kind: 'edit-earlier',
      stepId,
      targetStepId: target.stepId,
      delta
    };
  }

  // Otherwise pick an applicable direct-edit operation on the live body.
  const offsets = candidateOffsetFaces(state.body);
  const blends = candidateBlendFaces(state.body);
  const cylinders = candidateCylinderFaces(state.body);

  const weightedOps: Array<{
    kind: 'offset-face' | 'resize-blend' | 'resize-cylinder';
    weight: number;
  }> = [];
  if (offsets.length > 0) weightedOps.push({ kind: 'offset-face', weight: 60 });
  if (blends.length > 0) weightedOps.push({ kind: 'resize-blend', weight: 25 });
  if (cylinders.length > 0)
    weightedOps.push({ kind: 'resize-cylinder', weight: 15 });

  const totalWeight = weightedOps.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = rng() * totalWeight;
  let chosenKind = weightedOps[0]!.kind;
  for (const entry of weightedOps) {
    cursor -= entry.weight;
    if (cursor <= 0) {
      chosenKind = entry.kind;
      break;
    }
  }

  // ~10% near or past geometric limit; ~90% inside the safe ladder range.
  const probeLimit = rng() < 0.1;

  if (chosenKind === 'offset-face') {
    const chosen = pick(rng, offsets);
    const normal = chosen.face.geometry!.normal!;
    const span = bodySpanAlongNormal(state.body, normal);
    let offset: number;
    if (probeLimit) {
      const past = cleanDecimal(Math.max(10, roundTo(span + 2, 0.5)));
      offset = -past;
    } else {
      const magnitudes = [0.5, 1, 1.5, 2, 2.5, 3];
      const mag = pick(rng, magnitudes);
      const positiveBias = span < 8 ? 0.85 : 0.6;
      const sign = rng() < positiveBias ? 1 : -1;
      const clampedMag =
        sign < 0 ? Math.min(mag, Math.max(0.5, roundTo(span * 0.2, 0.5))) : mag;
      offset = cleanDecimal(sign * clampedMag);
    }
    return {
      kind: 'offset-face',
      stepId,
      face: chosen.selector,
      offset,
      ...(probeLimit ? { probeLimit: true } : {})
    };
  }

  if (chosenKind === 'resize-blend') {
    const chosen = pick(rng, blends);
    const carrier = blendCarrierSnapshot(chosen.face.geometry)!;
    const r = carrier.radius;
    let delta: number;
    if (probeLimit) {
      delta = rng() < 0.5 ? cleanDecimal(-(r + 0.5)) : cleanDecimal(15);
    } else {
      const candidates = [-0.5, -0.25, 0.25, 0.5, 0.75, 1].filter(
        (d) => r + d >= 0.5 && r + d <= 4.5
      );
      delta = candidates.length > 0 ? pick(rng, candidates) : 0.25;
    }
    return {
      kind: 'resize-blend',
      stepId,
      face: chosen.selector,
      delta,
      ...(probeLimit ? { probeLimit: true } : {})
    };
  }

  // resize-cylinder
  const chosen = pick(rng, cylinders);
  const r = chosen.face.geometry!.radius!;
  let delta: number;
  if (probeLimit) {
    delta = rng() < 0.5 ? cleanDecimal(-(r + 1)) : 20;
  } else {
    const candidates = [-1, -0.5, 0.5, 1, 1.5].filter(
      (d) => r + d >= 2 && r + d <= 14
    );
    delta = candidates.length > 0 ? pick(rng, candidates) : 0.5;
  }
  return {
    kind: 'resize-cylinder',
    stepId,
    face: chosen.selector,
    delta,
    ...(probeLimit ? { probeLimit: true } : {})
  };
}

// --------------------------------------------------------- chain runner

interface HistorySnapshot {
  body: BodyRepresentation;
  derived: DerivedState;
  lengths: ReturnType<typeof historyLengths>;
}

function makeFailureResult(
  failure: FailureSignature,
  evidence: string,
  failureStepIndex: number | undefined,
  recordedSteps: ChainStep[],
  executed: ExecutedStep[],
  body: BodyRepresentation,
  summary: ChainRunSummary
): ChainRunResult {
  return {
    outcome: { state: failure.state, evidence },
    failure,
    ...(failureStepIndex !== undefined ? { failureStepIndex } : {}),
    recordedSteps,
    executed,
    finalVolume: body.volume,
    finalCensus: faceCensus(body),
    summary
  };
}

export async function runChainDetailed(
  adapter: ExactKernelAdapter,
  cell: ChainCell,
  options: ChainRunOptions = {}
): Promise<ChainRunResult> {
  const startMs = Date.now();
  const budgetMs = options.budgetMs ?? 90_000;
  const session: Session = { adapter, deadline: startMs + budgetMs };
  const rng = createRng(hashSeed(cell.part, cell.seed));

  const recordedSteps: ChainStep[] = [];
  const executed: ExecutedStep[] = [];
  const summary: ChainRunSummary = {
    built: 0,
    refused: 0,
    undos: 0,
    redos: 0,
    editsEarlier: 0,
    reopens: 0,
    elapsedMs: 0
  };

  let initial: ReferencePart;
  let currentBody: BodyRepresentation;
  let currentDerived: DerivedState;
  let manager: CommandManager;
  try {
    initial = await initialReferencePart(session, cell.part);
    manager = new CommandManager(initial.document);
    currentDerived = await sync(session, manager.document, initial.bodyId);
    const initialBody = currentDerived.bodyRepresentations[initial.bodyId];
    if (!initialBody) {
      throw new Error(`Reference part ${cell.part} failed initial sync.`);
    }
    currentBody = initialBody;
  } catch (error) {
    summary.elapsedMs = Date.now() - startMs;
    const isTimeout =
      error instanceof CellTimeout || Date.now() > session.deadline;
    const message = error instanceof Error ? error.message : String(error);
    const failure: FailureSignature = isTimeout
      ? { state: 'timeout', oracle: 'timeout' }
      : { state: 'untyped-refusal', oracle: 'unexpected-throw' };
    return {
      outcome: {
        state: failure.state,
        evidence: `initial part ${cell.part}: ${message.slice(0, 400)}`
      },
      failure,
      recordedSteps,
      executed,
      finalVolume: 0,
      finalCensus: [],
      summary
    };
  }

  const bodyId = initial.bodyId;
  const undoStack: HistorySnapshot[] = [];
  const stepIdToFeatureId = new Map<string, FeatureId>();
  let justUndid = false;

  const totalSteps = cell.steps ? cell.steps.length : cell.length;

  try {
    for (let stepIndex = 0; stepIndex < totalSteps; stepIndex += 1) {
      if (Date.now() > session.deadline) {
        throw new CellTimeout(
          `budget ${budgetMs} ms exceeded at step ${stepIndex}`
        );
      }

      const activeFeatureIds = new Set(
        listFeaturesInOrder(manager.document).map((node) => node.featureId)
      );
      const editableSteps = [...stepIdToFeatureId.entries()]
        .filter(([, featureId]) => activeFeatureIds.has(featureId))
        .map(([stepId, featureId]) => ({ stepId, featureId }));

      const step: ChainStep = cell.steps
        ? cell.steps[stepIndex]!
        : generateNextStep(rng, {
            stepIndex,
            length: totalSteps,
            body: currentBody,
            document: manager.document,
            canUndo: undoStack.length > 0,
            justUndid,
            editableSteps
          });

      recordedSteps.push(step);
      const volumeBefore = currentBody.volume;
      const faceCountBefore = currentBody.topology?.faces.length ?? 0;

      // ---- reopen step ----
      if (step.kind === 'reopen') {
        summary.reopens += 1;
        const stored = JSON.parse(
          JSON.stringify(withoutDerivedProjection(manager.document))
        ) as ProjectDocument;
        const reopened = normalizeDocument(stored);
        const cold = await coldSync(session, reopened, bodyId);
        const coldRefused = refusal(cold, `step ${stepIndex} reopen`);
        if (coldRefused) {
          summary.elapsedMs = Date.now() - startMs;
          const failure: FailureSignature = {
            state:
              coldRefused.state === 'typed-refusal'
                ? 'typed-refusal'
                : 'untyped-refusal',
            oracle: 'reopen-exact',
            refusalCategory:
              cold.featureWarnings?.find((w) => w.kernelRefusal)?.kernelRefusal
                ?.category ?? 'untyped'
          };
          return makeFailureResult(
            failure,
            coldRefused.evidence,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        const reopenedBody = cold.bodyRepresentations[bodyId];
        if (!reopenedBody || !sameExactSnapshot(reopenedBody, currentBody)) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            {
              state: 'wrong',
              oracle: 'reopen-exact',
              wrongCheck: 'reopen-snapshot-mismatch'
            },
            `step ${stepIndex} reopen mismatch: ${reopenedBody?.volume} ${reopenedBody ? census(reopenedBody) : 'missing'} vs ${currentBody.volume} ${census(currentBody)}`,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        // Continue editing from the reopened document so post-reopen continuity
        // is exercised by subsequent steps.
        // The saved form keeps its edit history, so later undo steps cross
        // the reopen and must still restore each earlier body exactly.
        manager = new CommandManager(reopened);
        currentDerived = await sync(session, manager.document, bodyId);
        currentBody = currentDerived.bodyRepresentations[bodyId]!;
        justUndid = false;
        const entry: ExecutedStep = {
          index: stepIndex,
          step,
          status: 'reopened',
          volumeBefore,
          volumeAfter: currentBody.volume,
          faceCountBefore,
          faceCountAfter: currentBody.topology?.faces.length ?? 0
        };
        executed.push(entry);
        const hooked = options.extraStepOracle?.({
          stepIndex,
          step,
          status: entry.status,
          body: currentBody,
          document: manager.document,
          executed
        });
        if (hooked) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            hooked.failure,
            hooked.evidence,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        continue;
      }

      // ---- undo / redo step ----
      if (step.kind === 'undo') {
        const expectedPrior = undoStack.pop();
        if (!expectedPrior) {
          executed.push({
            index: stepIndex,
            step,
            status: 'skipped',
            volumeBefore,
            volumeAfter: volumeBefore,
            faceCountBefore,
            faceCountAfter: faceCountBefore
          });
          justUndid = false;
          continue;
        }
        summary.undos += 1;
        if (!manager.canUndo) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            {
              state: 'wrong',
              oracle: 'undo-exact',
              wrongCheck: 'undo-unavailable'
            },
            `step ${stepIndex} undo: ${undoStack.length + 1} chain edit(s) committed but the document has nothing to undo`,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        const preUndoSnapshot: HistorySnapshot = {
          body: currentBody,
          derived: currentDerived,
          lengths: historyLengths(manager.document)
        };
        manager.undo();
        const undoneDerived = await sync(session, manager.document, bodyId);
        const undoRefused = refusal(undoneDerived, `step ${stepIndex} undo`);
        if (undoRefused) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            {
              state:
                undoRefused.state === 'typed-refusal'
                  ? 'typed-refusal'
                  : 'untyped-refusal',
              oracle: 'undo-exact',
              refusalCategory:
                undoneDerived.featureWarnings?.find((w) => w.kernelRefusal)
                  ?.kernelRefusal?.category ?? 'untyped'
            },
            undoRefused.evidence,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        const undoneBody = undoneDerived.bodyRepresentations[bodyId];
        const undoneLengths = historyLengths(manager.document);
        if (
          !undoneBody ||
          undoneLengths.features !== expectedPrior.lengths.features ||
          !sameExactSnapshot(undoneBody, expectedPrior.body)
        ) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            {
              state: 'wrong',
              oracle: 'undo-exact',
              wrongCheck: 'undo-snapshot-mismatch'
            },
            `step ${stepIndex} undo did not restore exact prior state: vol ${undoneBody?.volume} vs ${expectedPrior.body.volume}, features ${undoneLengths.features} vs ${expectedPrior.lengths.features}`,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }

        if (step.redoAfter) {
          summary.redos += 1;
          manager.redo();
          const redoneDerived = await sync(session, manager.document, bodyId);
          const redoRefused = refusal(redoneDerived, `step ${stepIndex} redo`);
          if (redoRefused) {
            summary.elapsedMs = Date.now() - startMs;
            return makeFailureResult(
              {
                state:
                  redoRefused.state === 'typed-refusal'
                    ? 'typed-refusal'
                    : 'untyped-refusal',
                oracle: 'redo-exact',
                refusalCategory:
                  redoneDerived.featureWarnings?.find((w) => w.kernelRefusal)
                    ?.kernelRefusal?.category ?? 'untyped'
              },
              redoRefused.evidence,
              stepIndex,
              recordedSteps,
              executed,
              currentBody,
              summary
            );
          }
          const redoneBody = redoneDerived.bodyRepresentations[bodyId];
          const redoneLengths = historyLengths(manager.document);
          if (
            !redoneBody ||
            redoneLengths.features !== preUndoSnapshot.lengths.features ||
            !sameExactSnapshot(redoneBody, preUndoSnapshot.body)
          ) {
            summary.elapsedMs = Date.now() - startMs;
            return makeFailureResult(
              {
                state: 'wrong',
                oracle: 'redo-exact',
                wrongCheck: 'redo-snapshot-mismatch'
              },
              `step ${stepIndex} redo did not reproduce exact state: vol ${redoneBody?.volume} vs ${preUndoSnapshot.body.volume}`,
              stepIndex,
              recordedSteps,
              executed,
              currentBody,
              summary
            );
          }
          undoStack.push(expectedPrior);
          currentDerived = redoneDerived;
          currentBody = redoneBody;
          justUndid = false;
          const entry: ExecutedStep = {
            index: stepIndex,
            step,
            status: 'undone-redone',
            volumeBefore,
            volumeAfter: currentBody.volume,
            faceCountBefore,
            faceCountAfter: currentBody.topology?.faces.length ?? 0
          };
          executed.push(entry);
          const hooked = options.extraStepOracle?.({
            stepIndex,
            step,
            status: entry.status,
            body: currentBody,
            document: manager.document,
            executed
          });
          if (hooked) {
            summary.elapsedMs = Date.now() - startMs;
            return makeFailureResult(
              hooked.failure,
              hooked.evidence,
              stepIndex,
              recordedSteps,
              executed,
              currentBody,
              summary
            );
          }
          continue;
        }

        currentDerived = undoneDerived;
        currentBody = undoneBody;
        justUndid = true;
        const entry: ExecutedStep = {
          index: stepIndex,
          step,
          status: 'undone',
          volumeBefore,
          volumeAfter: currentBody.volume,
          faceCountBefore,
          faceCountAfter: currentBody.topology?.faces.length ?? 0
        };
        executed.push(entry);
        const hooked = options.extraStepOracle?.({
          stepIndex,
          step,
          status: entry.status,
          body: currentBody,
          document: manager.document,
          executed
        });
        if (hooked) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            hooked.failure,
            hooked.evidence,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        continue;
      }

      // ---- direct-edit or edit-earlier step ----
      justUndid = false;
      const builtCommand = buildStepCommand(
        step,
        manager.document,
        bodyId,
        currentBody,
        stepIdToFeatureId
      );
      if (!builtCommand) {
        executed.push({
          index: stepIndex,
          step,
          status: 'skipped',
          volumeBefore,
          volumeAfter: volumeBefore,
          faceCountBefore,
          faceCountAfter: faceCountBefore
        });
        continue;
      }
      if (step.kind === 'edit-earlier') summary.editsEarlier += 1;

      const beforeDoc = manager.document;
      const beforeLengths = historyLengths(beforeDoc);
      const draft = new CommandManager(beforeDoc);
      draft.execute(builtCommand.command);
      const draftDerived = await sync(session, draft.document, bodyId, {
        proposeCarry: true
      });

      const blocking = (draftDerived.featureWarnings ?? []).find(
        (warning) =>
          warning.kind === 'build-failed' || warning.kind === 'refusal'
      );
      const rawRefusal = refusal(
        draftDerived,
        `step ${stepIndex} ${step.kind}`
      );

      if (blocking || rawRefusal) {
        summary.refused += 1;
        // Oracle 8a: refusal must carry a typed kernelRefusal.
        if (!blocking?.kernelRefusal) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            {
              state: 'untyped-refusal',
              oracle: 'refusal-typed',
              refusalCategory: 'untyped'
            },
            `step ${stepIndex} (${step.kind}) refused without kernelRefusal: ${rawRefusal?.evidence ?? blocking?.message ?? '(none)'}`,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        const kr = blocking.kernelRefusal;
        const rejection = validatedFeatureRejection({
          featureName: blocking.featureName,
          featureId: blocking.featureId,
          bodyPresent: draftDerived.bodyRepresentations[bodyId] !== undefined,
          warnings: draftDerived.warnings,
          featureWarnings: draftDerived.featureWarnings,
          documentMoved: false
        });
        // Oracle 8b: refusal must produce a specific non-generic user sentence.
        if (
          !rejection?.message ||
          rejection.message === GENERIC_REFUSAL ||
          rejection.message === 'Not built'
        ) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            {
              state: 'untyped-refusal',
              oracle: 'refusal-explanation',
              refusalCategory: kr.category,
              refusalCode: kr.code
            },
            `step ${stepIndex} (${step.kind}) produced generic/empty refusal explanation "${rejection?.message ?? ''}" for ${kr.family}/${kr.category}/${kr.code}`,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        // Oracle 7: refusal leaves document and geometry completely unchanged.
        if (
          manager.document !== beforeDoc ||
          !sameHistoryLengths(historyLengths(manager.document), beforeLengths)
        ) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            {
              state: 'wrong',
              oracle: 'refusal-unchanged',
              wrongCheck: 'refusal-mutated-document'
            },
            `step ${stepIndex} (${step.kind}) refusal mutated document history`,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        const recheck = await sync(session, manager.document, bodyId);
        const recheckRefused = refusal(
          recheck,
          `step ${stepIndex} post-refusal recheck`
        );
        const recheckBody = recheck.bodyRepresentations[bodyId];
        if (
          recheckRefused ||
          !recheckBody ||
          !sameExactSnapshot(recheckBody, currentBody)
        ) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            {
              state: 'wrong',
              oracle: 'refusal-unchanged',
              wrongCheck: 'refusal-mutated-geometry'
            },
            `step ${stepIndex} (${step.kind}) refusal changed live geometry: ${recheckRefused?.evidence ?? `${recheckBody?.volume} vs ${currentBody.volume}`}`,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        // Every refusal a chain reaches is a measurement: it must match a pin
        // by kernel taxonomy and the literal user sentence, with an owner.
        const pin = CHAIN_REFUSAL_PINS.find(
          (entry) =>
            entry.family === kr.family &&
            entry.category === kr.category &&
            entry.code === kr.code &&
            entry.messages.includes(rejection.message)
        );
        if (!pin) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            {
              state: 'typed-refusal',
              oracle: 'refusal-pin',
              refusalCategory: kr.category,
              refusalCode: kr.code
            },
            `step ${stepIndex} (${step.kind}) unpinned refusal ${kr.family}/${kr.category}/${kr.code}: "${rejection.message}"`,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        const entry: ExecutedStep = {
          index: stepIndex,
          step,
          status: 'refused',
          pin: pin.id,
          refusedFeature: `${blocking.featureName ?? '?'} #${listFeaturesInOrder(draft.document).findIndex((node) => node.featureId === blocking.featureId)}/${listFeaturesInOrder(draft.document).length}${step.kind === 'edit-earlier' && stepIdToFeatureId.get(step.targetStepId) === blocking.featureId ? ' (the edited feature)' : ''}`,
          volumeBefore,
          volumeAfter: currentBody.volume,
          faceCountBefore,
          faceCountAfter: currentBody.topology?.faces.length ?? 0,
          refusalMessage: rejection.message,
          kernelRefusal: kr
        };
        executed.push(entry);
        const hooked = options.extraStepOracle?.({
          stepIndex,
          step,
          status: entry.status,
          body: currentBody,
          document: manager.document,
          executed
        });
        if (hooked) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            hooked.failure,
            hooked.evidence,
            stepIndex,
            recordedSteps,
            executed,
            currentBody,
            summary
          );
        }
        continue;
      }

      // ---- step built: verify oracles before committing ----
      const afterBody = draftDerived.bodyRepresentations[bodyId];
      const geoIssue = checkBuildGeometry(afterBody);
      if (geoIssue) {
        summary.elapsedMs = Date.now() - startMs;
        return makeFailureResult(
          geoIssue.failure,
          `step ${stepIndex} (${step.kind}): ${geoIssue.evidence}`,
          stepIndex,
          recordedSteps,
          executed,
          currentBody,
          summary
        );
      }

      const editFeatureId =
        step.kind === 'edit-earlier'
          ? stepIdToFeatureId.get(step.targetStepId)
          : draft.document.featureOrder.at(-1);
      const chainFeatureIds = new Set(stepIdToFeatureId.values());
      if (step.kind !== 'edit-earlier') {
        const created = draft.document.featureOrder.at(-1);
        if (created) chainFeatureIds.add(created);
      }
      const approxIssue = checkApproximationDisclosure(
        initial,
        draftDerived.featureWarnings ?? [],
        chainFeatureIds
      );
      if (approxIssue) {
        summary.elapsedMs = Date.now() - startMs;
        return makeFailureResult(
          approxIssue.failure,
          `step ${stepIndex} (${step.kind}): ${approxIssue.evidence}`,
          stepIndex,
          recordedSteps,
          executed,
          currentBody,
          summary
        );
      }

      if (step.kind === 'offset-face' && builtCommand.pickedFace) {
        const shapeIssue = checkOffsetShapeOracle(
          cell.part,
          currentBody,
          afterBody!,
          builtCommand.pickedFace,
          step.offset
        );
        if (shapeIssue) {
          summary.elapsedMs = Date.now() - startMs;
          return makeFailureResult(
            shapeIssue.failure,
            `step ${stepIndex} (${step.kind} ${step.offset}): ${shapeIssue.evidence}`,
            stepIndex,
            recordedSteps,
            executed,
            afterBody!,
            summary
          );
        }
      }

      // Commit with carry (matching app executeCommand).
      const commit = await commitWithCarry(
        session,
        beforeDoc,
        builtCommand.command.label,
        [builtCommand.command],
        draftDerived,
        bodyId
      );
      if ('stopped' in commit) {
        summary.elapsedMs = Date.now() - startMs;
        return makeFailureResult(
          {
            state:
              commit.stopped.state === 'qualified'
                ? 'wrong'
                : commit.stopped.state,
            oracle: 'carry-commit',
            wrongCheck: 'carry-commit-failed'
          },
          `step ${stepIndex} (${step.kind}): ${commit.stopped.evidence}`,
          stepIndex,
          recordedSteps,
          executed,
          currentBody,
          summary
        );
      }

      // Strict B-rep solid validity check on every built step.
      const strictIssue = await verifyStepSolid(
        session,
        commit.manager.document,
        draftDerived,
        afterBody!,
        false
      );
      if (strictIssue) {
        summary.elapsedMs = Date.now() - startMs;
        return makeFailureResult(
          strictIssue.failure,
          `step ${stepIndex} (${step.kind}): ${strictIssue.evidence}`,
          stepIndex,
          recordedSteps,
          executed,
          afterBody!,
          summary
        );
      }

      // A new edit adds one feature and one history entry; editing an
      // earlier value adds the entry only. Anything else breaks undo's
      // step-for-step contract and the step-to-feature map below.
      const committedLengths = historyLengths(commit.manager.document);
      const addedFeatures = step.kind === 'edit-earlier' ? 0 : 1;
      if (
        committedLengths.features !== beforeLengths.features + addedFeatures ||
        committedLengths.cursor !== beforeLengths.cursor + 1
      ) {
        summary.elapsedMs = Date.now() - startMs;
        return makeFailureResult(
          {
            state: 'wrong',
            oracle: 'carry-commit',
            wrongCheck: 'history-length-mismatch'
          },
          `step ${stepIndex} (${step.kind}) changed history ${JSON.stringify(beforeLengths)} -> ${JSON.stringify(committedLengths)}`,
          stepIndex,
          recordedSteps,
          executed,
          currentBody,
          summary
        );
      }
      undoStack.push({
        body: currentBody,
        derived: currentDerived,
        lengths: beforeLengths
      });
      manager = commit.manager;
      currentDerived = draftDerived;
      currentBody = afterBody!;
      summary.built += 1;

      if (step.kind !== 'edit-earlier') {
        const newFeatureId = manager.document.featureOrder.at(-1);
        if (newFeatureId) stepIdToFeatureId.set(step.stepId, newFeatureId);
      }

      const advisories = (draftDerived.featureWarnings ?? [])
        .filter((w) => w.kind === 'advisory' && w.featureId === editFeatureId)
        .map((w) => w.message);

      const entry: ExecutedStep = {
        index: stepIndex,
        step,
        status: 'committed',
        volumeBefore,
        volumeAfter: currentBody.volume,
        faceCountBefore,
        faceCountAfter: currentBody.topology?.faces.length ?? 0,
        ...(advisories.length > 0 ? { advisories } : {})
      };
      executed.push(entry);

      const hooked = options.extraStepOracle?.({
        stepIndex,
        step,
        status: entry.status,
        body: currentBody,
        document: manager.document,
        executed
      });
      if (hooked) {
        summary.elapsedMs = Date.now() - startMs;
        return makeFailureResult(
          hooked.failure,
          hooked.evidence,
          stepIndex,
          recordedSteps,
          executed,
          currentBody,
          summary
        );
      }
    }

    // ---- End of chain: cold replay from document alone ----
    const stored = JSON.parse(
      JSON.stringify(withoutDerivedProjection(manager.document))
    ) as ProjectDocument;
    const reopened = normalizeDocument(stored);
    const cold = await coldSync(session, reopened, bodyId);
    const coldRefused = refusal(cold, 'end-of-chain cold replay');
    if (coldRefused) {
      summary.elapsedMs = Date.now() - startMs;
      return makeFailureResult(
        {
          state:
            coldRefused.state === 'typed-refusal'
              ? 'typed-refusal'
              : 'untyped-refusal',
          oracle: 'cold-replay',
          refusalCategory:
            cold.featureWarnings?.find((w) => w.kernelRefusal)?.kernelRefusal
              ?.category ?? 'untyped'
        },
        coldRefused.evidence,
        undefined,
        recordedSteps,
        executed,
        currentBody,
        summary
      );
    }
    const coldBody = cold.bodyRepresentations[bodyId];
    if (!coldBody || !sameExactSnapshot(coldBody, currentBody)) {
      summary.elapsedMs = Date.now() - startMs;
      return makeFailureResult(
        {
          state: 'wrong',
          oracle: 'cold-replay',
          wrongCheck: 'cold-replay-mismatch'
        },
        `cold replay mismatch: ${coldBody?.volume} ${coldBody ? census(coldBody) : 'missing'} vs ${currentBody.volume} ${census(currentBody)}`,
        undefined,
        recordedSteps,
        executed,
        currentBody,
        summary
      );
    }

    // ---- End of chain: STEP export/reimport volume and face census ----
    const stepRoundtripIssue = await verifyStepSolid(
      session,
      manager.document,
      currentDerived,
      currentBody,
      true
    );
    if (stepRoundtripIssue) {
      summary.elapsedMs = Date.now() - startMs;
      return makeFailureResult(
        stepRoundtripIssue.failure,
        `end-of-chain STEP roundtrip: ${stepRoundtripIssue.evidence}`,
        undefined,
        recordedSteps,
        executed,
        currentBody,
        summary
      );
    }

    summary.elapsedMs = Date.now() - startMs;
    return {
      outcome: {
        state: 'qualified',
        evidence: [
          `built ${summary.built}`,
          `refused ${summary.refused}`,
          `undo ${summary.undos}/redo ${summary.redos}`,
          `edit-earlier ${summary.editsEarlier}`,
          `reopen ${summary.reopens}`,
          `vol ${currentBody.volume.toPrecision(10)}`,
          census(currentBody),
          `${summary.elapsedMs} ms`
        ].join('; ')
      },
      recordedSteps,
      executed,
      finalVolume: currentBody.volume,
      finalCensus: faceCensus(currentBody),
      summary
    };
  } catch (error) {
    summary.elapsedMs = Date.now() - startMs;
    const isTimeout =
      error instanceof CellTimeout || Date.now() > session.deadline;
    const message = error instanceof Error ? error.message : String(error);
    const failure: FailureSignature = isTimeout
      ? { state: 'timeout', oracle: 'timeout' }
      : { state: 'untyped-refusal', oracle: 'unexpected-throw' };
    return makeFailureResult(
      failure,
      isTimeout ? `exceeded ${budgetMs} ms` : `threw: ${message.slice(0, 400)}`,
      recordedSteps.length > 0 ? recordedSteps.length - 1 : undefined,
      recordedSteps,
      executed,
      currentBody,
      summary
    );
  }
}

// -------------------------------------------------- shrinking & formatting

function numericValueOf(step: ChainStep): number | null {
  switch (step.kind) {
    case 'offset-face':
      return step.offset;
    case 'resize-blend':
    case 'resize-cylinder':
    case 'edit-earlier':
      return step.delta;
    default:
      return null;
  }
}

function withNumericValue(step: ChainStep, value: number): ChainStep {
  switch (step.kind) {
    case 'offset-face':
      return { ...step, offset: value };
    case 'resize-blend':
    case 'resize-cylinder':
    case 'edit-earlier':
      return { ...step, delta: value };
    default:
      return step;
  }
}

/**
 * Candidate simpler numeric values in simplicity order (fewest decimals and
 * smaller magnitude first), excluding the original value and non-zero no-ops.
 */
function simplerValues(value: number): number[] {
  const candidates: number[] = [];
  const push = (v: number) => {
    const clean = cleanDecimal(v);
    if (!Number.isFinite(clean) || Math.abs(clean) <= 1e-9) return;
    if (Math.abs(clean - value) <= 1e-9) return;
    if (!candidates.some((existing) => Math.abs(existing - clean) <= 1e-9)) {
      candidates.push(clean);
    }
  };
  push(Math.trunc(value));
  push(Math.round(value));
  push(Math.trunc(value / 2));
  push(roundTo(value, 0.5));
  push(roundTo(value, 0.1));
  push(roundTo(value, 0.01));
  return candidates;
}

/**
 * Chain-specific shrinker wired into `LedgerRunner.shrink` (`K10_SHRINK=1`).
 *
 * 1. Truncates after the failing step (when the failure happened mid-chain).
 * 2. Removes steps one at a time until no single removal preserves the exact
 *    `FailureSignature` (same state, oracle, refusal category/code, or
 *    wrong-result check).
 * 3. Rounds numeric values on remaining steps toward simpler values while
 *    preserving the exact `FailureSignature`.
 * 4. Runs a final removal pass in case rounding made an earlier step redundant.
 */
export async function shrinkChain(
  adapter: ExactKernelAdapter,
  cell: ChainCell,
  targetState: CellState,
  options: ChainShrinkOptions = {}
): Promise<ChainCell> {
  const maxProbes = options.maxProbes ?? 80;
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  let probes = 0;
  const canProbe = () => probes < maxProbes && Date.now() < deadline;

  const baseline =
    options.baseline ?? (await runChainDetailed(adapter, cell, options));
  const targetFailure = baseline.failure;
  if (!targetFailure || targetFailure.state !== targetState) {
    return cell;
  }

  let currentSteps = [...baseline.recordedSteps];

  const reproduces = async (steps: readonly ChainStep[]): Promise<boolean> => {
    if (!canProbe()) return false;
    probes += 1;
    const candidate: ChainCell = {
      ...cell,
      length: steps.length,
      steps
    };
    const result = await runChainDetailed(adapter, candidate, {
      ...options,
      ...(Number.isFinite(deadline)
        ? { budgetMs: Math.max(1, deadline - Date.now()) }
        : {})
    });
    return sameFailureSignature(result.failure, targetFailure);
  };

  // Truncate trailing steps after a mid-chain failure if any exist.
  if (
    baseline.failureStepIndex !== undefined &&
    baseline.failureStepIndex + 1 < currentSteps.length
  ) {
    const prefix = currentSteps.slice(0, baseline.failureStepIndex + 1);
    if (await reproduces(prefix)) {
      currentSteps = prefix;
    }
  }

  const removePass = async (): Promise<boolean> => {
    let changed = false;
    let index = 0;
    while (index < currentSteps.length && canProbe()) {
      const removed = currentSteps[index]!;
      // Dropping a step also drops any later edit-earlier targeting it.
      const candidate = currentSteps.filter(
        (step, i) =>
          i !== index &&
          !(
            step.kind === 'edit-earlier' && step.targetStepId === removed.stepId
          )
      );
      if (candidate.length === 0) {
        index += 1;
        continue;
      }
      if (await reproduces(candidate)) {
        currentSteps = candidate;
        changed = true;
      } else {
        index += 1;
      }
    }
    return changed;
  };

  // Phase 1: remove irrelevant steps until fixpoint.
  while (canProbe()) {
    if (!(await removePass())) break;
  }

  // Phase 2: round numeric values on remaining steps.
  let roundedAny = false;
  // Each accepted value is rounded again until no simpler value keeps the
  // same failure, so 2.375 can reach 2 and then 1 only if 1 still fails the
  // same way.
  for (let i = 0; i < currentSteps.length && canProbe(); i += 1) {
    let improved = true;
    while (improved && canProbe()) {
      improved = false;
      const currentValue = numericValueOf(currentSteps[i]!);
      if (currentValue === null) break;
      for (const simpler of simplerValues(currentValue)) {
        if (!canProbe()) break;
        const candidate = currentSteps.map((entry, idx) =>
          idx === i ? withNumericValue(entry, simpler) : entry
        );
        if (await reproduces(candidate)) {
          currentSteps = candidate;
          roundedAny = true;
          improved = true;
          break;
        }
      }
    }
  }

  // Phase 3: final removal pass if rounding unlocked further removals.
  if (roundedAny && canProbe()) {
    await removePass();
  }

  return {
    ...cell,
    length: currentSteps.length,
    steps: currentSteps
  };
}

function formatStep(step: ChainStep, index: number): string {
  const n = index + 1;
  switch (step.kind) {
    case 'offset-face':
      return `${n}. [${step.stepId}] offset-face ${step.face.surfaceType} center=(${step.face.center.x.toFixed(2)}, ${step.face.center.y.toFixed(2)}, ${step.face.center.z.toFixed(2)}) by ${step.offset} mm${step.probeLimit ? ' (limit probe)' : ''}`;
    case 'resize-blend':
      return `${n}. [${step.stepId}] resize-blend ${step.face.surfaceType} center=(${step.face.center.x.toFixed(2)}, ${step.face.center.y.toFixed(2)}, ${step.face.center.z.toFixed(2)}) delta ${step.delta} mm${step.probeLimit ? ' (limit probe)' : ''}`;
    case 'resize-cylinder':
      return `${n}. [${step.stepId}] resize-cylinder center=(${step.face.center.x.toFixed(2)}, ${step.face.center.y.toFixed(2)}, ${step.face.center.z.toFixed(2)}) delta ${step.delta} mm${step.probeLimit ? ' (limit probe)' : ''}`;
    case 'edit-earlier':
      return `${n}. [${step.stepId}] edit-earlier ${step.targetStepId} delta ${step.delta} mm`;
    case 'undo':
      return `${n}. [${step.stepId}] undo${step.redoAfter ? ' + redo' : ''}`;
    case 'reopen':
      return `${n}. [${step.stepId}] reopen`;
  }
}

const lastRunByCellId = new Map<string, ChainRunResult>();

/** The detailed result of the latest ledger run of a cell, if any. */
export function lastChainRun(id: string): ChainRunResult | undefined {
  return lastRunByCellId.get(id);
}

export function chainReproduction(cell: ChainCell): string {
  const cached = lastRunByCellId.get(cell.id);
  const steps = cell.steps ?? cached?.recordedSteps ?? [];
  const lines = [
    `K10 direct-edit chain ${cell.id} (part=${cell.part}, seed=${cell.seed}, length=${cell.length})`
  ];
  if (cached?.failure) {
    lines.push(
      `Failure signature: ${JSON.stringify(cached.failure)} at step ${cached.failureStepIndex ?? 'end-of-chain'}`
    );
  }
  for (let i = 0; i < steps.length; i += 1) {
    const exec = cached?.executed[i];
    const tag = exec
      ? ` => ${exec.status}${exec.pin ? ` [${exec.pin}: ${exec.refusedFeature}]` : ''}`
      : '';
    lines.push(`${formatStep(steps[i]!, i)}${tag}`);
  }
  lines.push(
    `Run: K10_CELL='${cell.id}' pnpm exec vitest run test/direct-edit-corpus/chains.test.ts`
  );
  return lines.join('\n');
}

export const CHAIN_LEDGER_RUNNER: LedgerRunner<ChainCell> = {
  async run(adapter, cell) {
    const result = await runChainDetailed(adapter, cell);
    lastRunByCellId.set(cell.id, result);
    return result.outcome;
  },
  reproduction: chainReproduction,
  async shrink(adapter, cell, state) {
    const baseline = lastRunByCellId.get(cell.id);
    // The ledger test allows each cell 120 s, its own run included; stop
    // probing with room to print the minimal history found so far.
    return shrinkChain(adapter, cell, state, {
      ...(baseline ? { baseline } : {}),
      deadline:
        Date.now() +
        Math.max(5_000, 105_000 - (baseline?.summary.elapsedMs ?? 0))
    });
  }
};
