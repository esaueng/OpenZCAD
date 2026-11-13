/**
 * M14 gear features: a new spur, helical, herringbone or straight bevel gear,
 * worm or worm wheel body from the kernel's gear generator, or teeth cut
 * along a body's cylindrical face: the whole of it, or part of it with the
 * cylinder kept as collars either side (schema v55).
 *
 * The kernel owns the gear: the involute, its certified flank fit, the
 * tooth-form checks and the boolean that cuts teeth into a body. This module
 * turns the feature's stored parameters into the kernel's spec, maps the
 * kernel's typed refusals onto {@link KernelRefusal}, surfaces its guideline
 * warnings as advisories, and names every gear face from the kernel's own
 * construction roles.
 */
import {
  defaultGearXDirection,
  gearModule,
  type FeatureId,
  type FeatureNode,
  type ParamValue,
  type ParametricVector3
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
import { unifyAndRequireValidSolid } from './kernel-validation';
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

/** The enveloping worm entry point, on kernels from its release on. */
interface EnvelopingWormKernel {
  makeEnvelopingWormDetailed(spec: string): SolidOperationDetailedResult;
}

function envelopingWormKernel(kernel: RemusKernel): EnvelopingWormKernel {
  const candidate = kernel as unknown as Partial<EnvelopingWormKernel>;
  if (typeof candidate.makeEnvelopingWormDetailed !== 'function') {
    throw new Error('This kernel build has no enveloping worm generator.');
  }
  return candidate as EnvelopingWormKernel;
}

/** The enveloping wheel entry point, on kernels from its release on. */
interface EnvelopingWheelKernel {
  makeEnvelopingWormWheelDetailed(spec: string): SolidOperationDetailedResult;
}

function envelopingWheelKernel(kernel: RemusKernel): EnvelopingWheelKernel {
  const candidate = kernel as unknown as Partial<EnvelopingWheelKernel>;
  if (typeof candidate.makeEnvelopingWormWheelDetailed !== 'function') {
    throw new Error('This kernel build has no enveloping wheel generator.');
  }
  return candidate as EnvelopingWheelKernel;
}

/** The worm entry points, on kernels from the worm release on. */
interface WormGearKernel {
  makeWormDetailed(spec: string): SolidOperationDetailedResult;
  makeWormWheelDetailed(spec: string): SolidOperationDetailedResult;
}

function wormGearKernel(kernel: RemusKernel): WormGearKernel {
  const candidate = kernel as unknown as Partial<WormGearKernel>;
  if (
    typeof candidate.makeWormDetailed !== 'function' ||
    typeof candidate.makeWormWheelDetailed !== 'function'
  ) {
    throw new Error('This kernel build has no worm gear generator.');
  }
  return candidate as WormGearKernel;
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
  'gear:span-outside-face':
    'The teeth run past an end of the cylindrical face. Shorten them or reduce the offset.',
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
 * Shared with the meshing-pair helper, which sizes pairs the same way.
 */
export { gearModule };

/** A deterministic reference direction perpendicular to `axis`. */
export { defaultGearXDirection };

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
  } else if (data.gearType === 'worm' || data.gearType === 'worm-wheel') {
    buildWormGearBody(ctx, feature, data, toothForm, module, values);
  } else if (data.gearType === 'enveloping-worm') {
    buildEnvelopingWormBody(ctx, feature, data, toothForm, module, values);
  } else if (data.gearType === 'enveloping-wheel') {
    buildEnvelopingWheelBody(ctx, feature, data, toothForm, module, values);
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

/**
 * A worm, or the helical wheel that meshes with one: the first cap on
 * `origin`, along `axis`. A worm's `teeth` are its starts and its `pitch` the
 * axial module; a wheel carries its worm's starts as `mateTeeth` and takes
 * the worm's module, so its transverse module is that module. A throated
 * wheel's tips follow the worm's clearance torus across the throat. Neither
 * has a profile shift; the command validation refuses one.
 */
function buildWormGearBody(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'gear'>,
  toothForm: Record<string, number>,
  module: number | undefined,
  values: GearValues
): void {
  const { kernel, result } = ctx;
  const worm = data.gearType === 'worm';
  if (module === undefined || data.diameterFactor === undefined) {
    throw new Error(
      'A worm gear needs a pitch and the worm’s diameter factor.'
    );
  }
  if (data.faceWidth === undefined || !data.origin || !data.axis) {
    throw new Error('A new gear needs a face width, an origin and an axis.');
  }
  const { profileShift: _shift, teeth, ...form } = toothForm;
  const axis = values.vector(data.axis, 'axis');
  const width = values.resolve(data.faceWidth, 'face width');
  let starts = teeth;
  if (!worm) {
    if (data.mateTeeth === undefined) {
      throw new Error('A worm wheel needs its worm’s thread starts.');
    }
    starts = Math.round(values.resolve(data.mateTeeth, 'worm starts'));
  }
  const spec = {
    module,
    starts,
    diameterFactor: values.resolve(data.diameterFactor, 'diameter factor'),
    ...(worm ? { length: width } : { teeth, faceWidth: width }),
    ...(data.throated ? { throated: true } : {}),
    ...withNumber(
      'outsideDiameter',
      values.optional(data.outsideDiameter, 'outside diameter')
    ),
    ...form,
    ...(data.hand ? { hand: data.hand } : {}),
    origin: values.vector(data.origin, 'origin'),
    axis,
    xDirection: gearXDirection(data, axis, values),
    ...withNumber(
      'boreDiameter',
      values.optional(data.boreDiameter, 'bore diameter')
    )
  };
  const label = worm
    ? 'Worm'
    : data.throated
      ? 'Throated worm wheel'
      : 'Worm wheel';
  const generator = wormGearKernel(kernel);
  const { solid, details } = unwrap(
    worm
      ? generator.makeWormDetailed(JSON.stringify(spec))
      : generator.makeWormWheelDetailed(JSON.stringify(spec)),
    label
  );
  validateGeneratedSolid(kernel, solid, label);
  raiseGearWarnings(ctx, feature, details);
  result.shapes.set(feature.bodyId!, {
    solids: [solid],
    lineage: gearRoleLineage(kernel, solid, feature.featureId, details)
  });
}

/**
 * A double-enveloping (Hindley) worm: its first cap on `origin`, along
 * `axis`, its throat half way along. `teeth` are its starts and `mateTeeth`
 * the teeth of the wheel it wraps; the thread has no shift or fillet, which
 * the command validation refuses.
 */
function buildEnvelopingWormBody(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'gear'>,
  toothForm: Record<string, number>,
  module: number | undefined,
  values: GearValues
): void {
  const { kernel, result } = ctx;
  if (
    module === undefined ||
    data.diameterFactor === undefined ||
    data.mateTeeth === undefined
  ) {
    throw new Error(
      'An enveloping worm needs a pitch, its diameter factor and its wheel’s teeth.'
    );
  }
  if (data.faceWidth === undefined || !data.origin || !data.axis) {
    throw new Error('A new gear needs a face width, an origin and an axis.');
  }
  const {
    profileShift: _shift,
    rootFillet: _fillet,
    teeth,
    ...form
  } = toothForm;
  const axis = values.vector(data.axis, 'axis');
  const spec = {
    module,
    starts: teeth,
    wheelTeeth: Math.round(values.resolve(data.mateTeeth, 'wheel teeth')),
    diameterFactor: values.resolve(data.diameterFactor, 'diameter factor'),
    length: values.resolve(data.faceWidth, 'face width'),
    ...form,
    ...(data.hand ? { hand: data.hand } : {}),
    origin: values.vector(data.origin, 'origin'),
    axis,
    xDirection: gearXDirection(data, axis, values),
    ...withNumber(
      'boreDiameter',
      values.optional(data.boreDiameter, 'bore diameter')
    )
  };
  const label = 'Enveloping worm';
  const { solid, details } = unwrap(
    envelopingWormKernel(kernel).makeEnvelopingWormDetailed(
      JSON.stringify(spec)
    ),
    label
  );
  validateGeneratedSolid(kernel, solid, label);
  raiseGearWarnings(ctx, feature, details);
  result.shapes.set(feature.bodyId!, {
    solids: [solid],
    lineage: gearRoleLineage(kernel, solid, feature.featureId, details)
  });
}

/**
 * The wheel a double-enveloping (Hindley) worm drives: its first cap on
 * `origin`, along `axis`, the worm across the middle of its face. `teeth`
 * are its own teeth, `mateTeeth` the worm's starts and `wormLength` the
 * worm's length; its teeth have no shift or fillet, which the command
 * validation refuses.
 */
function buildEnvelopingWheelBody(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'gear'>,
  toothForm: Record<string, number>,
  module: number | undefined,
  values: GearValues
): void {
  const { kernel, result } = ctx;
  if (
    module === undefined ||
    data.diameterFactor === undefined ||
    data.mateTeeth === undefined ||
    data.wormLength === undefined
  ) {
    throw new Error(
      'An enveloping wheel needs a pitch and its worm’s starts, diameter factor and length.'
    );
  }
  if (data.faceWidth === undefined || !data.origin || !data.axis) {
    throw new Error('A new gear needs a face width, an origin and an axis.');
  }
  const {
    profileShift: _shift,
    rootFillet: _fillet,
    teeth,
    ...form
  } = toothForm;
  const axis = values.vector(data.axis, 'axis');
  const spec = {
    module,
    starts: Math.round(values.resolve(data.mateTeeth, 'worm starts')),
    wheelTeeth: teeth,
    diameterFactor: values.resolve(data.diameterFactor, 'diameter factor'),
    length: values.resolve(data.wormLength, 'worm length'),
    faceWidth: values.resolve(data.faceWidth, 'face width'),
    ...form,
    ...(data.hand ? { hand: data.hand } : {}),
    ...withNumber(
      'outsideDiameter',
      values.optional(data.outsideDiameter, 'outside diameter')
    ),
    origin: values.vector(data.origin, 'origin'),
    axis,
    xDirection: gearXDirection(data, axis, values),
    ...withNumber(
      'boreDiameter',
      values.optional(data.boreDiameter, 'bore diameter')
    )
  };
  const label = 'Enveloping wheel';
  const { solid, details } = unwrap(
    envelopingWheelKernel(kernel).makeEnvelopingWormWheelDetailed(
      JSON.stringify(spec)
    ),
    label
  );
  validateGeneratedSolid(kernel, solid, label);
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

/**
 * Where teeth on a body run along its face, from the face's lower end (the
 * kernel's `offset`) and for how long. Without `faceWidth`, `offset` or
 * `anchor` they run the whole face; without `faceWidth` they run from the
 * offset to the far end. Teeth that would leave the face are the kernel's
 * refusal (`gear:span-outside-face`), which names both lengths.
 */
export function gearTeethSpan(
  data: Pick<FeatureDataOf<'gear'>, 'faceWidth' | 'offset' | 'anchor'>,
  faceLength: number,
  values: Pick<GearValues, 'optional'>
): { offset: number; width: number } {
  const offset = values.optional(data.offset, 'offset') ?? 0;
  const width =
    values.optional(data.faceWidth, 'face width') ?? faceLength - offset;
  if (!(width > 0)) {
    throw new Error(
      'The teeth offset reaches the end of the cylindrical face, leaving no teeth.'
    );
  }
  return {
    offset: (data.anchor ?? 'start') === 'end' ? faceLength - offset - width : offset,
    width
  };
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
    // Older in-place edits paired the live face hash with the original
    // reference. The reference still names the intended wall across height
    // changes; resolve it with its own hash so it cannot silently downgrade
    // to a legacy hash pick. Invalid or missing lineage remains terminal.
    [data.faceReference?.currentHash ?? data.faceHash],
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
  const span = gearTeethSpan(data, geometry.axialLength, values);
  const spec = {
    kind: data.gearType,
    faceWidth: span.width,
    // From the face's lower end; absent is 0, the whole-face request.
    ...(span.offset !== 0 ? { offset: span.offset } : {}),
    fit: fit === 'module' ? 'module' : 'keepDiameter',
    ...(fit === 'module' ? { module } : {}),
    ...toothForm,
    ...helical,
    ...(data.xDirection
      ? { xDirection: values.vector(data.xDirection, 'x direction') }
      : {})
  };
  const { solid, details: cutDetails } = unwrap(
    gearKernel(kernel).cutGearTeethDetailed(
      targetSolid,
      face,
      JSON.stringify(spec)
    ),
    'Gear'
  );
  const tolerance = spanTolerance(geometry.axialLength);
  const partial =
    span.offset > tolerance ||
    span.offset + span.width < geometry.axialLength - tolerance;
  // The body's other faces keep their names through a unique analytic
  // carrier, as across a boolean; the gear's own faces take their roles.
  const carried = () =>
    deriveRemusBooleanCarrierLineage({
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
  let details: GearOkDetails;
  let kept: RemusLineageState;
  if (partial) {
    // Unifying a partial band would also merge each tip land into the collar
    // it stands on, which the kernel reverts or leaves unmeasurable; its
    // shoulders, collars and any end it reaches are named instead.
    kept = carried();
    details = nameGearSpanFaces(kernel, solid, cutDetails, {
      start: geometry.axisStart!,
      end: geometry.axisEnd!,
      radius: geometry.radius!,
      from: span.offset,
      to: span.offset + span.width
    });
  } else {
    details = unifyGearCaps(kernel, solid, cutDetails);
    kept = carried();
  }
  validateGeneratedSolid(kernel, solid, 'Gear');
  raiseGearWarnings(ctx, feature, details);
  result.consumed.add(targetBodyId);
  result.shapes.set(feature.bodyId!, {
    solids: [solid],
    lineage: mergeRemusLineageStates([
      kept,
      gearRoleLineage(kernel, solid, feature.featureId, details)
    ])
  });
  inheritMeshOrigin(result, targetBodyId, feature.bodyId);
}

/** Axial lengths this close are one position along a face of `length`. */
function spanTolerance(length: number): number {
  return 1e-7 * Math.max(1, length);
}

/**
 * Teeth over part of a face end at shoulders and leave the cylinder beside
 * them as collars, faces the kernel gives no role. Name them from where they
 * stand: a coaxial cylinder of the face's radius before or after the teeth is
 * `collar.start|end`; a plane across the axis at either end of the teeth that
 * borders a gear face is `shoulder.start|end`, or `shoulder.start[k]` per
 * tooth space where the tips stand on the collar and split it, `k` the root
 * it borders. The face's cap at either end is `cap.start|end`, as the
 * whole-face cut names it: at an end the teeth stop short of, the plane
 * there that bounds the collar; where the teeth reach the end, the cap is
 * split, the gear's toothed ring keeps `cap.*` and the body's part of it,
 * inside (a boss) or outside (a bore) the ring, is `cap.start|end.body`.
 * Collars are only
 * what remains of the picked face, and always take their role, so a span
 * edit that splits or rejoins them keeps their names. Other faces keep the
 * body's lineage.
 */
function nameGearSpanFaces(
  kernel: RemusKernel,
  solid: number,
  details: GearOkDetails,
  band: {
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
    radius: number;
    from: number;
    to: number;
  }
): GearOkDetails {
  const roles = details.faceRoles ?? [];
  const roleOf = new Map(roles.map(({ face, role }) => [face, role] as const));
  const run = {
    x: band.end.x - band.start.x,
    y: band.end.y - band.start.y,
    z: band.end.z - band.start.z
  };
  const length = Math.hypot(run.x, run.y, run.z);
  if (!(length > 0)) return details;
  const axis = { x: run.x / length, y: run.y / length, z: run.z / length };
  const at = (point: { x: number; y: number; z: number }) =>
    (point.x - band.start.x) * axis.x +
    (point.y - band.start.y) * axis.y +
    (point.z - band.start.z) * axis.z;
  const parallel = (direction: { x: number; y: number; z: number }) => {
    const size = Math.hypot(direction.x, direction.y, direction.z);
    return (
      size > 0 &&
      Math.abs(
        (direction.x * axis.x + direction.y * axis.y + direction.z * axis.z) /
          size
      ) >
        1 - 1e-9
    );
  };
  const tolerance = spanTolerance(length);
  // Each gear face's edges, to find the shoulders that border the teeth.
  const gearEdges = new Map<number, string>();
  for (const { face, role } of roles) {
    for (const edge of kernel.getFaceEdges(face)) gearEdges.set(edge, role);
  }
  const added: { face: number; role: string }[] = [];
  const shoulders = { start: [] as number[], end: [] as number[] };
  const ends = { start: [] as number[], end: [] as number[] };
  const collars = { start: [] as number[], end: [] as number[] };
  const endPlanes = { start: [] as number[], end: [] as number[] };
  const shoulderRoot = new Map<number, number | undefined>();
  // Whether a point lies on the picked face's axis line.
  const onAxis = (point: { x: number; y: number; z: number }) => {
    const t = at(point);
    return (
      Math.hypot(
        point.x - band.start.x - axis.x * t,
        point.y - band.start.y - axis.y * t,
        point.z - band.start.z - axis.z * t
      ) <= tolerance
    );
  };
  for (const face of kernel.getSolidFaces(solid)) {
    if (roleOf.has(face)) continue;
    const geometry = measureFaceGeometry(kernel, face);
    if (!geometry) continue;
    if (
      geometry.surfaceType === 'cylinder' &&
      geometry.axisStart &&
      geometry.axisEnd &&
      geometry.radius !== undefined &&
      Math.abs(geometry.radius - band.radius) <= tolerance &&
      parallel({
        x: geometry.axisEnd.x - geometry.axisStart.x,
        y: geometry.axisEnd.y - geometry.axisStart.y,
        z: geometry.axisEnd.z - geometry.axisStart.z
      }) &&
      onAxis(geometry.axisStart)
    ) {
      // Only what is left of the picked face: on its axis line and within
      // its length, so a coaxial step of the same diameter elsewhere on the
      // body keeps its own name. A collar is named by its role even where
      // the body's lineage could carry the face's old name (a single
      // collar), so the name holds as an offset or length edit makes one
      // collar two, or two one.
      const a = at(geometry.axisStart);
      const b = at(geometry.axisEnd);
      if (Math.min(a, b) < -tolerance || Math.max(a, b) > length + tolerance) {
        continue;
      }
      const middle = (a + b) / 2;
      if (middle < band.from - tolerance) collars.start.push(face);
      else if (middle > band.to + tolerance) collars.end.push(face);
      continue;
    }
    if (
      geometry.surfaceType !== 'plane' ||
      !geometry.normal ||
      !parallel(geometry.normal)
    ) {
      continue;
    }
    const position = at(geometry.center);
    // A plane at an end of the picked face the teeth stop short of: the
    // face's cap there, once it is seen to bound that end's collar.
    if (Math.abs(position) <= tolerance && band.from > tolerance) {
      endPlanes.start.push(face);
      continue;
    }
    if (
      Math.abs(position - length) <= tolerance &&
      band.to < length - tolerance
    ) {
      endPlanes.end.push(face);
      continue;
    }
    const side =
      Math.abs(position - band.from) <= tolerance
        ? 'start'
        : Math.abs(position - band.to) <= tolerance
          ? 'end'
          : undefined;
    if (!side) continue;
    const atFaceEnd =
      side === 'start' ? band.from <= tolerance : band.to >= length - tolerance;
    let root: number | undefined;
    let borders = false;
    for (const edge of kernel.getFaceEdges(face)) {
      const role = gearEdges.get(edge);
      if (role === undefined) continue;
      borders = true;
      const index = /^root\[(\d+)\]/.exec(role)?.[1];
      if (index !== undefined) root = Number(index);
    }
    if (!borders) continue;
    if (atFaceEnd) {
      ends[side].push(face);
      continue;
    }
    shoulders[side].push(face);
    shoulderRoot.set(face, root);
  }
  for (const side of ['start', 'end'] as const) {
    // The face's cap at an end the teeth stop short of keeps the name the
    // whole-face cut gives it, `cap.start|end`, so a span edit either way
    // leaves a reference to it in place.
    const collarEdges = new Set(
      collars[side].flatMap((face) => Array.from(kernel.getFaceEdges(face)))
    );
    const caps = endPlanes[side].filter((face) =>
      kernel.getFaceEdges(face).some((edge) => collarEdges.has(edge))
    );
    caps.forEach((face, order) => {
      added.push({
        face,
        role: caps.length === 1 ? `cap.${side}` : `cap.${side}[${order}]`
      });
    });
    collars[side].forEach((face, order) => {
      added.push({
        face,
        role:
          collars[side].length === 1
            ? `collar.${side}`
            : `collar.${side}[${order}]`
      });
    });
    ends[side].forEach((face, order) => {
      added.push({
        face,
        role:
          ends[side].length === 1
            ? `cap.${side}.body`
            : `cap.${side}.body[${order}]`
      });
    });
    const faces = shoulders[side];
    if (faces.length === 1) {
      added.push({ face: faces[0]!, role: `shoulder.${side}` });
      continue;
    }
    // One per tooth space: indexed by the root each borders, unless a root
    // is missing or shared, where the order around the axis stands in.
    const indices = faces.map((face) => shoulderRoot.get(face));
    const unique =
      indices.every((index) => index !== undefined) &&
      new Set(indices).size === indices.length;
    faces.forEach((face, order) => {
      added.push({
        face,
        role: `shoulder.${side}[${unique ? indices[order]! : order}]`
      });
    });
  }
  return { ...details, faceRoles: [...roles, ...added] };
}

/**
 * Teeth cut along a body leave each end cap as two faces on one plane: the
 * body's own disc inside the root circle and the gear's toothed ring around
 * it. That reads as a seam, picks as half a cap, and no single face can be
 * pushed or pulled. Unify them in place, which keeps every other face handle,
 * and move a cap role whose face merged away onto the face that survived, so
 * the whole cap keeps the gear's name.
 */
function unifyGearCaps(
  kernel: RemusKernel,
  solid: number,
  details: GearOkDetails
): GearOkDetails {
  const roles = details.faceRoles ?? [];
  const caps = roles.flatMap(({ face, role }) => {
    const geometry = role.startsWith('cap.')
      ? measureFaceGeometry(kernel, face)
      : undefined;
    return geometry?.normal && geometry.planeOffset !== undefined
      ? [{ face, normal: geometry.normal, offset: geometry.planeOffset }]
      : [];
  });
  if (caps.length === 0) return details;
  const report = unifyAndRequireValidSolid(
    kernel,
    solid,
    'Gear did not produce a valid closed solid.'
  );
  if (report.facesMerged === 0) return details;
  const surviving = new Set(kernel.getSolidFaces(solid));
  const named = new Set(roles.map(({ face }) => face));
  const unnamedPlanes = Array.from(surviving).flatMap((face) => {
    if (named.has(face)) return [];
    const geometry = measureFaceGeometry(kernel, face);
    return geometry?.normal && geometry.planeOffset !== undefined
      ? [{ face, normal: geometry.normal, offset: geometry.planeOffset }]
      : [];
  });
  const mergedInto = new Map<number, number>();
  for (const cap of caps) {
    if (surviving.has(cap.face)) continue;
    const tolerance = Math.max(1, Math.abs(cap.offset)) * 1e-7;
    const matches = unnamedPlanes.filter(
      ({ normal, offset }) =>
        normal.x * cap.normal.x +
          normal.y * cap.normal.y +
          normal.z * cap.normal.z >
          1 - 1e-9 && Math.abs(offset - cap.offset) <= tolerance
    );
    if (matches.length === 1) mergedInto.set(cap.face, matches[0]!.face);
  }
  return {
    ...details,
    faceRoles: roles.flatMap(({ face, role }) => {
      const current = surviving.has(face) ? face : mergedInto.get(face);
      return current === undefined ? [] : [{ face: current, role }];
    })
  };
}
