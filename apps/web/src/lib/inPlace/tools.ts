import type { PlaneBasis } from '@openzcad/geometry';
import {
  MAX_HELICAL_SWEEP_TURNS,
  type BodyId,
  type BooleanKeepOriginals,
  type BooleanOperation,
  type DatumAxisLine,
  type FeatureId,
  type ParamValue,
  type ParametricVector3,
  type RevolveAxis,
  type SketchId,
  type SketchProfileReference,
  type SketchSectionReference,
  type Vector3
} from '@openzcad/shared';
import {
  MIN_REVOLVE_ANGLE,
  revolveAxisCandidates,
  revolveProfileRegions,
  revolveRigPlacement,
  type RevolveAxisCandidate
} from './revolve';
import type { ModelingOperationFormState } from '../modelingOperations';
import { holePositionAxes, holePositionFromPick } from '../holePositionAxes';

/**
 * The in-place commands (U09), as data.
 *
 * Every tool here runs the same way: picks fill its slots, an exact preview
 * runs as soon as the required ones are filled, and its numbers are handles
 * with chips. A spec says which slots a tool has, which numbers, what to say
 * next, where each handle stands, and what to build. The hook runs them all;
 * App only turns a request into the command the commit would run.
 */

export type InPlaceToolId =
  | 'revolve'
  | 'loft'
  | 'sweep'
  | 'helical-sweep'
  | 'hole'
  | 'shell'
  | 'thicken'
  | 'solid-offset'
  | 'draft'
  | 'mirror'
  | 'split'
  | 'scale'
  | 'axis-rotate'
  | 'union'
  | 'subtract'
  | 'intersect'
  | 'linear-pattern'
  | 'circular-pattern'
  | 'grid-pattern';

export const IN_PLACE_TOOLS: readonly InPlaceToolId[] = [
  'revolve',
  'loft',
  'sweep',
  'helical-sweep',
  'hole',
  'shell',
  'thicken',
  'solid-offset',
  'draft',
  'mirror',
  'split',
  'scale',
  'axis-rotate',
  'union',
  'subtract',
  'intersect',
  'linear-pattern',
  'circular-pattern',
  'grid-pattern'
];

export function isInPlaceTool(tool: string): tool is InPlaceToolId {
  return (IN_PLACE_TOOLS as readonly string[]).includes(tool);
}

/** A picked region: its sketch, its stored reference, and which cell. */
export interface ProfilePick {
  sketchId: SketchId;
  reference: SketchProfileReference;
  regionFingerprint: number;
}

/** A picked sketch curve, named by its authored entity. */
export interface CurvePick {
  sketchId: SketchId;
  entityId: string;
}

/** A picked model face, with what its handles stand on. */
export interface FacePick {
  bodyId: BodyId;
  hash: number;
  topologyId: string;
  surfaceType?: string;
  normal?: Vector3;
  centroid?: Vector3;
  center?: Vector3;
  /** Where the click landed on it (a hole goes there). */
  point?: Vector3;
}

/** A picked body, with the box its handles are placed from. */
export interface BodyPick {
  bodyId: BodyId;
  min: Vector3;
  max: Vector3;
}

/** A plane to mirror or split across. */
export type PlanePick =
  | { kind: 'principal'; plane: string; origin: Vector3; normal: Vector3 }
  | { kind: 'face'; origin: Vector3; normal: Vector3 }
  | { kind: 'datum'; featureId: FeatureId };

/** What the picks have filled. Order matters: a loft's sections run in it. */
export interface InPlaceSlots {
  profiles: ProfilePick[];
  axis: RevolveAxisCandidate | null;
  path: CurvePick[];
  /** A sweep's guide rail, in the order its curves were clicked. */
  guide: CurvePick[];
  faces: FacePick[];
  /** In pick order: a boolean's first is its base. */
  bodies: BodyPick[];
  plane: PlanePick | null;
}

/** A choice too rare for a handle: it lives in the bar's Options menu. */
export interface OptionSpec {
  id: string;
  label: string;
  choices: readonly { value: string; label: string }[];
  initial: string;
  /**
   * Another option this one may never equal (a grid's two directions):
   * choosing that option's value swaps the two instead.
   */
  distinctFrom?: string;
}

export type ValueUnit = 'angle' | 'length' | 'count';

export interface ValueSpec {
  id: string;
  label: string;
  unit: ValueUnit;
  initial: number;
  min?: number;
  max?: number;
  /** Whole numbers only (a pattern's counts): a fraction rounds, or is refused when typed. */
  integer?: boolean;
}

/** A sketch as the commands read it: its plane and its region outlines. */
export interface InPlaceSketchView {
  sketchId: SketchId;
  basis: PlaneBasis;
  regions: readonly {
    regionFingerprint: number;
    outer: readonly { x: number; y: number }[];
    /** The authored entities bounding it, which survive a renumbering. */
    sourceEntityIds?: readonly string[];
  }[];
}

export interface InPlaceContext {
  sketchViews: readonly InPlaceSketchView[];
  datumAxes: Record<FeatureId, DatumAxisLine> | undefined;
  datumLabel(featureId: FeatureId): string;
  /** The linear snap a clicked position rounds to; null when snapping is off. */
  linearSnap?: number | null;
  /** A body's bounding box, for references measured on it (a draft's base). */
  bodyBounds?(bodyId: BodyId): { min: Vector3; max: Vector3 } | null;
}

/** What to build, without names or ids; App turns it into the command. */
export type InPlaceRequest =
  | {
      tool: 'revolve';
      sketchId: SketchId;
      profile: SketchProfileReference;
      axis: { axis: RevolveAxis } | { datumFeatureId: FeatureId };
      /** Absent is a full turn, stored exactly as before partial revolves. */
      angleDeg?: ParamValue;
    }
  | {
      tool: 'loft';
      sections: SketchSectionReference[];
      mode: 'ruled' | 'smooth';
      /** Closes the last section to this point (a pointed loft). */
      endPoint?: ParametricVector3;
    }
  | {
      tool: 'sweep';
      profile: SketchSectionReference;
      path: { sketchId: SketchId; entityIds: string[] };
      mode: 'standard' | 'smooth';
      guide?: { sketchId: SketchId; entityIds: string[] };
    }
  | {
      tool: 'helical-sweep';
      profile: SketchSectionReference;
      axisOrigin: ParametricVector3;
      axisDirection: ParametricVector3;
      radius: ParamValue;
      pitch: ParamValue;
      turns: ParamValue;
    }
  | {
      /**
       * A face operation, as the state its card would have held: App runs it
       * through the card's own submission builder, validation included.
       */
      tool: 'modeling';
      state: ModelingOperationFormState;
    }
  | {
      tool: 'boolean';
      operation: BooleanOperation;
      targetBodyIds: BodyId[];
      keepOriginals?: BooleanKeepOriginals;
    }
  | {
      tool: 'transform';
      targetBodyId: BodyId;
      translation: ParametricVector3;
      scale?: ParamValue;
      pivot?: ParametricVector3;
      axisRotation?: {
        axis: { type: 'datum-axis'; datumFeatureId: FeatureId };
        angleDeg: ParamValue;
      };
      copy?: boolean;
    }
  | {
      tool: 'pattern';
      targetBodyId: BodyId;
      patternKind: 'linear' | 'circular' | 'grid';
      count: ParamValue;
      axis: 'x' | 'y' | 'z';
      spacing?: ParamValue;
      angleDeg?: ParamValue;
      axis2?: 'x' | 'y' | 'z';
      spacing2?: ParamValue;
      count2?: ParamValue;
      axisRef?: { type: 'datum-axis'; datumFeatureId: FeatureId };
    };

/** A handle the viewport draws for one value. */
export type HandleSpec =
  | {
      valueId: string;
      kind: 'angle';
      key: string;
      params: {
        center: Vector3;
        axis: Vector3;
        startDirection: Vector3;
        radius: number;
      };
    }
  | {
      valueId: string;
      kind: 'linear';
      key: string;
      params: { origin: Vector3; direction: Vector3; scale?: number };
    }
  | {
      /** A value with no drag of its own (a count): just its chip. */
      valueId: string;
      kind: 'chip';
      key: string;
      params: { anchor: Vector3 };
    };

export interface InPlaceToolSpec {
  id: InPlaceToolId;
  title: string;
  /** The feature's default name, when it differs from the title (the card's). */
  featureName?: string;
  /** One profile, an ordered list of them (a loft's sections), or none. */
  profileMode: 'none' | 'one' | 'many';
  /** Model faces it takes, all on one body; `planar` refuses curved ones. */
  faceMode?: 'one' | 'many';
  /** Whole bodies it takes, named by a click on any of their faces. */
  bodyMode?: 'one' | 'many';
  /** Takes a plane: a ghost principal plane, a datum plane or a flat face. */
  wantsPlane?: boolean;
  /**
   * Where its axis lines come from: the profile's sketch, datum axes, or the
   * world axes through the origin as well as datum axes.
   */
  axisSource?: 'sketch' | 'datum' | 'world';
  faceFilter?: 'planar';
  options?: readonly OptionSpec[];
  wantsAxis: boolean;
  wantsPath: boolean;
  values: readonly ValueSpec[];
  /**
   * Values the picks (or other values) suggest, applied to any the user has
   * not set. `numbers` holds every value as a number.
   */
  defaults?(
    slots: InPlaceSlots,
    ctx: InPlaceContext,
    numbers: Record<string, number>
  ): Record<string, number>;
  hint(slots: InPlaceSlots, options?: Record<string, string>): string;
  ready(slots: InPlaceSlots): boolean;
  /**
   * `values` holds what is stored: a typed expression as typed, else the
   * number. `numbers` holds every value as a number, for whatever the
   * request derives from one (a hole's step sizes).
   */
  request(
    slots: InPlaceSlots,
    values: Record<string, ParamValue>,
    options: Record<string, string>,
    ctx: InPlaceContext,
    numbers?: Record<string, number>
  ): InPlaceRequest | null;
  handles(
    slots: InPlaceSlots,
    values: Record<string, number>,
    ctx: InPlaceContext,
    options: Record<string, string>
  ): HandleSpec[];
}

const FINISH = 'Enter to finish · Esc cancels';

function section(pick: ProfilePick): SketchSectionReference {
  return { sketchId: pick.sketchId, profile: pick.reference };
}

function viewFor(
  ctx: InPlaceContext,
  sketchId: SketchId
): InPlaceSketchView | null {
  return ctx.sketchViews.find((view) => view.sketchId === sketchId) ?? null;
}

function toWorld(basis: PlaneBasis, point: { x: number; y: number }): Vector3 {
  return {
    x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
    y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
    z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
  };
}

/** The picked region's outline in world space (every region if it moved). */
export function profileOutline(
  ctx: InPlaceContext,
  pick: ProfilePick
): Vector3[] {
  const view = viewFor(ctx, pick.sketchId);
  if (!view) return [];
  // Found again by its entities when an undo or redo renumbered it.
  return revolveProfileRegions(view.regions, pick).flatMap((region) =>
    region.outer.map((point) => toWorld(view.basis, point))
  );
}

/** The axes a profile's sketch offers: its own two, and in-plane datums. */
export function axisCandidatesFor(
  slots: InPlaceSlots,
  ctx: InPlaceContext,
  source: 'sketch' | 'datum' | 'world' = 'sketch'
): RevolveAxisCandidate[] {
  if (source === 'datum' || source === 'world') {
    // Every resolved datum axis, wherever it runs.
    const datums: RevolveAxisCandidate[] = (
      Object.entries(ctx.datumAxes ?? {}) as [FeatureId, DatumAxisLine][]
    ).map(([featureId, line]) => ({
      id: `datum:${featureId}`,
      label: ctx.datumLabel(featureId),
      origin: line.origin,
      direction: line.direction,
      choice: { datumFeatureId: featureId }
    }));
    if (source === 'datum') return datums;
    const origin = { x: 0, y: 0, z: 0 };
    return [
      ...(['x', 'y', 'z'] as const).map((world) => ({
        id: `world-${world}`,
        label: `${world.toUpperCase()} axis`,
        origin,
        direction: AXIS_VECTORS[world]!,
        choice: { world }
      })),
      ...datums
    ];
  }
  const first = slots.profiles[0];
  const view = first ? viewFor(ctx, first.sketchId) : null;
  return view
    ? revolveAxisCandidates(view.basis, ctx.datumAxes, ctx.datumLabel)
    : [];
}

function unit(vector: Vector3): Vector3 {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function keyOf(...parts: (string | number)[]): string {
  return parts
    .map((part) => (typeof part === 'number' ? part.toFixed(6) : part))
    .join(':');
}

const revolve: InPlaceToolSpec = {
  id: 'revolve',
  title: 'Revolve',
  profileMode: 'one',
  wantsAxis: true,
  wantsPath: false,
  values: [
    {
      id: 'angle',
      label: 'Angle',
      unit: 'angle',
      initial: 360,
      min: MIN_REVOLVE_ANGLE,
      max: 360
    }
  ],
  hint(slots) {
    if (slots.profiles.length === 0) return 'Pick a sketch profile to revolve';
    if (!slots.axis) return 'Pick the axis to turn around';
    return `Drag the angle, or type a value · ${FINISH}`;
  },
  ready: (slots) => slots.profiles.length > 0 && slots.axis !== null,
  request(slots, values) {
    const pick = slots.profiles[0];
    const choice = slots.axis?.choice;
    // A revolve turns about a sketch or datum axis; it never offers a world
    // axis, which its feature could not store.
    if (!pick || !choice || 'world' in choice) return null;
    const angle = values.angle ?? 360;
    return {
      tool: 'revolve',
      sketchId: pick.sketchId,
      profile: pick.reference,
      axis: choice,
      ...(angle === 360 ? {} : { angleDeg: angle })
    };
  },
  handles(slots, _values, ctx) {
    const pick = slots.profiles[0];
    if (!pick || !slots.axis) return [];
    const placement = revolveRigPlacement(
      profileOutline(ctx, pick),
      slots.axis
    );
    if (!placement) return [];
    return [
      {
        valueId: 'angle',
        kind: 'angle',
        key: keyOf(
          pick.sketchId,
          pick.regionFingerprint,
          slots.axis.id,
          placement.center.x,
          placement.center.y,
          placement.center.z,
          placement.startDirection.x,
          placement.startDirection.y,
          placement.startDirection.z,
          // An undo can reverse a datum axis under the same id: the sweep
          // turns the other way, so the rig is rebuilt about it.
          placement.axis.x,
          placement.axis.y,
          placement.axis.z,
          placement.radius
        ),
        params: placement
      }
    ];
  }
};

const loft: InPlaceToolSpec = {
  id: 'loft',
  title: 'Loft',
  profileMode: 'many',
  wantsAxis: false,
  wantsPath: false,
  values: [
    // How far the apex stands off the last section, along its normal.
    { id: 'apex', label: 'Apex', unit: 'length', initial: 10 }
  ],
  options: [
    {
      id: 'end',
      label: 'Ends',
      choices: [
        { value: 'section', label: 'On the last section' },
        { value: 'apex', label: 'At an apex point' }
      ],
      initial: 'section'
    },
    {
      id: 'shape',
      label: 'Shape',
      // Ruled first and by default, as the card had it.
      choices: [
        { value: 'ruled', label: 'Ruled' },
        { value: 'smooth', label: 'Smooth' }
      ],
      initial: 'ruled'
    }
  ],
  hint(slots) {
    if (slots.profiles.length === 0) return 'Pick the first section profile';
    if (slots.profiles.length === 1) return 'Pick the next section profile';
    return `${slots.profiles.length} sections · pick another, or ${FINISH}`;
  },
  ready: (slots) => slots.profiles.length >= 2,
  request(slots, _values, options, ctx, numbers) {
    if (slots.profiles.length < 2) return null;
    const apex =
      options.end === 'apex' ? loftApex(slots, ctx, numbers?.apex ?? 10) : null;
    return {
      tool: 'loft',
      sections: slots.profiles.map(section),
      mode: options.shape === 'smooth' ? 'smooth' : 'ruled',
      ...(apex
        ? {
            endPoint: {
              x: String(apex.point.x),
              y: String(apex.point.y),
              z: String(apex.point.z)
            }
          }
        : {})
    };
  },
  handles(slots, _values, ctx, options) {
    if (options.end !== 'apex') return [];
    const apex = loftApex(slots, ctx, 0);
    if (!apex) return [];
    const last = slots.profiles.at(-1)!;
    return [
      {
        valueId: 'apex',
        kind: 'linear',
        key: `${last.sketchId}:${last.regionFingerprint}:apex`,
        params: { origin: apex.point, direction: apex.normal }
      }
    ];
  }
};

/**
 * The apex `distance` off the last section: from the middle of its outline,
 * along its sketch plane's normal.
 */
function loftApex(
  slots: InPlaceSlots,
  ctx: InPlaceContext,
  distance: number
): { point: Vector3; normal: Vector3 } | null {
  const last = slots.profiles.at(-1);
  const view = last ? viewFor(ctx, last.sketchId) : null;
  const outline = last ? profileOutline(ctx, last) : [];
  if (!view || outline.length === 0) return null;
  const middle = outline.reduce(
    (sum, point) => ({
      x: sum.x + point.x / outline.length,
      y: sum.y + point.y / outline.length,
      z: sum.z + point.z / outline.length
    }),
    { x: 0, y: 0, z: 0 }
  );
  const normal = unit(view.basis.normal);
  return {
    point: {
      x: middle.x + normal.x * distance,
      y: middle.y + normal.y * distance,
      z: middle.z + normal.z * distance
    },
    normal
  };
}

const sweep: InPlaceToolSpec = {
  id: 'sweep',
  title: 'Sweep',
  profileMode: 'one',
  wantsAxis: false,
  wantsPath: true,
  values: [],
  options: [
    {
      id: 'mode',
      label: 'Mode',
      choices: [
        { value: 'standard', label: 'Standard' },
        { value: 'smooth', label: 'Smooth' }
      ],
      initial: 'standard'
    },
    {
      id: 'curves',
      label: 'Clicks pick',
      // A guide rail is the profile's up-vector track: curve clicks add to
      // it instead of the path while this is chosen.
      choices: [
        { value: 'path', label: 'Path' },
        { value: 'guide', label: 'Guide rail' }
      ],
      initial: 'path'
    }
  ],
  hint(slots, options) {
    if (slots.profiles.length === 0) return 'Pick the profile to sweep';
    if (options?.curves === 'guide') {
      return slots.guide.length === 0
        ? 'Pick the guide rail: click its sketch curves'
        : `Guide rail of ${slots.guide.length}${
            options.mode === 'smooth' ? ' (guided sweeps are Standard)' : ''
          } · click more curves, or ${FINISH}`;
    }
    if (slots.path.length === 0)
      return 'Pick the path: click its sketch curves';
    return `Path of ${slots.path.length} · click more curves, or ${FINISH}`;
  },
  ready: (slots) => slots.profiles.length > 0 && slots.path.length > 0,
  request(slots, _values, options) {
    const pick = slots.profiles[0];
    const first = slots.path[0];
    if (!pick || !first) return null;
    const rail = slots.guide[0];
    return {
      tool: 'sweep',
      profile: section(pick),
      path: {
        sketchId: first.sketchId,
        entityIds: slots.path.map((curve) => curve.entityId)
      },
      // A guided sweep is Standard only; the hint says so when both are set.
      mode: options.mode === 'smooth' && !rail ? 'smooth' : 'standard',
      ...(rail
        ? {
            guide: {
              sketchId: rail.sketchId,
              entityIds: slots.guide.map((curve) => curve.entityId)
            }
          }
        : {})
    };
  },
  handles: () => []
};

const helicalSweep: InPlaceToolSpec = {
  id: 'helical-sweep',
  title: 'Helical sweep',
  profileMode: 'one',
  wantsAxis: true,
  wantsPath: false,
  values: [
    { id: 'radius', label: 'Radius', unit: 'length', initial: 10, min: 0.001 },
    { id: 'pitch', label: 'Pitch', unit: 'length', initial: 5 },
    {
      id: 'turns',
      label: 'Turns',
      unit: 'count',
      initial: 3,
      min: 0.1,
      max: MAX_HELICAL_SWEEP_TURNS
    }
  ],
  defaults(slots, ctx): Record<string, number> {
    const pick = slots.profiles[0];
    if (!pick || !slots.axis) return {};
    const outline = profileOutline(ctx, pick);
    const placement = revolveRigPlacement(outline, slots.axis);
    if (!placement) return {};
    // The helix passes through the profile's middle, and each turn climbs a
    // little more than the profile is tall so the coils never touch.
    const axis = placement.axis;
    const heights = outline.map((point) =>
      dot(
        {
          x: point.x - placement.center.x,
          y: point.y - placement.center.y,
          z: point.z - placement.center.z
        },
        axis
      )
    );
    const tall = Math.max(...heights) - Math.min(...heights);
    const middle = outline.reduce(
      (sum, point) => ({
        x: sum.x + point.x / outline.length,
        y: sum.y + point.y / outline.length,
        z: sum.z + point.z / outline.length
      }),
      { x: 0, y: 0, z: 0 }
    );
    const radial = {
      x: middle.x - placement.center.x,
      y: middle.y - placement.center.y,
      z: middle.z - placement.center.z
    };
    return {
      radius: Math.hypot(radial.x, radial.y, radial.z),
      pitch: Math.max(tall * 1.25, 0.001)
    };
  },
  hint(slots) {
    if (slots.profiles.length === 0) return 'Pick the profile to coil';
    if (!slots.axis) return 'Pick the helix axis';
    return `Drag radius and pitch, tap turns to type · ${FINISH}`;
  },
  ready: (slots) => slots.profiles.length > 0 && slots.axis !== null,
  request(slots, values) {
    const pick = slots.profiles[0];
    if (!pick || !slots.axis) return null;
    const direction = unit(slots.axis.direction);
    return {
      tool: 'helical-sweep',
      profile: section(pick),
      axisOrigin: { ...slots.axis.origin },
      axisDirection: { ...direction },
      radius: values.radius ?? 10,
      pitch: values.pitch ?? 5,
      turns: values.turns ?? 3
    };
  },
  handles(slots, values, ctx) {
    const pick = slots.profiles[0];
    if (!pick || !slots.axis) return [];
    const placement = revolveRigPlacement(
      profileOutline(ctx, pick),
      slots.axis
    );
    if (!placement) return [];
    const { center, axis, startDirection } = placement;
    const base = keyOf(pick.sketchId, pick.regionFingerprint, slots.axis.id);
    const radius = values.radius ?? 10;
    return [
      {
        valueId: 'radius',
        kind: 'linear',
        key: `${base}:radius`,
        params: { origin: center, direction: startDirection }
      },
      {
        // From the axis too, so neither handle moves when the other does.
        valueId: 'pitch',
        kind: 'linear',
        key: `${base}:pitch`,
        params: { origin: center, direction: axis }
      },
      {
        valueId: 'turns',
        kind: 'chip',
        key: `${base}:turns`,
        params: {
          anchor: {
            x: center.x - axis.x * radius * 0.5,
            y: center.y - axis.y * radius * 0.5,
            z: center.z - axis.z * radius * 0.5
          }
        }
      }
    ];
  }
};

/** A value as the card's text field would hold it. */
function text(value: ParamValue | undefined, fallback: number): string {
  return value === undefined ? String(fallback) : String(value);
}

function scaled(vector: Vector3, by: number): Vector3 {
  return { x: vector.x * by, y: vector.y * by, z: vector.z * by };
}

function faceAnchor(face: FacePick): Vector3 | null {
  return face.point ?? face.centroid ?? face.center ?? null;
}

function faceKey(face: FacePick): string {
  return `${face.bodyId}:${face.hash}`;
}

/** A length handle standing on a face, along its normal (or against it). */
function normalHandle(
  valueId: string,
  face: FacePick | undefined,
  sense: 1 | -1
): HandleSpec[] {
  const origin = face ? (face.centroid ?? face.center ?? face.point) : null;
  if (!face || !origin || !face.normal) return [];
  return [
    {
      valueId,
      kind: 'linear',
      key: `${faceKey(face)}:${valueId}:${sense}`,
      params: { origin, direction: scaled(unit(face.normal), sense) }
    }
  ];
}

const hole: InPlaceToolSpec = {
  id: 'hole',
  title: 'Hole',
  profileMode: 'none',
  faceMode: 'one',
  faceFilter: 'planar',
  wantsAxis: false,
  wantsPath: false,
  values: [
    { id: 'diameter', label: '⌀', unit: 'length', initial: 6, min: 0.1 },
    { id: 'depth', label: 'Depth', unit: 'length', initial: 10, min: 0.1 },
    // The step's sizes, on chips while its style is chosen. Until one is
    // set it follows the bore, as the card's defaults did.
    {
      id: 'counterboreDiameter',
      label: 'Counterbore ⌀',
      unit: 'length',
      initial: 10.8,
      min: 0.1
    },
    {
      id: 'counterboreDepth',
      label: 'Counterbore depth',
      unit: 'length',
      initial: 3,
      min: 0.01
    },
    {
      id: 'countersinkDiameter',
      label: 'Countersink ⌀',
      unit: 'length',
      initial: 12,
      min: 0.1
    },
    {
      // The full included angle, strictly between 0° and 180°.
      id: 'countersinkAngleDeg',
      label: 'Countersink angle',
      unit: 'angle',
      initial: 90,
      min: 1,
      max: 179
    }
  ],
  options: [
    {
      id: 'depthMode',
      label: 'Depth',
      choices: [
        { value: 'through', label: 'Through all' },
        { value: 'blind', label: 'Blind' }
      ],
      initial: 'through'
    },
    {
      id: 'style',
      label: 'Style',
      choices: [
        { value: 'simple', label: 'Simple' },
        { value: 'counterbore', label: 'Counterbore' },
        { value: 'countersink', label: 'Countersink' }
      ],
      initial: 'simple'
    }
  ],
  defaults: (_slots, _ctx, numbers) => holeStepSizes(numbers.diameter ?? 6),
  hint(slots, options) {
    if (slots.faces.length === 0)
      return 'Click a flat face where the hole goes';
    const step =
      options?.style === 'counterbore' || options?.style === 'countersink'
        ? ` · tap the ${options.style} chips to size it`
        : '';
    return `Click again to move it · drag the diameter${step} · ${FINISH}`;
  },
  ready: (slots) => slots.faces.length > 0,
  request(slots, values, options, ctx, numbers) {
    const face = slots.faces[0];
    if (!face || !face.normal) return null;
    const anchor = face.centroid ? 'centroid' : 'center';
    // Rounded to the sketch snap, exactly as the card placed a clicked hole.
    const position = face.point
      ? holePositionFromPick(face, anchor, face.point, ctx.linearSnap ?? null)
      : null;
    // Unset step sizes derive from the bore's value, a typed expression's
    // too; a chip's value, typed or derived, is stored as it stands.
    const derived = holeStepSizes(
      numbers?.diameter ??
        (typeof values.diameter === 'number' ? values.diameter : 6)
    );
    const step = (id: keyof typeof derived) => text(values[id], derived[id]);
    return {
      tool: 'modeling',
      state: {
        operation: 'hole',
        value: {
          name: 'Hole',
          targetBodyId: face.bodyId,
          faceHash: face.hash,
          style: (options.style ?? 'simple') as
            'simple' | 'counterbore' | 'countersink',
          diameter: text(values.diameter, 6),
          depthMode: (options.depthMode ?? 'through') as 'blind' | 'through',
          depth: text(values.depth, 10),
          counterboreDiameter: step('counterboreDiameter'),
          counterboreDepth: step('counterboreDepth'),
          countersinkDiameter: step('countersinkDiameter'),
          countersinkAngleDeg: text(values.countersinkAngleDeg, 90),
          position: position ?? { u: '0', v: '0' }
        }
      }
    };
  },
  handles(slots, values, _ctx, options) {
    const face = slots.faces[0];
    const entry = face ? faceAnchor(face) : null;
    if (!face || !entry || !face.normal) return [];
    const axes = holePositionAxes(face.normal);
    if (!axes) return [];
    const key = `${faceKey(face)}:${entry.x}:${entry.y}:${entry.z}`;
    const handles: HandleSpec[] = [
      {
        valueId: 'diameter',
        kind: 'linear',
        key: `${key}:diameter`,
        // A diameter's handle sits on the circle, at its radius.
        params: { origin: entry, direction: axes.u, scale: 0.5 }
      }
    ];
    if (options.depthMode === 'blind') {
      handles.push({
        valueId: 'depth',
        kind: 'linear',
        key: `${key}:depth`,
        params: { origin: entry, direction: scaled(unit(face.normal), -1) }
      });
    }
    const style = options.style;
    if (style === 'counterbore' || style === 'countersink') {
      // Two chips across the step's rim, clear of the diameter handle: its
      // size on one side, its depth or angle on the other.
      const ids =
        style === 'counterbore'
          ? (['counterboreDiameter', 'counterboreDepth'] as const)
          : (['countersinkDiameter', 'countersinkAngleDeg'] as const);
      const rim = Math.max((values[ids[0]] ?? 0) / 2, 0);
      const at = (side: 1 | -1): Vector3 => ({
        x: entry.x + axes.v.x * rim * side,
        y: entry.y + axes.v.y * rim * side,
        z: entry.z + axes.v.z * rim * side
      });
      handles.push(
        {
          valueId: ids[0],
          kind: 'chip',
          key: `${key}:${ids[0]}`,
          params: { anchor: at(1) }
        },
        {
          valueId: ids[1],
          kind: 'chip',
          key: `${key}:${ids[1]}`,
          params: { anchor: at(-1) }
        }
      );
    }
    return handles;
  }
};

/** The card's own step sizes for a bore, rounded as it rounded them. */
function holeStepSizes(diameter: number): {
  counterboreDiameter: number;
  counterboreDepth: number;
  countersinkDiameter: number;
} {
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    counterboreDiameter: round(diameter * 1.8),
    counterboreDepth: round(diameter * 0.5),
    countersinkDiameter: round(diameter * 2)
  };
}

const shell: InPlaceToolSpec = {
  id: 'shell',
  title: 'Shell',
  profileMode: 'none',
  faceMode: 'many',
  wantsAxis: false,
  wantsPath: false,
  values: [
    { id: 'thickness', label: 'Wall', unit: 'length', initial: 2, min: 0.01 }
  ],
  hint(slots) {
    if (slots.faces.length === 0) return 'Click the faces to open';
    return `${slots.faces.length} open · click more, drag the wall · ${FINISH}`;
  },
  ready: (slots) => slots.faces.length > 0,
  request(slots, values) {
    const first = slots.faces[0];
    if (!first) return null;
    return {
      tool: 'modeling',
      state: {
        operation: 'shell',
        value: {
          name: 'Shell',
          targetBodyId: first.bodyId,
          thickness: text(values.thickness, 2),
          openingFaceHashes: slots.faces.map((face) => face.hash)
        }
      }
    };
  },
  // The wall grows into the body, so its handle points inward.
  handles: (slots) => normalHandle('thickness', slots.faces[0], -1)
};

const thicken: InPlaceToolSpec = {
  id: 'thicken',
  title: 'Thicken',
  profileMode: 'none',
  faceMode: 'one',
  wantsAxis: false,
  wantsPath: false,
  values: [{ id: 'thickness', label: 'Thickness', unit: 'length', initial: 2 }],
  hint(slots) {
    if (slots.faces.length === 0) return 'Click the face to thicken';
    return `Drag the thickness (either side) · ${FINISH}`;
  },
  ready: (slots) => slots.faces.length > 0,
  request(slots, values) {
    const face = slots.faces[0];
    if (!face) return null;
    return {
      tool: 'modeling',
      state: {
        operation: 'thicken',
        value: {
          name: 'Thicken',
          targetBodyId: face.bodyId,
          faceHash: face.hash,
          thickness: text(values.thickness, 2)
        }
      }
    };
  },
  handles: (slots) => normalHandle('thickness', slots.faces[0], 1)
};

const solidOffset: InPlaceToolSpec = {
  id: 'solid-offset',
  title: 'Solid offset',
  profileMode: 'none',
  faceMode: 'one',
  wantsAxis: false,
  wantsPath: false,
  values: [
    { id: 'distance', label: 'Offset', unit: 'length', initial: 1, min: 0.01 }
  ],
  hint(slots) {
    if (slots.faces.length === 0) return 'Click any face of the body to offset';
    return `Drag the offset · ${FINISH}`;
  },
  ready: (slots) => slots.faces.length > 0,
  request(slots, values) {
    const face = slots.faces[0];
    if (!face) return null;
    return {
      tool: 'modeling',
      state: {
        operation: 'solid-offset',
        value: {
          name: 'Solid offset',
          targetBodyId: face.bodyId,
          distance: text(values.distance, 1)
        }
      }
    };
  },
  handles: (slots) => normalHandle('distance', slots.faces[0], 1)
};

const PULL_DIRECTIONS: Record<string, Vector3> = {
  '+Z': { x: 0, y: 0, z: 1 },
  '-Z': { x: 0, y: 0, z: -1 },
  '+X': { x: 1, y: 0, z: 0 },
  '-X': { x: -1, y: 0, z: 0 },
  '+Y': { x: 0, y: 1, z: 0 },
  '-Y': { x: 0, y: -1, z: 0 }
};

/**
 * Where a draft hinges: a point on its neutral plane, which stands square to
 * the pull. `base` is the body's far side against the pull (the parting line
 * of a part pulled from a mould), `top` its near side, `point` where the
 * first face was clicked, `origin` the world origin (the card's default).
 */
function draftNeutralPoint(
  choice: string | undefined,
  pull: Vector3,
  face: FacePick,
  ctx: InPlaceContext
): Vector3 {
  if (choice === 'origin') return { x: 0, y: 0, z: 0 };
  if (choice === 'point' && face.point) return face.point;
  const bounds = ctx.bodyBounds?.(face.bodyId);
  if (!bounds) return face.point ?? { x: 0, y: 0, z: 0 };
  const top = choice === 'top';
  // Pulls are along one axis, so one bounding-box side is the extreme.
  const side = (axis: 'x' | 'y' | 'z') => {
    const toward = pull[axis] > 0 !== top;
    return pull[axis] === 0
      ? (bounds.min[axis] + bounds.max[axis]) / 2
      : toward
        ? bounds.min[axis]
        : bounds.max[axis];
  };
  return { x: side('x'), y: side('y'), z: side('z') };
}

const draft: InPlaceToolSpec = {
  id: 'draft',
  title: 'Draft',
  profileMode: 'none',
  faceMode: 'many',
  wantsAxis: false,
  wantsPath: false,
  values: [
    {
      id: 'angle',
      label: 'Draft',
      unit: 'angle',
      initial: 3,
      min: 0.1,
      max: 45
    }
  ],
  options: [
    {
      id: 'pull',
      label: 'Pull',
      choices: Object.keys(PULL_DIRECTIONS).map((value) => ({
        value,
        label: value
      })),
      initial: '+Z'
    },
    {
      id: 'neutral',
      label: 'Hinge',
      choices: [
        { value: 'base', label: 'Base' },
        { value: 'top', label: 'Top' },
        { value: 'point', label: 'Clicked point' },
        { value: 'origin', label: 'Origin' }
      ],
      initial: 'base'
    }
  ],
  hint(slots) {
    if (slots.faces.length === 0) return 'Click the faces to draft';
    const count = slots.faces.length;
    return `${count} ${count === 1 ? 'face' : 'faces'} · tap the angle to type · ${FINISH}`;
  },
  ready: (slots) => slots.faces.length > 0,
  request(slots, values, options, ctx) {
    const first = slots.faces[0];
    if (!first) return null;
    const pull =
      PULL_DIRECTIONS[options.pull ?? '+Z'] ?? PULL_DIRECTIONS['+Z']!;
    const neutral = draftNeutralPoint(options.neutral, pull, first, ctx);
    return {
      tool: 'modeling',
      state: {
        operation: 'draft',
        value: {
          name: 'Draft',
          targetBodyId: first.bodyId,
          faceHashes: slots.faces.map((face) => face.hash),
          pullDirection: {
            x: String(pull.x),
            y: String(pull.y),
            z: String(pull.z)
          },
          neutralPoint: {
            x: String(neutral.x),
            y: String(neutral.y),
            z: String(neutral.z)
          },
          angleDeg: text(values.angle, 3)
        }
      }
    };
  },
  handles(slots) {
    const face = slots.faces[0];
    const anchor = face ? (face.centroid ?? face.center ?? face.point) : null;
    if (!face || !anchor) return [];
    return [
      {
        valueId: 'angle',
        kind: 'chip',
        key: `${faceKey(face)}:angle`,
        params: { anchor }
      }
    ];
  }
};

function centre(body: BodyPick): Vector3 {
  return {
    x: (body.min.x + body.max.x) / 2,
    y: (body.min.y + body.max.y) / 2,
    z: (body.min.z + body.max.z) / 2
  };
}

function bodyKey(body: BodyPick): string {
  return String(body.bodyId);
}

/**
 * Where a picked plane's offset handle stands: on the plane, level with the
 * body's middle, so sliding it reads against the part. Null for a datum
 * plane, which its feature names by id and does not offset.
 */
function planeHandleOrigin(
  plane: PlanePick,
  body: BodyPick | undefined
): Vector3 | null {
  if (plane.kind === 'datum') return null;
  const normal = unit(plane.normal);
  const middle = body ? centre(body) : plane.origin;
  const apart = dot(
    {
      x: middle.x - plane.origin.x,
      y: middle.y - plane.origin.y,
      z: middle.z - plane.origin.z
    },
    normal
  );
  return {
    x: middle.x - normal.x * apart,
    y: middle.y - normal.y * apart,
    z: middle.z - normal.z * apart
  };
}

/** The plane handle every plane-taking tool shares. */
function planeHandles(slots: InPlaceSlots): HandleSpec[] {
  const plane = slots.plane;
  const body = slots.bodies[0];
  if (!plane || plane.kind === 'datum' || !body) return [];
  const origin = planeHandleOrigin(plane, body);
  if (!origin) return [];
  return [
    {
      valueId: 'offset',
      kind: 'linear',
      key: `${bodyKey(body)}:${plane.kind}:${plane.origin.x}:${plane.origin.y}:${plane.origin.z}:${plane.normal.x}:${plane.normal.y}:${plane.normal.z}`,
      params: { origin, direction: unit(plane.normal) }
    }
  ];
}

/** The picked plane, slid `offset` along its normal. */
function offsetPlane(plane: PlanePick, offset: number): PlanePick {
  if (plane.kind === 'datum' || offset === 0) return plane;
  const normal = unit(plane.normal);
  return {
    ...plane,
    origin: {
      x: plane.origin.x + normal.x * offset,
      y: plane.origin.y + normal.y * offset,
      z: plane.origin.z + normal.z * offset
    }
  };
}

/**
 * A picked plane slid `offset` along its normal, as the card's plane fields.
 * A typed expression stays an expression in each coordinate it moves.
 */
function offsetPlaneFields(
  plane: PlanePick,
  offset: ParamValue | undefined
): ReturnType<typeof planeFields> {
  if (offset === undefined || typeof offset === 'number') {
    return planeFields(offsetPlane(plane, offset ?? 0));
  }
  if (plane.kind === 'datum') return planeFields(plane);
  const normal = unit(plane.normal);
  const along = (origin: number, n: number): string => {
    if (Math.abs(n) < 1e-12) return String(origin);
    const term =
      Math.abs(n - 1) < 1e-12
        ? `(${offset})`
        : Math.abs(n + 1) < 1e-12
          ? `-(${offset})`
          : `(${offset}) * ${n}`;
    return origin === 0 ? term : `${origin} + ${term}`;
  };
  return {
    ...planeFields(plane),
    origin: {
      x: along(plane.origin.x, normal.x),
      y: along(plane.origin.y, normal.y),
      z: along(plane.origin.z, normal.z)
    }
  };
}

const PLANE_OFFSET: ValueSpec = {
  id: 'offset',
  label: 'Offset',
  unit: 'length',
  initial: 0
};

/** The card's plane fields for a picked plane. */
function planeFields(plane: PlanePick): {
  origin: { x: string; y: string; z: string };
  normal: { x: string; y: string; z: string };
  datumFeatureId?: FeatureId;
} {
  const strings = (v: Vector3) => ({
    x: String(v.x),
    y: String(v.y),
    z: String(v.z)
  });
  if (plane.kind === 'datum') {
    return {
      origin: { x: '0', y: '0', z: '0' },
      normal: { x: '0', y: '0', z: '1' },
      datumFeatureId: plane.featureId
    };
  }
  return { origin: strings(plane.origin), normal: strings(plane.normal) };
}

function planeHint(slots: InPlaceSlots, what: string): string | null {
  if (slots.bodies.length === 0) return `Click the body to ${what}`;
  if (!slots.plane) {
    return 'Pick the plane: a ghost plane, a datum plane or a flat face';
  }
  return null;
}

const mirror: InPlaceToolSpec = {
  id: 'mirror',
  title: 'Mirror',
  profileMode: 'none',
  bodyMode: 'one',
  wantsPlane: true,
  wantsAxis: false,
  wantsPath: false,
  values: [PLANE_OFFSET],
  hint: (slots) =>
    planeHint(slots, 'mirror') ??
    `Slide the plane, or pick another · ${FINISH}`,
  ready: (slots) => slots.bodies.length > 0 && slots.plane !== null,
  request(slots, values) {
    const body = slots.bodies[0];
    if (!body || !slots.plane) return null;
    const fields = offsetPlaneFields(slots.plane, values.offset);
    return {
      tool: 'modeling',
      state: {
        operation: 'mirror',
        value: {
          name: 'Mirror',
          targetBodyId: body.bodyId,
          ...fields
        }
      }
    };
  },
  handles: planeHandles
};

const split: InPlaceToolSpec = {
  id: 'split',
  title: 'Split',
  profileMode: 'none',
  bodyMode: 'one',
  wantsPlane: true,
  wantsAxis: false,
  wantsPath: false,
  values: [PLANE_OFFSET],
  options: [
    {
      id: 'keepOriginal',
      label: 'Original',
      choices: [
        { value: 'no', label: 'Replace' },
        { value: 'yes', label: 'Keep' }
      ],
      initial: 'no'
    }
  ],
  hint: (slots) =>
    planeHint(slots, 'split') ?? `Slide the plane, or pick another · ${FINISH}`,
  ready: (slots) => slots.bodies.length > 0 && slots.plane !== null,
  request(slots, values, options) {
    const body = slots.bodies[0];
    if (!body || !slots.plane) return null;
    const fields = offsetPlaneFields(slots.plane, values.offset);
    return {
      tool: 'modeling',
      state: {
        operation: 'split',
        value: {
          name: 'Split',
          targetBodyId: body.bodyId,
          ...fields,
          ...(options.keepOriginal === 'yes' ? { keepOriginal: true } : {})
        }
      }
    };
  },
  handles: planeHandles
};

const COPY_OPTION: OptionSpec = {
  id: 'copy',
  label: 'Result',
  choices: [
    { value: 'no', label: 'Move it' },
    { value: 'yes', label: 'Copy' }
  ],
  initial: 'no'
};

const scale: InPlaceToolSpec = {
  id: 'scale',
  title: 'Scale',
  profileMode: 'none',
  bodyMode: 'one',
  wantsAxis: false,
  wantsPath: false,
  values: [
    { id: 'factor', label: '×', unit: 'count', initial: 1, min: 0.01, max: 100 }
  ],
  options: [COPY_OPTION],
  hint: (slots) =>
    slots.bodies.length === 0
      ? 'Click the body to scale'
      : `Drag the corner handle, or tap × to type · ${FINISH}`,
  ready: (slots) => slots.bodies.length > 0,
  request(slots, values, options) {
    const body = slots.bodies[0];
    if (!body) return null;
    // About the body's own centre, not the world origin, so it grows in
    // place rather than drifting away.
    const pivot = centre(body);
    return {
      tool: 'transform',
      targetBodyId: body.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      scale: values.factor ?? 1,
      pivot,
      ...(options.copy === 'yes' ? { copy: true } : {})
    };
  },
  handles(slots) {
    const body = slots.bodies[0];
    if (!body) return [];
    const origin = centre(body);
    const corner = {
      x: body.max.x - origin.x,
      y: body.max.y - origin.y,
      z: body.max.z - origin.z
    };
    const reach = Math.hypot(corner.x, corner.y, corner.z);
    if (reach <= 1e-9) return [];
    return [
      {
        valueId: 'factor',
        kind: 'linear',
        key: `${bodyKey(body)}:factor`,
        // One unit of value is the centre-to-corner reach: 1 sits on the
        // corner, 2 twice as far out.
        params: { origin, direction: unit(corner), scale: reach }
      }
    ];
  }
};

const axisRotate: InPlaceToolSpec = {
  id: 'axis-rotate',
  title: 'Rotate about axis',
  featureName: 'Rotate',
  profileMode: 'none',
  bodyMode: 'one',
  wantsAxis: true,
  axisSource: 'datum',
  wantsPath: false,
  values: [
    {
      id: 'angle',
      label: 'Angle',
      unit: 'angle',
      initial: 90,
      // Signed: a negative angle turns the body the other way about the
      // axis, as the Transform card allowed.
      min: -360,
      max: 360
    }
  ],
  options: [COPY_OPTION],
  hint(slots) {
    if (slots.bodies.length === 0) return 'Click the body to rotate';
    if (!slots.axis) return 'Pick a datum axis to turn about';
    return `Drag the angle, or type a value · ${FINISH}`;
  },
  ready: (slots) => slots.bodies.length > 0 && slots.axis !== null,
  request(slots, values, options) {
    const body = slots.bodies[0];
    const axis = slots.axis;
    if (!body || !axis || !('datumFeatureId' in axis.choice)) return null;
    return {
      tool: 'transform',
      targetBodyId: body.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      axisRotation: {
        axis: {
          type: 'datum-axis',
          datumFeatureId: axis.choice.datumFeatureId
        },
        angleDeg: values.angle ?? 90
      },
      ...(options.copy === 'yes' ? { copy: true } : {})
    };
  },
  handles(slots) {
    const body = slots.bodies[0];
    if (!body || !slots.axis) return [];
    const placement = revolveRigPlacement(
      [body.min, body.max, centre(body)],
      slots.axis
    );
    if (!placement) return [];
    return [
      {
        valueId: 'angle',
        kind: 'angle',
        key: `${bodyKey(body)}:${slots.axis.id}`,
        params: placement
      }
    ];
  }
};

function booleanSpec(
  id: 'union' | 'subtract' | 'intersect',
  title: string
): InPlaceToolSpec {
  return {
    id,
    title,
    profileMode: 'none',
    bodyMode: 'many',
    wantsAxis: false,
    wantsPath: false,
    values: [],
    options: [
      {
        id: 'keepOriginals',
        label: 'Keep',
        choices: [
          { value: 'none', label: 'None' },
          { value: 'target', label: 'First' },
          { value: 'tools', label: 'Others' },
          { value: 'all', label: 'All' }
        ],
        initial: 'none'
      }
    ],
    hint(slots) {
      if (slots.bodies.length === 0) {
        return id === 'subtract'
          ? 'Click the body to cut from'
          : 'Click the first body';
      }
      if (slots.bodies.length === 1) {
        return id === 'subtract'
          ? 'Click the bodies to cut away'
          : 'Click the next body';
      }
      return `${slots.bodies.length} bodies · click more, or ${FINISH}`;
    },
    ready: (slots) => slots.bodies.length >= 2,
    request(slots, _values, options) {
      if (slots.bodies.length < 2) return null;
      const keep = options.keepOriginals;
      return {
        tool: 'boolean',
        operation: id,
        targetBodyIds: slots.bodies.map((body) => body.bodyId),
        ...(keep && keep !== 'none'
          ? { keepOriginals: keep as BooleanKeepOriginals }
          : {})
      };
    },
    handles: () => []
  };
}

const AXIS_OPTION = (
  initial: 'x' | 'y' | 'z',
  id = 'axis',
  label = 'Along'
): OptionSpec => ({
  id,
  label,
  choices: [
    { value: 'x', label: 'X' },
    { value: 'y', label: 'Y' },
    { value: 'z', label: 'Z' }
  ],
  initial
});

const AXIS_VECTORS: Record<string, Vector3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 }
};

function axisOf(value: string | undefined): 'x' | 'y' | 'z' {
  return value === 'y' || value === 'z' ? value : 'x';
}

const linearPattern: InPlaceToolSpec = {
  id: 'linear-pattern',
  title: 'Linear pattern',
  profileMode: 'none',
  bodyMode: 'one',
  wantsAxis: false,
  wantsPath: false,
  values: [
    // Signed: a negative spacing repeats the other way, as the card allowed.
    // Zero is the kernel's to refuse, in the bar.
    { id: 'spacing', label: 'Spacing', unit: 'length', initial: 20 },
    {
      id: 'count',
      label: 'Count',
      unit: 'count',
      initial: 3,
      min: 2,
      max: 100,
      integer: true
    }
  ],
  options: [AXIS_OPTION('x')],
  hint: (slots) =>
    slots.bodies.length === 0
      ? 'Click the body to repeat'
      : `Drag the spacing, tap the count · ${FINISH}`,
  ready: (slots) => slots.bodies.length > 0,
  request(slots, values, options) {
    const body = slots.bodies[0];
    if (!body) return null;
    return {
      tool: 'pattern',
      targetBodyId: body.bodyId,
      patternKind: 'linear',
      count: values.count ?? 3,
      axis: axisOf(options.axis),
      spacing: values.spacing ?? 20
    };
  },
  handles(slots, _values, _ctx, options) {
    const body = slots.bodies[0];
    if (!body) return [];
    const axis = axisOf(options.axis);
    const origin = centre(body);
    return [
      {
        valueId: 'spacing',
        kind: 'linear',
        key: `${bodyKey(body)}:spacing:${axis}`,
        params: { origin, direction: AXIS_VECTORS[axis]! }
      },
      {
        valueId: 'count',
        kind: 'chip',
        key: `${bodyKey(body)}:count`,
        params: { anchor: { x: origin.x, y: origin.y, z: body.max.z } }
      }
    ];
  }
};

const circularPattern: InPlaceToolSpec = {
  id: 'circular-pattern',
  title: 'Circular pattern',
  profileMode: 'none',
  bodyMode: 'one',
  wantsAxis: true,
  axisSource: 'world',
  wantsPath: false,
  values: [
    {
      id: 'angle',
      label: 'Total',
      unit: 'angle',
      initial: 360,
      // Signed: a negative total turns the copies the other way.
      min: -360,
      max: 360
    },
    {
      id: 'count',
      label: 'Count',
      unit: 'count',
      initial: 6,
      min: 2,
      max: 100,
      integer: true
    }
  ],
  hint(slots) {
    if (slots.bodies.length === 0) return 'Click the body to repeat';
    if (!slots.axis)
      return 'Pick the axis to repeat about: X, Y, Z or a datum axis';
    return `Drag the total angle, tap the count · ${FINISH}`;
  },
  ready: (slots) => slots.bodies.length > 0 && slots.axis !== null,
  request(slots, values) {
    const body = slots.bodies[0];
    const choice = slots.axis?.choice;
    if (!body || !choice) return null;
    return {
      tool: 'pattern',
      targetBodyId: body.bodyId,
      patternKind: 'circular',
      count: values.count ?? 6,
      // A datum axis replaces the world axis the card stores beside it.
      axis: 'world' in choice ? choice.world : 'z',
      ...('datumFeatureId' in choice
        ? {
            axisRef: {
              type: 'datum-axis' as const,
              datumFeatureId: choice.datumFeatureId
            }
          }
        : {}),
      angleDeg: values.angle ?? 360
    };
  },
  handles(slots) {
    const body = slots.bodies[0];
    if (!body || !slots.axis) return [];
    const placement = revolveRigPlacement(
      [body.min, body.max, centre(body)],
      slots.axis
    );
    if (!placement) return [];
    return [
      {
        valueId: 'angle',
        kind: 'angle',
        key: `${bodyKey(body)}:angle:${slots.axis.id}`,
        params: placement
      },
      {
        valueId: 'count',
        kind: 'chip',
        key: `${bodyKey(body)}:count`,
        params: { anchor: centre(body) }
      }
    ];
  }
};

const gridPattern: InPlaceToolSpec = {
  id: 'grid-pattern',
  title: 'Grid pattern',
  profileMode: 'none',
  bodyMode: 'one',
  wantsAxis: false,
  wantsPath: false,
  values: [
    { id: 'spacing', label: 'Spacing', unit: 'length', initial: 20 },
    {
      id: 'count',
      label: 'Count',
      unit: 'count',
      initial: 3,
      min: 2,
      max: 100,
      integer: true
    },
    {
      id: 'spacing2',
      label: 'Spacing 2',
      unit: 'length',
      initial: 20
    },
    {
      id: 'count2',
      label: 'Count 2',
      unit: 'count',
      initial: 3,
      min: 2,
      max: 100,
      integer: true
    }
  ],
  options: [
    { ...AXIS_OPTION('x'), distinctFrom: 'axis2' },
    { ...AXIS_OPTION('y', 'axis2', 'Then along'), distinctFrom: 'axis' }
  ],
  hint: (slots) =>
    slots.bodies.length === 0
      ? 'Click the body to repeat'
      : `Drag both spacings, tap the counts · ${FINISH}`,
  ready: (slots) => slots.bodies.length > 0,
  request(slots, values, options) {
    const body = slots.bodies[0];
    if (!body) return null;
    return {
      tool: 'pattern',
      targetBodyId: body.bodyId,
      patternKind: 'grid',
      count: values.count ?? 3,
      axis: axisOf(options.axis),
      spacing: values.spacing ?? 20,
      axis2: axisOf(options.axis2 ?? 'y'),
      spacing2: values.spacing2 ?? 20,
      count2: values.count2 ?? 3
    };
  },
  handles(slots, _values, _ctx, options) {
    const body = slots.bodies[0];
    if (!body) return [];
    const first = axisOf(options.axis);
    const second = axisOf(options.axis2 ?? 'y');
    const origin = centre(body);
    return [
      {
        valueId: 'spacing',
        kind: 'linear',
        key: `${bodyKey(body)}:spacing:${first}`,
        params: { origin, direction: AXIS_VECTORS[first]! }
      },
      {
        valueId: 'spacing2',
        kind: 'linear',
        key: `${bodyKey(body)}:spacing2:${second}`,
        params: { origin, direction: AXIS_VECTORS[second]! }
      },
      {
        valueId: 'count',
        kind: 'chip',
        key: `${bodyKey(body)}:count`,
        params: { anchor: body.max }
      },
      {
        valueId: 'count2',
        kind: 'chip',
        key: `${bodyKey(body)}:count2`,
        params: { anchor: body.min }
      }
    ];
  }
};

export const IN_PLACE_TOOL_SPECS: Record<InPlaceToolId, InPlaceToolSpec> = {
  revolve,
  loft,
  sweep,
  'helical-sweep': helicalSweep,
  hole,
  shell,
  thicken,
  'solid-offset': solidOffset,
  draft,
  mirror,
  split,
  scale,
  'axis-rotate': axisRotate,
  union: booleanSpec('union', 'Union'),
  subtract: booleanSpec('subtract', 'Subtract'),
  intersect: booleanSpec('intersect', 'Intersect'),
  'linear-pattern': linearPattern,
  'circular-pattern': circularPattern,
  'grid-pattern': gridPattern
};

/** Values a value spec accepts: clamped to its range, finite. */
export function clampValue(spec: ValueSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.initial;
  const whole = spec.integer ? Math.round(value) : value;
  return Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, whole));
}
