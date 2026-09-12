import {
  coerceParamValue,
  type DraftInput,
  type FeatureUpdateInput,
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
  type BodyRepresentation,
  type BodyTopology,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type FeatureKind,
  type FeatureNode,
  type ParamValue,
  type SketchPathReference,
  type SketchSectionReference
} from '@openzcad/shared';
import { evalParamValue, previewExpression } from './model';
import { faceLabel } from './topologyLabels';

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

/** The feature kinds whose creation form can reopen an existing feature. */
export type EditableModelingKind = ModelingOperationKind;

const EDITABLE_MODELING_KINDS: readonly FeatureKind[] = [
  'hole',
  'mirror',
  'split',
  'shell',
  'solid-offset',
  'draft',
  'thicken',
  'loft',
  'sweep',
  'helical-sweep'
];

export function modelingFeatureIsEditable(
  kind: FeatureKind
): kind is EditableModelingKind {
  return EDITABLE_MODELING_KINDS.includes(kind);
}

export type EditableModelingFeatureData = Extract<
  FeatureNode['data'],
  { featureKind: EditableModelingKind }
>;

const text = (value: ParamValue | undefined, fallback: string): string =>
  value === undefined ? fallback : String(value);

const vectorText = (value: {
  x: ParamValue;
  y: ParamValue;
  z: ParamValue;
}): { x: string; y: string; z: string } => ({
  x: String(value.x),
  y: String(value.y),
  z: String(value.z)
});

function sameEntitySet(a: readonly string[], b: readonly string[]): boolean {
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return (
    sortedA.length === sortedB.length &&
    sortedA.every((id, index) => id === sortedB[index])
  );
}

function resolveProfileOption(
  section: SketchSectionReference,
  options: readonly ModelingProfileOption[]
): ModelingProfileOption {
  const reference = section.profile;
  if (reference.all === true) {
    throw new Error(
      'Entity-wide profiles cannot be edited as a single section.'
    );
  }
  const candidates = options.filter(
    (option) =>
      option.section.sketchId === section.sketchId &&
      option.section.profile.all !== true
  );
  // A present but ambiguous identity must never fall through to another tier.
  const identities = candidates.filter(
    ({ section: { profile } }) =>
      profile.all !== true &&
      (reference.profileId
        ? profile.profileId === reference.profileId
        : profile.regionFingerprint === reference.regionFingerprint &&
          profile.sourceArea === reference.sourceArea &&
          profile.samplePoint.x === reference.samplePoint.x &&
          profile.samplePoint.y === reference.samplePoint.y &&
          (!reference.sourceEntityIds?.length ||
            sameEntitySet(
              reference.sourceEntityIds,
              profile.sourceEntityIds ?? []
            )))
  );
  if (identities.length === 1) return identities[0]!;
  if (identities.length === 0 && reference.sourceEntityIds?.length) {
    // Coordinates and profile ids change when a sketch dimension changes.
    // Only a unique authored entity set can recover that selection here;
    // never guess by nearest point, area, or the first dropdown option.
    const entities = candidates.filter(({ section: { profile } }) =>
      sameEntitySet(reference.sourceEntityIds!, profile.sourceEntityIds ?? [])
    );
    if (entities.length === 1) return entities[0]!;
  }
  throw new Error(
    'Saved profile no longer resolves uniquely in its sketch. Repair the sketch before editing this feature.'
  );
}

function resolvePathOption(
  path: SketchPathReference,
  options: readonly ModelingPathOption[]
): ModelingPathOption {
  const matches = options.filter(
    (option) =>
      option.path.sketchId === path.sketchId &&
      path.entityIds.length > 0 &&
      new Set(path.entityIds).size === path.entityIds.length &&
      path.entityIds.every(
        (id) =>
          option.path.entityIds.filter((candidate) => candidate === id)
            .length === 1
      )
  );
  if (matches.length !== 1)
    throw new Error(
      'Saved path entities no longer resolve uniquely in their sketch. Repair the path before editing this feature.'
    );
  return matches[0]!;
}

/** Bind the form to live identities while retaining the authored references.
 * A sweep may use only a subset of a sketch, in a different order. Keeping
 * that path in its selected option prevents a no-op edit from widening it.
 */
export function modelingFeatureEditReferences(
  data: EditableModelingFeatureData,
  profiles: readonly ModelingProfileOption[],
  paths: readonly ModelingPathOption[]
): { profiles: ModelingProfileOption[]; paths: ModelingPathOption[] } {
  const sections =
    data.featureKind === 'loft'
      ? data.sections
      : data.featureKind === 'sweep' || data.featureKind === 'helical-sweep'
        ? [data.profile]
        : [];
  const savedSections = new Map<string, SketchSectionReference>();
  for (const section of sections) {
    const option = resolveProfileOption(section, profiles);
    if (savedSections.has(option.id))
      throw new Error(
        'Saved loft sections resolve to the same profile. Repair the sections before editing.'
      );
    savedSections.set(option.id, section);
  }
  const path =
    data.featureKind === 'sweep' ? resolvePathOption(data.path, paths) : null;
  return {
    profiles: profiles.map((option) => ({
      ...option,
      section: savedSections.get(option.id) ?? option.section
    })),
    paths: paths.map((option) =>
      data.featureKind === 'sweep' && option.id === path?.id
        ? { ...option, path: data.path }
        : option
    )
  };
}

/**
 * Editing a modeling feature reuses its creation form. The stored data is
 * lifted back into the form's string fields here (expressions as written);
 * the reverse trip happens through the same submission the creation path
 * builds, then {@link modelingFeatureUpdate} turns it into an
 * `updateFeature` patch. Profile selections must resolve uniquely against
 * the current sketch options before the form opens.
 */
export function modelingFormStateFromFeature(
  name: string,
  data: EditableModelingFeatureData,
  profiles: readonly ModelingProfileOption[] = [],
  paths: readonly ModelingPathOption[] = []
): ModelingOperationFormState {
  switch (data.featureKind) {
    case 'loft':
      return {
        operation: 'loft',
        value: {
          name,
          sectionIds: data.sections.map(
            (section) => resolveProfileOption(section, profiles).id
          ),
          mode: data.mode
        }
      };
    case 'sweep':
      return {
        operation: 'sweep',
        value: {
          name,
          profileId: resolveProfileOption(data.profile, profiles).id,
          pathId: resolvePathOption(data.path, paths).id,
          mode: data.mode
        }
      };
    case 'helical-sweep':
      return {
        operation: 'helical-sweep',
        value: {
          name,
          profileId: resolveProfileOption(data.profile, profiles).id,
          axisOrigin: vectorText(data.axisOrigin),
          axisDirection: vectorText(data.axisDirection),
          radius: String(data.radius),
          pitch: String(data.pitch),
          turns: String(data.turns)
        }
      };
    case 'hole':
      return {
        operation: 'hole',
        value: {
          name,
          targetBodyId: data.targetBodyId,
          faceHash: data.faceHash,
          style: data.style,
          diameter: text(data.diameter, '6'),
          depthMode: data.depthMode,
          depth: text(data.depth, '10'),
          counterboreDiameter: text(data.counterboreDiameter, '11'),
          counterboreDepth: text(data.counterboreDepth, '3'),
          countersinkDiameter: text(data.countersinkDiameter, '12'),
          countersinkAngleDeg: text(data.countersinkAngleDeg, '90'),
          position: {
            u: text(data.position.u, '0'),
            v: text(data.position.v, '0')
          }
        }
      };
    case 'mirror':
    case 'split':
      return {
        operation: data.featureKind,
        value: {
          name,
          targetBodyId: data.targetBodyId,
          origin: vectorText(data.plane.origin),
          normal: vectorText(data.plane.normal)
        }
      };
    case 'shell':
      return {
        operation: 'shell',
        value: {
          name,
          targetBodyId: data.targetBodyId,
          thickness: text(data.thickness, '2'),
          openingFaceHashes: [...data.openingFaceHashes]
        }
      };
    case 'solid-offset':
      return {
        operation: 'solid-offset',
        value: {
          name,
          targetBodyId: data.targetBodyId,
          distance: text(data.distance, '1')
        }
      };
    case 'draft':
      return {
        operation: 'draft',
        value: {
          name,
          targetBodyId: data.targetBodyId,
          faceHashes: [...data.faceHashes],
          pullDirection: vectorText(data.pullDirection),
          neutralPoint: vectorText(data.neutralPoint),
          angleDeg: text(data.angleDeg, '3')
        }
      };
    case 'thicken':
      return {
        operation: 'thicken',
        value: {
          name,
          targetBodyId: data.targetBodyId,
          faceHash: data.faceHash,
          thickness: text(data.thickness, '2')
        }
      };
  }
}

/**
 * The `updateFeature` payload for a submission made while editing. The
 * data keys are exactly what each creation command stores (the builders
 * spread the input minus name and ids), so a round trip through the form
 * leaves an untouched feature unchanged. `positionAnchor` is left out of a
 * hole: it is not a patchable key, and re-anchoring would move the hole.
 */
export function modelingFeatureUpdate(
  featureId: FeatureId,
  submission: ModelingOperationSubmission
): FeatureUpdateInput | null {
  switch (submission.operation) {
    case 'loft': {
      const { name, sections, mode } = submission.input;
      return { featureId, name, data: { featureKind: 'loft', sections, mode } };
    }
    case 'sweep': {
      const { name, profile, path, mode } = submission.input;
      return {
        featureId,
        name,
        data: { featureKind: 'sweep', profile, path, mode }
      };
    }
    case 'helical-sweep': {
      const { name, profile, axisOrigin, axisDirection, radius, pitch, turns } =
        submission.input;
      return {
        featureId,
        name,
        data: {
          featureKind: 'helical-sweep',
          profile,
          axisOrigin,
          axisDirection,
          radius,
          pitch,
          turns
        }
      };
    }

    case 'hole': {
      const {
        name,
        ids: _ids,
        positionAnchor: _anchor,
        ...parameters
      } = submission.input;
      return {
        featureId,
        name,
        data: { featureKind: 'hole', ...parameters }
      };
    }
    case 'mirror':
    case 'split':
    case 'shell':
    case 'solid-offset':
    case 'draft':
    case 'thicken': {
      const { name, ids: _ids, ...parameters } = submission.input;
      return {
        featureId,
        name,
        data: { featureKind: submission.operation, ...parameters }
      };
    }
    default:
      return null;
  }
}

export interface ModelingFaceOption {
  hash: number;
  topologyId: string;
  /** What the viewport calls the face: "Top face", "Through hole ⌀6". */
  label: string;
  /** The carrier, lineage and fingerprint, for a tooltip. */
  detail?: string;
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

/**
 * The faces a form can pick from, named the way the viewport names them.
 *
 * The list used to read "Plane face modifier · box · face · z max · #f5741e9d"
 * while the hover label on the same face said "Top face" — the one name the
 * user could match up was the one the list did not show. With a body to
 * resolve against, the viewport's name leads and the lineage moves to the
 * tooltip; two faces that share a name get an ordinal so they stay apart.
 */
export function modelingFaceOptions(
  topology: BodyTopology | undefined,
  body?: BodyRepresentation
): ModelingFaceOption[] {
  const faces = topology?.faces ?? [];
  const names = body
    ? faces.map((face) => faceLabel(body, face.hash, face.topologyId))
    : null;
  const counts = new Map<string, number>();
  for (const name of names ?? []) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return faces.map((face, index) => {
    const detail = topologyFaceLabel(face, index);
    let label = detail;
    if (names) {
      const name = names[index]!;
      if ((counts.get(name) ?? 0) > 1) {
        const ordinal = (seen.get(name) ?? 0) + 1;
        seen.set(name, ordinal);
        label = `${name} (${ordinal})`;
      } else {
        label = name;
      }
    }
    return {
      hash: face.hash,
      topologyId: face.topologyId,
      label,
      ...(names ? { detail } : {}),
      surfaceType: face.geometry?.surfaceType,
      reference: face.reference,
      hasCentroid: face.geometry?.centroid !== undefined
    };
  });
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

/**
 * Why the form cannot be checked yet. `missing` means the user has not
 * chosen something (a body, a face, a profile) and reads as a next step;
 * `invalid` means a value they typed does not resolve and reads as an error.
 */
export interface ModelingFormValidation {
  kind: 'missing' | 'invalid';
  reason: string;
}

const MISSING_INPUT_PATTERN = /^(Select|Choose|Click|Name is required)/;

export function modelingFormValidation(
  state: ModelingOperationFormState,
  scope: Record<string, number>
): ModelingFormValidation | null {
  const reason = modelingFormValidationReason(state, scope);
  if (reason === null) return null;
  return {
    kind: MISSING_INPUT_PATTERN.test(reason) ? 'missing' : 'invalid',
    reason
  };
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
      if (state.value.openingFaceHashes.length === 0) {
        return 'Click the faces to open in the viewport, or select them in the list.';
      }
      return new Set(state.value.openingFaceHashes).size ===
        state.value.openingFaceHashes.length
        ? null
        : 'Opening faces must be unique.';
    case 'solid-offset':
      if (state.value.targetBodyId === '') return 'Select a target body.';
      return positiveExpression(scope, state.value.distance)
        ? null
        : 'Solid offset distance must resolve to a positive value.';
    case 'draft': {
      if (state.value.targetBodyId === '') return 'Select a target body.';
      if (state.value.faceHashes.length === 0) {
        return 'Click the flat faces to draft in the viewport, or select them in the list.';
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
      if (state.value.faceHash === null) {
        return 'Click a flat face in the viewport to drill, or select it in the list.';
      }
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
      if (state.value.faceHash === null) {
        return 'Click the face to thicken in the viewport, or select it in the list.';
      }
      return nonZeroExpression(scope, state.value.thickness)
        ? null
        : 'Thicken distance must be non-zero.';
  }
}

function requireProfile(
  id: string,
  profiles: readonly ModelingProfileOption[]
): SketchSectionReference {
  const matches = profiles.filter((candidate) => candidate.id === id);
  if (matches.length !== 1)
    throw new Error('Selected profile no longer resolves uniquely.');
  return matches[0]!.section;
}

function requirePath(
  id: string,
  paths: readonly ModelingPathOption[]
): SketchPathReference {
  const matches = paths.filter((candidate) => candidate.id === id);
  if (matches.length !== 1)
    throw new Error('Selected path no longer resolves uniquely.');
  return matches[0]!.path;
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
