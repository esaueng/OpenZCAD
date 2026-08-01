import {
  coerceParamValue,
  type MirrorInput,
  type ShellInput,
  type SolidOffsetInput
} from '@openzcad/document-core';
import type {
  BodyId,
  BodyTopology,
  FaceTopologyReferenceV5
} from '@openzcad/shared';
import { evalParamValue, previewExpression } from './model';

export type ModelingOperationKind = 'mirror' | 'shell' | 'solid-offset';

export type ExactPreflightState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ready' }
  | { status: 'refused'; reason: string };

export type ExactPreflightResult =
  { status: 'ready' } | { status: 'refused'; reason: string };

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

export type ModelingOperationFormState =
  | { operation: 'mirror'; value: MirrorFormState }
  | { operation: 'shell'; value: ShellFormState }
  | { operation: 'solid-offset'; value: SolidOffsetFormState };

export type ModelingOperationSubmission =
  | { operation: 'mirror'; input: MirrorInput }
  | { operation: 'shell'; input: ShellInput }
  | { operation: 'solid-offset'; input: SolidOffsetInput };

export interface ModelingFaceOption {
  hash: number;
  topologyId: string;
  label: string;
  surfaceType?: string;
  reference?: FaceTopologyReferenceV5;
}

export type ExactKernelKind = 'brepkit' | 'occt';

export interface ModelingOperationCapability {
  exactState: 'ready' | 'pending' | 'failed';
  exactFailureReason?: string;
  hasTargetBody: boolean;
  openingFaceCount?: number;
  kernel?: ExactKernelKind;
  offsetTopology?: 'proven-convex-planar' | 'curved' | 'non-convex' | 'unknown';
}

export const OCCT_SHARP_OFFSET_LIMITATION =
  'OpenCascade sharp solid offset supports only proven convex planar bodies; curved, non-convex, or unproven topology is refused because the pinned kernel bridge otherwise creates rounded joins.';

function titleCase(value: string): string {
  return value.length === 0
    ? 'Unknown'
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/**
 * Lineage names worth showing a user are the SEMANTIC ones. A box face is
 * called `primitive.box.face.x.min` because the command said so, and "box ·
 * face · x · min" reads as what it is.
 *
 * Imported topology is named `import.step.face.<fingerprint>` (K0.6): an
 * import has no feature contract, so the fingerprint IS the name. Spelling
 * that out would print the hash twice in a label that already ends in
 * `· #hash`, so it is deliberately not a readable identity and the caller
 * falls back to the position, exactly as it did before imports were named.
 */
function readableLineageName(value: string): string | null {
  if (value.startsWith('import.step.')) {
    return null;
  }
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
    reference: face.reference
  }));
}

export function modelingOperationDisabledReason(
  operation: ModelingOperationKind,
  capability: ModelingOperationCapability
): string | null {
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
  if (
    operation === 'solid-offset' &&
    capability.kernel === 'occt' &&
    capability.offsetTopology !== 'proven-convex-planar'
  ) {
    return OCCT_SHARP_OFFSET_LIMITATION;
  }
  return null;
}

function allExpressionsValid(
  scope: Record<string, number>,
  values: readonly string[]
): boolean {
  return values.every((value) => previewExpression(value, scope).ok);
}

function positiveExpression(
  scope: Record<string, number>,
  value: string
): boolean {
  const paramValue = coerceParamValue(value);
  const resolved = evalParamValue(paramValue, scope);
  return resolved !== null && resolved > 0;
}

export function modelingFormValidationReason(
  state: ModelingOperationFormState,
  scope: Record<string, number>
): string | null {
  const { value } = state;
  if (value.name.trim().length === 0) {
    return 'Name is required.';
  }
  if (value.targetBodyId === '') {
    return 'Select a target body.';
  }
  if (state.operation === 'mirror') {
    const expressions = [
      ...Object.values(state.value.origin),
      ...Object.values(state.value.normal)
    ];
    if (!allExpressionsValid(scope, expressions)) {
      return 'Mirror plane fields must be valid expressions.';
    }
    const normal = Object.values(state.value.normal).map((component) =>
      evalParamValue(coerceParamValue(component), scope)
    );
    if (
      normal.some((component) => component === null) ||
      Math.hypot(...(normal as number[])) <= 1e-12
    ) {
      return 'Mirror plane normal must be non-zero.';
    }
    return null;
  }
  if (state.operation === 'shell') {
    if (!positiveExpression(scope, state.value.thickness)) {
      return 'Shell thickness must resolve to a positive value.';
    }
    if (
      state.value.openingFaceHashes.length === 0 ||
      new Set(state.value.openingFaceHashes).size !==
        state.value.openingFaceHashes.length
    ) {
      return 'Select at least one unique opening face.';
    }
    return null;
  }
  return positiveExpression(scope, state.value.distance)
    ? null
    : 'Solid offset distance must resolve to a positive value.';
}

export function buildModelingOperationSubmission(
  state: ModelingOperationFormState,
  faceOptions: readonly ModelingFaceOption[] = []
): ModelingOperationSubmission {
  const targetBodyId = state.value.targetBodyId;
  if (targetBodyId === '') {
    throw new Error('A target body is required.');
  }
  if (state.operation === 'mirror') {
    const { value } = state;
    return {
      operation: 'mirror',
      input: {
        name: value.name.trim(),
        targetBodyId,
        plane: {
          origin: {
            x: coerceParamValue(value.origin.x),
            y: coerceParamValue(value.origin.y),
            z: coerceParamValue(value.origin.z)
          },
          normal: {
            x: coerceParamValue(value.normal.x),
            y: coerceParamValue(value.normal.y),
            z: coerceParamValue(value.normal.z)
          }
        }
      }
    };
  }
  if (state.operation === 'shell') {
    const { value } = state;
    const selected = value.openingFaceHashes.map((hash) => {
      const matches = faceOptions.filter((face) => face.hash === hash);
      if (matches.length !== 1) {
        throw new Error(`Opening face hash ${hash} did not resolve uniquely.`);
      }
      return matches[0]!;
    });
    const references = selected.every((face) => face.reference)
      ? selected.map((face) => face.reference!)
      : undefined;
    return {
      operation: 'shell',
      input: {
        name: value.name.trim(),
        targetBodyId,
        openingFaceHashes: selected.map((face) => face.hash),
        ...(references ? { openingFaceReferences: references } : {}),
        thickness: coerceParamValue(value.thickness)
      }
    };
  }
  const { value } = state;
  return {
    operation: 'solid-offset',
    input: {
      name: value.name.trim(),
      targetBodyId,
      distance: coerceParamValue(value.distance)
    }
  };
}
