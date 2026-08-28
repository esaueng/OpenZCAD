import {
  coerceParamValue,
  type DraftInput,
  type HelicalSweepInput,
  type HoleInput,
  type LoftInput,
  type MirrorInput,
  type ShellInput,
  type SolidOffsetInput,
  type SplitInput,
  type SweepInput,
  type ThickenInput
} from '@openzcad/document-core';
import {
  MAX_HELICAL_SWEEP_TURNS,
  type BodyId,
  type BodyTopology,
  type FaceTopologyReferenceV5,
  type SketchPathReference,
  type SketchSectionReference
} from '@openzcad/shared';
import { evalParamValue, previewExpression } from './model';

export type ModelingOperationKind =
  | 'mirror'
  | 'split'
  | 'hole'
  | 'shell'
  | 'solid-offset'
  | 'loft'
  | 'sweep'
  | 'helical-sweep'
  | 'draft'
  | 'thicken';

export type ExactPreflightState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ready' }
  | { status: 'refused'; reason: string };

export type ExactPreflightResult =
  { status: 'ready' } | { status: 'refused'; reason: string };

export interface ModelingProfileOption {
  id: string;
  label: string;
  section: SketchSectionReference;
}

export interface ModelingPathOption {
  id: string;
  label: string;
  path: SketchPathReference;
}

export interface MirrorFormState {
  name: string;
  targetBodyId: BodyId | '';
  origin: { x: string; y: string; z: string };
  normal: { x: string; y: string; z: string };
}

export interface ShellFormState {
  name: string;
  targetBodyId: BodyId | '';
  thickness: string;
  openingFaceHashes: number[];
}

export interface SolidOffsetFormState {
  name: string;
  targetBodyId: BodyId | '';
  distance: string;
}

export interface LoftFormState {
  name: string;
  sectionIds: string[];
  mode: 'ruled' | 'smooth';
}

export interface SweepFormState {
  name: string;
  profileId: string;
  pathId: string;
  mode: 'standard' | 'smooth';
}

export interface HelicalSweepFormState {
  name: string;
  profileId: string;
  axisOrigin: { x: string; y: string; z: string };
  axisDirection: { x: string; y: string; z: string };
  radius: string;
  pitch: string;
  turns: string;
}

export interface DraftFormState {
  name: string;
  targetBodyId: BodyId | '';
  faceHashes: number[];
  pullDirection: { x: string; y: string; z: string };
  neutralPoint: { x: string; y: string; z: string };
  angleDeg: string;
}

export interface HoleFormState {
  name: string;
  targetBodyId: BodyId | '';
  /** The planar entry face; null until picked. */
  faceHash: number | null;
  style: 'simple' | 'counterbore' | 'countersink';
  diameter: string;
  depthMode: 'blind' | 'through';
  depth: string;
  counterboreDiameter: string;
  counterboreDepth: string;
  countersinkDiameter: string;
  countersinkAngleDeg: string;
  /** Axis position in the face frame; (0, 0) is the face centre. */
  position: { u: string; v: string };
}

export interface ThickenFormState {
  name: string;
  targetBodyId: BodyId | '';
  faceHash: number | null;
  thickness: string;
}

export type ModelingOperationFormState =
  | { operation: 'mirror'; value: MirrorFormState }
  /** A split's plane form is shape-identical to mirror's. */
  | { operation: 'split'; value: MirrorFormState }
  | { operation: 'hole'; value: HoleFormState }
  | { operation: 'shell'; value: ShellFormState }
  | { operation: 'solid-offset'; value: SolidOffsetFormState }
  | { operation: 'loft'; value: LoftFormState }
  | { operation: 'sweep'; value: SweepFormState }
  | { operation: 'helical-sweep'; value: HelicalSweepFormState }
  | { operation: 'draft'; value: DraftFormState }
  | { operation: 'thicken'; value: ThickenFormState };

export type ModelingOperationSubmission =
  | { operation: 'mirror'; input: MirrorInput }
  | { operation: 'split'; input: SplitInput }
  | { operation: 'hole'; input: HoleInput }
  | { operation: 'shell'; input: ShellInput }
  | { operation: 'solid-offset'; input: SolidOffsetInput }
  | { operation: 'loft'; input: LoftInput }
  | { operation: 'sweep'; input: SweepInput }
  | { operation: 'helical-sweep'; input: HelicalSweepInput }
  | { operation: 'draft'; input: DraftInput }
  | { operation: 'thicken'; input: ThickenInput };

export interface ModelingFaceOption {
  hash: number;
  topologyId: string;
  label: string;
  surfaceType?: string;
  reference?: FaceTopologyReferenceV5;
  /**
   * Whether the face reports an area centroid, which is what a hole drilled
   * into it is positioned from. The point itself is deliberately not carried:
   * the rebuild re-derives it from the resolved face, and a stored world
   * position would go stale the moment an upstream feature moved the body.
   */
  hasCentroid?: boolean;
}

export interface ModelingOperationCapability {
  exactState: 'ready' | 'pending' | 'failed';
  exactFailureReason?: string;
  hasTargetBody: boolean;
  openingFaceCount?: number;
  profileCount?: number;
  pathCount?: number;
}

function titleCase(value: string): string {
  return value.length === 0
    ? 'Unknown'
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function readableLineageName(value: string): string | null {
  if (value.startsWith('import.step.')) return null;
  return value
    .replace(/^(?:primitive|sweep)\./, '')
    .split('.')
    .map((part) => part.replaceAll('-', ' '))
    .join(' · ');
}

export function topologyFaceLabel(
  face: BodyTopology['faces'][number],
  index: number
): string {
  const carrier = face.geometry?.surfaceType
    ? `${titleCase(face.geometry.surfaceType)} face`
    : 'Face';
  const lineageName = face.reference?.lineageName;
  const identity =
    (lineageName ? readableLineageName(lineageName) : null) ?? `${index + 1}`;
  const hash = (face.hash >>> 0).toString(16).padStart(8, '0');
  return `${carrier} ${identity} · #${hash}`;
}

export function modelingFaceOptions(
  topology: BodyTopology | undefined
): ModelingFaceOption[] {
  return (topology?.faces ?? []).map((face, index) => ({
    hash: face.hash,
    topologyId: face.topologyId,
    label: topologyFaceLabel(face, index),
    surfaceType: face.geometry?.surfaceType,
    reference: face.reference,
    hasCentroid: face.geometry?.centroid !== undefined
  }));
}

export function modelingOperationDisabledReason(
  operation: ModelingOperationKind,
  capability: ModelingOperationCapability
): string | null {
  const profileOperation =
    operation === 'loft' ||
    operation === 'sweep' ||
    operation === 'helical-sweep';
  if (profileOperation) {
    if (operation === 'loft' && (capability.profileCount ?? 0) < 2) {
      return 'Create at least two closed sketch profiles';
    }
    if ((capability.profileCount ?? 0) < 1) {
      return 'Create a closed sketch profile';
    }
    if (operation === 'sweep' && (capability.pathCount ?? 0) < 1) {
      return 'Create a line or arc path sketch';
    }
    return null;
  }
  if (capability.exactState === 'pending') {
    return 'Waiting for exact geometry';
  }
  if (capability.exactState === 'failed') {
    return capability.exactFailureReason ?? 'Exact geometry is unavailable';
  }
  if (!capability.hasTargetBody) {
    return 'Select a live solid body';
  }
  if (operation === 'shell' && (capability.openingFaceCount ?? 0) === 0) {
    return 'Select at least one opening face';
  }
  if (operation === 'hole' && (capability.openingFaceCount ?? 0) === 0) {
    return 'The target body has no planar face to drill';
  }
  return null;
}

function allExpressionsValid(
  scope: Record<string, number>,
  values: readonly string[]
): boolean {
  return values.every((value) => previewExpression(value, scope).ok);
}

function resolvedExpression(
  scope: Record<string, number>,
  value: string
): number | null {
  return evalParamValue(coerceParamValue(value), scope);
}

function positiveExpression(
  scope: Record<string, number>,
  value: string
): boolean {
  const resolved = resolvedExpression(scope, value);
  return resolved !== null && resolved > 0;
}

function nonZeroExpression(
  scope: Record<string, number>,
  value: string
): boolean {
  const resolved = resolvedExpression(scope, value);
  return resolved !== null && resolved !== 0;
}

function nonZeroVector(
  scope: Record<string, number>,
  value: { x: string; y: string; z: string }
): boolean {
  const resolved = Object.values(value).map((component) =>
    resolvedExpression(scope, component)
  );
  return (
    resolved.every((component) => component !== null) &&
    Math.hypot(...resolved) > 1e-12
  );
}

export function modelingFormValidationReason(
  state: ModelingOperationFormState,
  scope: Record<string, number>
): string | null {
  if (state.value.name.trim().length === 0) return 'Name is required.';
  switch (state.operation) {
    case 'loft':
      return state.value.sectionIds.length >= 2 &&
        new Set(state.value.sectionIds).size === state.value.sectionIds.length
        ? null
        : 'Choose at least two unique profile sections.';
    case 'sweep':
      return state.value.profileId && state.value.pathId
        ? null
        : 'Choose a profile and a path.';
    case 'helical-sweep': {
      const expressions = [
        ...Object.values(state.value.axisOrigin),
        ...Object.values(state.value.axisDirection),
        state.value.radius,
        state.value.pitch,
        state.value.turns
      ];
      if (!state.value.profileId) return 'Choose a profile.';
      if (!allExpressionsValid(scope, expressions)) {
        return 'Helical sweep fields must be valid expressions.';
      }
      if (!nonZeroVector(scope, state.value.axisDirection)) {
        return 'Helical axis direction must be non-zero.';
      }
      return positiveExpression(scope, state.value.radius) &&
        nonZeroExpression(scope, state.value.pitch) &&
        positiveExpression(scope, state.value.turns) &&
        (resolvedExpression(scope, state.value.turns) ?? Infinity) <=
          MAX_HELICAL_SWEEP_TURNS
        ? null
        : `Radius and turns must be positive, turns must not exceed ${MAX_HELICAL_SWEEP_TURNS}, and pitch must be non-zero.`;
    }
    case 'mirror':
    case 'split': {
      const label = state.operation === 'mirror' ? 'Mirror' : 'Split';
      if (state.value.targetBodyId === '') return 'Select a target body.';
      const expressions = [
        ...Object.values(state.value.origin),
        ...Object.values(state.value.normal)
      ];
      if (!allExpressionsValid(scope, expressions)) {
        return `${label} plane fields must be valid expressions.`;
      }
      return nonZeroVector(scope, state.value.normal)
        ? null
        : `${label} plane normal must be non-zero.`;
    }
    case 'shell':
      if (state.value.targetBodyId === '') return 'Select a target body.';
      if (!positiveExpression(scope, state.value.thickness)) {
        return 'Shell thickness must resolve to a positive value.';
      }
      return state.value.openingFaceHashes.length > 0 &&
        new Set(state.value.openingFaceHashes).size ===
          state.value.openingFaceHashes.length
        ? null
        : 'Select at least one unique opening face.';
    case 'solid-offset':
      if (state.value.targetBodyId === '') return 'Select a target body.';
      return positiveExpression(scope, state.value.distance)
        ? null
        : 'Solid offset distance must resolve to a positive value.';
    case 'draft': {
      if (state.value.targetBodyId === '') return 'Select a target body.';
      if (state.value.faceHashes.length === 0) {
        return 'Select at least one draft face.';
      }
      const expressions = [
        ...Object.values(state.value.pullDirection),
        ...Object.values(state.value.neutralPoint),
        state.value.angleDeg
      ];
      if (!allExpressionsValid(scope, expressions)) {
        return 'Draft fields must be valid expressions.';
      }
      if (!nonZeroVector(scope, state.value.pullDirection)) {
        return 'Draft pull direction must be non-zero.';
      }
      return nonZeroExpression(scope, state.value.angleDeg)
        ? null
        : 'Draft angle must be non-zero.';
    }
    case 'hole': {
      if (state.value.targetBodyId === '') return 'Select a target body.';
      if (state.value.faceHash === null) return 'Select the entry face.';
      const expressions = [
        state.value.diameter,
        ...Object.values(state.value.position),
        ...(state.value.depthMode === 'blind' ? [state.value.depth] : []),
        ...(state.value.style === 'counterbore'
          ? [state.value.counterboreDiameter, state.value.counterboreDepth]
          : []),
        ...(state.value.style === 'countersink'
          ? [state.value.countersinkDiameter, state.value.countersinkAngleDeg]
          : [])
      ];
      if (!allExpressionsValid(scope, expressions)) {
        return 'Hole fields must be valid expressions.';
      }
      const diameter = resolvedExpression(scope, state.value.diameter);
      if (diameter === null || diameter <= 0) {
        return 'Hole diameter must resolve to a positive value.';
      }
      if (
        state.value.depthMode === 'blind' &&
        !positiveExpression(scope, state.value.depth)
      ) {
        return 'Blind hole depth must resolve to a positive value.';
      }
      if (state.value.style === 'counterbore') {
        const counterbore = resolvedExpression(
          scope,
          state.value.counterboreDiameter
        );
        if (counterbore === null || counterbore <= diameter) {
          return 'Counterbore diameter must be larger than the hole diameter.';
        }
        if (!positiveExpression(scope, state.value.counterboreDepth)) {
          return 'Counterbore depth must resolve to a positive value.';
        }
      }
      if (state.value.style === 'countersink') {
        const countersink = resolvedExpression(
          scope,
          state.value.countersinkDiameter
        );
        if (countersink === null || countersink <= diameter) {
          return 'Countersink diameter must be larger than the hole diameter.';
        }
        const angle = resolvedExpression(
          scope,
          state.value.countersinkAngleDeg
        );
        if (angle === null || angle <= 0 || angle >= 180) {
          return 'Countersink angle must be strictly between 0 and 180 degrees.';
        }
      }
      return null;
    }
    case 'thicken':
      if (state.value.targetBodyId === '') return 'Select a target body.';
      if (state.value.faceHash === null) return 'Select one face to thicken.';
      return nonZeroExpression(scope, state.value.thickness)
        ? null
        : 'Thicken distance must be non-zero.';
  }
}

function requireProfile(
  id: string,
  profiles: readonly ModelingProfileOption[]
): SketchSectionReference {
  const option = profiles.find((candidate) => candidate.id === id);
  if (!option) throw new Error('Selected profile is no longer available.');
  return option.section;
}

function requirePath(
  id: string,
  paths: readonly ModelingPathOption[]
): SketchPathReference {
  const option = paths.find((candidate) => candidate.id === id);
  if (!option) throw new Error('Selected path is no longer available.');
  return option.path;
}

function requireFaces(
  hashes: readonly number[],
  options: readonly ModelingFaceOption[]
): ModelingFaceOption[] {
  return hashes.map((hash) => {
    const matches = options.filter((face) => face.hash === hash);
    if (matches.length !== 1) {
      throw new Error(`Face hash ${hash} did not resolve uniquely.`);
    }
    return matches[0]!;
  });
}

export function buildModelingOperationSubmission(
  state: ModelingOperationFormState,
  faceOptions: readonly ModelingFaceOption[] = [],
  profileOptions: readonly ModelingProfileOption[] = [],
  pathOptions: readonly ModelingPathOption[] = []
): ModelingOperationSubmission {
  const name = state.value.name.trim();
  if (state.operation === 'loft') {
    return {
      operation: 'loft',
      input: {
        name,
        sections: state.value.sectionIds.map((id) =>
          requireProfile(id, profileOptions)
        ),
        mode: state.value.mode
      }
    };
  }
  if (state.operation === 'sweep') {
    return {
      operation: 'sweep',
      input: {
        name,
        profile: requireProfile(state.value.profileId, profileOptions),
        path: requirePath(state.value.pathId, pathOptions),
        mode: state.value.mode
      }
    };
  }
  if (state.operation === 'helical-sweep') {
    return {
      operation: 'helical-sweep',
      input: {
        name,
        profile: requireProfile(state.value.profileId, profileOptions),
        axisOrigin: {
          x: coerceParamValue(state.value.axisOrigin.x),
          y: coerceParamValue(state.value.axisOrigin.y),
          z: coerceParamValue(state.value.axisOrigin.z)
        },
        axisDirection: {
          x: coerceParamValue(state.value.axisDirection.x),
          y: coerceParamValue(state.value.axisDirection.y),
          z: coerceParamValue(state.value.axisDirection.z)
        },
        radius: coerceParamValue(state.value.radius),
        pitch: coerceParamValue(state.value.pitch),
        turns: coerceParamValue(state.value.turns)
      }
    };
  }
  const targetBodyId = state.value.targetBodyId;
  if (targetBodyId === '') throw new Error('A target body is required.');
  if (state.operation === 'mirror' || state.operation === 'split') {
    const plane = {
      origin: {
        x: coerceParamValue(state.value.origin.x),
        y: coerceParamValue(state.value.origin.y),
        z: coerceParamValue(state.value.origin.z)
      },
      normal: {
        x: coerceParamValue(state.value.normal.x),
        y: coerceParamValue(state.value.normal.y),
        z: coerceParamValue(state.value.normal.z)
      }
    };
    return state.operation === 'mirror'
      ? { operation: 'mirror', input: { name, targetBodyId, plane } }
      : { operation: 'split', input: { name, targetBodyId, plane } };
  }
  if (state.operation === 'shell') {
    const selected = requireFaces(state.value.openingFaceHashes, faceOptions);
    const references = selected.every((face) => face.reference)
      ? selected.map((face) => face.reference!)
      : undefined;
    return {
      operation: 'shell',
      input: {
        name,
        targetBodyId,
        openingFaceHashes: selected.map((face) => face.hash),
        ...(references ? { openingFaceReferences: references } : {}),
        thickness: coerceParamValue(state.value.thickness)
      }
    };
  }
  if (state.operation === 'solid-offset') {
    return {
      operation: 'solid-offset',
      input: {
        name,
        targetBodyId,
        distance: coerceParamValue(state.value.distance)
      }
    };
  }
  if (state.operation === 'draft') {
    const selected = requireFaces(state.value.faceHashes, faceOptions);
    const references = selected.every((face) => face.reference)
      ? selected.map((face) => face.reference!)
      : undefined;
    return {
      operation: 'draft',
      input: {
        name,
        targetBodyId,
        faceHashes: selected.map((face) => face.hash),
        ...(references ? { faceReferences: references } : {}),
        pullDirection: {
          x: coerceParamValue(state.value.pullDirection.x),
          y: coerceParamValue(state.value.pullDirection.y),
          z: coerceParamValue(state.value.pullDirection.z)
        },
        neutralPoint: {
          x: coerceParamValue(state.value.neutralPoint.x),
          y: coerceParamValue(state.value.neutralPoint.y),
          z: coerceParamValue(state.value.neutralPoint.z)
        },
        angleDeg: coerceParamValue(state.value.angleDeg)
      }
    };
  }
  if (state.operation === 'hole') {
    const [entry] = requireFaces([state.value.faceHash!], faceOptions);
    return {
      operation: 'hole',
      input: {
        name,
        targetBodyId,
        faceHash: entry!.hash,
        ...(entry!.reference ? { faceReference: entry!.reference } : {}),
        style: state.value.style,
        diameter: coerceParamValue(state.value.diameter),
        depthMode: state.value.depthMode,
        ...(state.value.depthMode === 'blind'
          ? { depth: coerceParamValue(state.value.depth) }
          : {}),
        ...(state.value.style === 'counterbore'
          ? {
              counterboreDiameter: coerceParamValue(
                state.value.counterboreDiameter
              ),
              counterboreDepth: coerceParamValue(state.value.counterboreDepth)
            }
          : {}),
        ...(state.value.style === 'countersink'
          ? {
              countersinkDiameter: coerceParamValue(
                state.value.countersinkDiameter
              ),
              countersinkAngleDeg: coerceParamValue(
                state.value.countersinkAngleDeg
              )
            }
          : {}),
        position: {
          u: coerceParamValue(state.value.position.u),
          v: coerceParamValue(state.value.position.v)
        },
        // (0, 0) means the middle of the face, which is its area centroid and
        // not the vertex mean the rebuild anchored on before this marker
        // existed. A face whose boundary could not be walked reports no
        // centroid and keeps the old anchor, which the absent marker then
        // tells the rebuild to reuse.
        ...(entry!.hasCentroid ? { positionAnchor: 'centroid' as const } : {})
      }
    };
  }
  const [selected] = requireFaces([state.value.faceHash!], faceOptions);
  return {
    operation: 'thicken',
    input: {
      name,
      targetBodyId,
      faceHash: selected!.hash,
      ...(selected!.reference ? { faceReference: selected!.reference } : {}),
      thickness: coerceParamValue(state.value.thickness)
    }
  };
}
