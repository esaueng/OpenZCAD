/**
 * M14 gear features: a new spur, helical, herringbone or straight bevel gear
 * body from the kernel's gear generator, or teeth cut along the whole length
 * of a body's cylindrical face.
 *
 * The kernel owns the gear: the involute, its certified flank fit, the
 * tooth-form checks and the boolean that cuts teeth into a body. This module
 * turns the feature's stored parameters into the kernel's spec, maps the
 * kernel's typed refusals onto {@link KernelRefusal}, surfaces its guideline
 * warnings as advisories, and names every gear face from the kernel's own
 * construction roles.
 */
import {
  UNIT_TO_MM,
  type FeatureId,
  type FeatureNode,
  type ParamValue,
  type ParametricVector3,
  type UnitSystem
} from '@openzcad/shared';
import { resolveParamValue } from '@openzcad/document-core';

import { collapseShape } from './exact-boolean-helpers';
import type { FeatureBuildContext, FeatureDataOf } from './exact-build-loop';
import { raiseFeatureWarning } from './exact-feature-warnings';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import { measureFaceGeometry } from './exact-measure';
import { resolveFeatureFaces } from './exact-reference-resolution';
import { inheritMeshOrigin, validateGeneratedSolid } from './exact-shape-utils';
import type { ExactShape } from './exact-types';
import { KernelRefusal } from './kernel-refusal';
import {
  createRemusSemanticLineage,
  deriveRemusBooleanCarrierLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusSemanticAssignment
} from './remus-lineage';
import type {
  RemusKernel,
  SolidOperationDetailedResult
} from './remus-runtime';

/**
 * The gear entry points, typed here until the pinned kernel's declarations
 * carry them; the runtime check refuses by name on a kernel without them.
 */
interface GearKernel {
  makeGearDetailed(spec: string): SolidOperationDetailedResult;
  cutGearTeethDetailed(
    solid: number,
    face: number,
    spec: string
  ): SolidOperationDetailedResult;
}

/** The bevel gear entry point, on kernels from the bevel release on. */
interface BevelGearKernel {
  makeBevelGearDetailed(spec: string): SolidOperationDetailedResult;
}

function bevelGearKernel(kernel: RemusKernel): BevelGearKernel {
  const candidate = kernel as unknown as Partial<BevelGearKernel>;
  if (typeof candidate.makeBevelGearDetailed !== 'function') {
    throw new Error('This kernel build has no bevel gear generator.');
  }
  return candidate as BevelGearKernel;
}

function gearKernel(kernel: RemusKernel): GearKernel {
  const candidate = kernel as unknown as Partial<GearKernel>;
  if (
    typeof candidate.makeGearDetailed !== 'function' ||
    typeof candidate.cutGearTeethDetailed !== 'function'
  ) {
    throw new Error('This kernel build has no gear generator.');
  }
  return candidate as GearKernel;
}

/** Product copy per kernel refusal code; the kernel's sentence follows it. */
const GEAR_REFUSALS: Readonly<Record<string, string>> = {
  'gear:pointed-tip':
    'The teeth come to a point before the tip circle. Use more teeth, a smaller profile shift or less backlash.',
  'gear:root-land-closed':
    'Neighbouring teeth meet at the root. Reduce the root fillet, the dedendum or the backlash.',
  'gear:flank-too-short':
    'The root fillet reaches the tip, leaving no flank. Reduce the root fillet or the dedendum.',
  'gear:tip-below-base-circle':
    'The tip circle lies inside the base circle, so the teeth have no involute. Use a smaller negative profile shift.',
  'gear:bore-too-large': 'The bore is too large for these teeth.',
  'gear:rim-too-small': 'The rim does not enclose the tooth roots.',
  'gear:tolerance-too-tight':
    'The flank tolerance is tighter than the gear generator resolves.',
  'gear:not-a-cylinder': 'Gear teeth need a cylindrical face.',
  'gear:not-a-boss-or-bore':
    'The picked cylinder is neither a boss nor a bore.',
  'gear:partial-span-unsupported':
    'Gear teeth must span the whole cylindrical face.',
  'gear:cylinder-too-small':
    'The gear is larger than the picked cylinder. Use a smaller module or fewer teeth, or keep the cylinder’s diameter.',
  'gear:features-in-tooth-region':
    'A hole, slot or other feature crosses the band the teeth would occupy.',
  'gear:invalid-parameter': 'A gear parameter is out of range.'
};

interface GearOkDetails {
  readonly geometry?: { readonly module?: number };
  readonly warnings?: readonly {
    readonly code: string;
    readonly minProfileShift?: number;
    readonly thickness?: number;
  }[];
  readonly faceRoles?: readonly {
    readonly face: number;
    readonly role: string;
  }[];
}

/** The success envelope's solid and details, or the refusal as a throw. */
function unwrap(
  envelope: SolidOperationDetailedResult,
  label: string
): { solid: number; details: GearOkDetails } {
  if (envelope.status === 'ok') {
    return {
      solid: envelope.value,
      details: envelope.details
    };
  }
  const kernelMessage =
    typeof envelope.details?.message === 'string'
      ? envelope.details.message
      : envelope.code;
  const reason = GEAR_REFUSALS[envelope.code] ?? kernelMessage;
  throw new KernelRefusal({
    family: 'gear',
    category: envelope.category,
    kernelCode: envelope.code,
    kernelMessage,
    reason,
    message: `${label}: ${reason}\n${kernelMessage}`
  });
}

/** Six significant digits, without exponent noise for ordinary sizes. */
function formatted(value: number): string {
  return String(Number(value.toPrecision(6)));
}

function raiseGearWarnings(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  details: GearOkDetails
): void {
  for (const warning of details.warnings ?? []) {
    const message =
      warning.code === 'undercut'
        ? `A generating cutter would undercut these teeth; a profile shift of at least ${formatted(warning.minProfileShift ?? 0)} avoids it. The root is modelled as a fillet, not the undercut.`
        : warning.code === 'thin-tip'
          ? `The tooth tips are thin (${formatted(warning.thickness ?? 0)} wide).`
          : warning.code === 'thin-rim'
            ? `The rim under the teeth is thin (${formatted(warning.thickness ?? 0)}).`
            : `Gear guideline: ${warning.code}.`;
    raiseFeatureWarning(ctx.result, feature, message, 'advisory');
  }
}

/** One lineage name per kernel face role, e.g. `gear.face.tooth[3].tip`. */
function gearRoleLineage(
  kernel: RemusKernel,
  solid: number,
  featureId: FeatureId,
  details: GearOkDetails
): RemusLineageState {
  const candidates = new Map(
    topologyCandidatesForSolid(kernel, solid)
      .filter((candidate) => candidate.kind === 'face')
      .map((candidate) => [candidate.handle, candidate] as const)
  );
  const assignments: RemusSemanticAssignment[] = [];
  for (const { face, role } of details.faceRoles ?? []) {
    const candidate = candidates.get(face);
    if (candidate) {
      assignments.push({ ...candidate, lineageName: `gear.face.${role}` });
    }
  }
  return createRemusSemanticLineage(featureId, 'primitive', assignments);
}

/**
 * The module in document units. A diametral pitch counts teeth per inch of
 * pitch diameter in every unit system, so its module is one inch over it.
 */
export function gearModule(
  sizing: FeatureDataOf<'gear'>['sizing'],
  pitch: number,
  units: UnitSystem
): number {
  switch (sizing) {
    case 'module':
      return pitch;
    case 'circular-pitch':
      return pitch / Math.PI;
    case 'diametral-pitch':
      return UNIT_TO_MM.inch / UNIT_TO_MM[units] / pitch;
  }
}

/** A deterministic reference direction perpendicular to `axis`. */
export function defaultGearXDirection(axis: {
  x: number;
  y: number;
  z: number;
}): { x: number; y: number; z: number } {
  const length = Math.hypot(axis.x, axis.y, axis.z);
  const unit = { x: axis.x / length, y: axis.y / length, z: axis.z / length };
  // World +X unless the axis lies along it, then world +Y.
  const reference =
    Math.abs(unit.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const along =
    reference.x * unit.x + reference.y * unit.y + reference.z * unit.z;
  const projected = {
    x: reference.x - unit.x * along,
    y: reference.y - unit.y * along,
    z: reference.z - unit.z * along
  };
  const size = Math.hypot(projected.x, projected.y, projected.z);
  return {
    x: projected.x / size,
    y: projected.y / size,
    z: projected.z / size
  };
}

/** Resolves a feature's expressions in document units. */
interface GearValues {
  resolve(value: ParamValue, label: string): number;
  optional(value: ParamValue | undefined, label: string): number | undefined;
  vector(value: ParametricVector3, label: string): [number, number, number];
}

export function buildGearFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'gear'>
): void {
  if (!feature.bodyId) {
    throw new Error('Gear has no result body.');
  }
  const { scope, document } = ctx;
  const values: GearValues = {
    resolve: (value, label) =>
      resolveParamValue(value, scope, `gear ${label}`, document.units),
    optional: (value, label) =>
      value === undefined ? undefined : values.resolve(value, label),
    vector: (value, label) => [
      values.resolve(value.x, `${label} X`),
      values.resolve(value.y, `${label} Y`),
      values.resolve(value.z, `${label} Z`)
    ]
  };
  // The kernel spec's tooth-form fields; absent ones take its defaults.
  const toothForm: Record<string, number> = {
    teeth: Math.round(values.resolve(data.teeth, 'teeth')),
    ...withNumber(
      'pressureAngle',
      values.optional(data.pressureAngleDeg, 'pressure angle')
    ),
    ...withNumber(
      'profileShift',
      values.optional(data.profileShift, 'profile shift')
    ),
    ...withNumber('backlash', values.optional(data.backlash, 'backlash')),
    ...withNumber('addendum', values.optional(data.addendum, 'addendum')),
    ...withNumber('dedendum', values.optional(data.dedendum, 'dedendum')),
    ...withNumber(
      'rootFillet',
      values.optional(data.rootFillet, 'root fillet')
    ),
    ...withNumber('phase', values.optional(data.phaseDeg, 'phase'))
  };
  // A spur gear sends no helix fields, so it builds on any gear kernel; a
  // kernel without helical gears refuses the unknown field instead of
  // building a spur in its place.
  const helix = values.optional(data.helixAngleDeg, 'helix angle') ?? 0;
  const helical: Record<string, number | string | boolean> =
    helix === 0
      ? {}
      : {
          helixAngle: helix,
          hand: data.hand ?? 'right',
          // Sent only when set, so a helical gear builds on a kernel without
          // herringbone gears, which refuses the unknown field instead.
          ...(data.herringbone ? { herringbone: true } : {})
        };
  const module =
    data.pitch === undefined
      ? undefined
      : gearModule(
          data.sizing,
          values.resolve(data.pitch, 'pitch'),
          document.units
        );
  if (data.gearType === 'bevel') {
    buildBevelGearBody(ctx, feature, data, toothForm, module, values);
  } else if (data.targetBodyId === undefined) {
    buildNewGearBody(ctx, feature, data, toothForm, helical, module, values);
  } else {
    buildGearTeethOnBody(
      ctx,
      feature,
      data,
      toothForm,
      helical,
      module,
      values
    );
  }
}

/** `{ [key]: value }` when the value is present, `{}` otherwise. */
function withNumber(
  key: string,
  value: number | undefined
): Record<string, number> {
  return value === undefined ? {} : { [key]: value };
}

/** The first cap's x direction: as stored, else perpendicular to the axis. */
function gearXDirection(
  data: FeatureDataOf<'gear'>,
  axis: [number, number, number],
  values: GearValues
): [number, number, number] {
  if (data.xDirection) {
    return values.vector(data.xDirection, 'x direction');
  }
  const direction = defaultGearXDirection({
    x: axis[0],
    y: axis[1],
    z: axis[2]
  });
  return [direction.x, direction.y, direction.z];
}

/**
 * A straight bevel gear: its heel cap on `origin`, tapering along `axis`
 * toward the pitch cone's apex. The bevel spec has no profile shift or root
 * fillet; the command validation refuses those on a bevel gear.
 */
function buildBevelGearBody(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'gear'>,
  toothForm: Record<string, number>,
  module: number | undefined,
  values: GearValues
): void {
  const { kernel, result } = ctx;
  if (module === undefined || data.mateTeeth === undefined) {
    throw new Error('A bevel gear needs a pitch and its mate’s tooth count.');
  }
  if (data.faceWidth === undefined || !data.origin || !data.axis) {
    throw new Error('A new gear needs a face width, an origin and an axis.');
  }
  const { profileShift: _shift, rootFillet: _fillet, ...bevelForm } = toothForm;
  const axis = values.vector(data.axis, 'axis');
  const spec = {
    module,
    mateTeeth: Math.round(values.resolve(data.mateTeeth, 'mate teeth')),
    faceWidth: values.resolve(data.faceWidth, 'face width'),
    ...bevelForm,
    ...withNumber(
      'shaftAngle',
      values.optional(data.shaftAngleDeg, 'shaft angle')
    ),
    origin: values.vector(data.origin, 'origin'),
    axis,
    xDirection: gearXDirection(data, axis, values),
    ...withNumber(
      'boreDiameter',
      values.optional(data.boreDiameter, 'bore diameter')
    )
  };
  const { solid, details } = unwrap(
    bevelGearKernel(kernel).makeBevelGearDetailed(JSON.stringify(spec)),
    'Bevel gear'
  );
  validateGeneratedSolid(kernel, solid, 'Bevel gear');
  raiseGearWarnings(ctx, feature, details);
  result.shapes.set(feature.bodyId!, {
    solids: [solid],
    lineage: gearRoleLineage(kernel, solid, feature.featureId, details)
  });
}

function buildNewGearBody(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'gear'>,
  toothForm: Record<string, number>,
  helical: Record<string, number | string | boolean>,
  module: number | undefined,
  values: GearValues
): void {
  const { kernel, result } = ctx;
  if (module === undefined) {
    throw new Error('A new gear needs a pitch.');
  }
  if (data.faceWidth === undefined || !data.origin || !data.axis) {
    throw new Error('A new gear needs a face width, an origin and an axis.');
  }
  const axis = values.vector(data.axis, 'axis');
  const xDirection = gearXDirection(data, axis, values);
  const spec = {
    kind: data.gearType,
    module,
    faceWidth: values.resolve(data.faceWidth, 'face width'),
    ...toothForm,
    ...helical,
    origin: values.vector(data.origin, 'origin'),
    axis,
    xDirection,
    ...withNumber(
      'boreDiameter',
      values.optional(data.boreDiameter, 'bore diameter')
    ),
    ...withNumber(
      'rimDiameter',
      values.optional(data.rimDiameter, 'rim diameter')
    ),
    ...withNumber('backDepth', values.optional(data.backDepth, 'back depth'))
  };
  const { solid, details } = unwrap(
    gearKernel(kernel).makeGearDetailed(JSON.stringify(spec)),
    'Gear'
  );
  validateGeneratedSolid(kernel, solid, 'Gear');
  raiseGearWarnings(ctx, feature, details);
  result.shapes.set(feature.bodyId!, {
    solids: [solid],
    lineage: gearRoleLineage(kernel, solid, feature.featureId, details)
  });
}

function buildGearTeethOnBody(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'gear'>,
  toothForm: Record<string, number>,
  helical: Record<string, number | string | boolean>,
  module: number | undefined,
  values: GearValues
): void {
  const { kernel, result } = ctx;
  const targetBodyId = data.targetBodyId!;
  const target = result.shapes.get(targetBodyId);
  if (!target) {
    throw new Error('Gear target is unavailable.');
  }
  if (typeof data.faceHash !== 'number') {
    throw new Error('Gear teeth on a body need its cylindrical face.');
  }
  // Face resolution works on a single solid; fuse a multi-solid body first,
  // exactly as a hole does.
  const shape: ExactShape =
    target.solids.length === 1
      ? target
      : { solids: [collapseShape(kernel, target)] };
  const targetSolid = shape.solids[0]!;
  const face = resolveFeatureFaces(
    kernel,
    shape,
    [data.faceHash],
    data.faceReference ? [data.faceReference] : undefined,
    'Gear'
  )[0]!;
  const geometry = measureFaceGeometry(kernel, face);
  if (
    geometry?.surfaceType !== 'cylinder' ||
    geometry.axialLength === undefined
  ) {
    throw new Error('Gear teeth need a cylindrical face.');
  }
  const fit = data.fit ?? 'keep-diameter';
  if (fit === 'module' && module === undefined) {
    throw new Error('A gear sized by module needs a pitch.');
  }
  const spec = {
    kind: data.gearType,
    // The teeth span the whole face; the kernel refuses any other width.
    faceWidth: geometry.axialLength,
    fit: fit === 'module' ? 'module' : 'keepDiameter',
    ...(fit === 'module' ? { module } : {}),
    ...toothForm,
    ...helical,
    ...(data.xDirection
      ? { xDirection: values.vector(data.xDirection, 'x direction') }
      : {})
  };
  const { solid, details } = unwrap(
    gearKernel(kernel).cutGearTeethDetailed(
      targetSolid,
      face,
      JSON.stringify(spec)
    ),
    'Gear'
  );
  validateGeneratedSolid(kernel, solid, 'Gear');
  raiseGearWarnings(ctx, feature, details);
  result.consumed.add(targetBodyId);
  // The body's other faces keep their names through a unique analytic
  // carrier, as across a boolean; the gear's own faces take their roles.
  const carried = deriveRemusBooleanCarrierLineage({
    producingFeatureId: feature.featureId,
    operands: [
      {
        lineage: shape.lineage,
        candidates: topologyCandidatesForSolid(kernel, targetSolid),
        role: 'target'
      }
    ],
    resultCandidates: topologyCandidatesForSolid(kernel, solid)
  });
  result.shapes.set(feature.bodyId!, {
    solids: [solid],
    lineage: mergeRemusLineageStates([
      carried,
      gearRoleLineage(kernel, solid, feature.featureId, details)
    ])
  });
  inheritMeshOrigin(result, targetBodyId, feature.bodyId);
}
