import type { PlaneBasis } from '@openzcad/geometry';
import {
  MAX_HELICAL_SWEEP_TURNS,
  type BodyId,
  type BooleanKeepOriginals,
  type BooleanOperation,
  type DatumAxisDefinition,
  type DatumAxisLine,
  type FaceTopologyReferenceV5,
  type FeatureData,
  type DatumPlaneDefinition,
  type FeatureId,
  type ParamValue,
  type ParametricVector3,
  type ReferenceImage,
  type ReferenceImagePlane,
  type RevolveAxis,
  type SketchId,
  type SketchProfileReference,
  type SketchSectionReference,
  type Vector3
} from '@openzcad/shared';
import {
  revolveAxisCandidates,
  revolveProfileRegions,
  revolveRigPlacement,
  type RevolveAxisCandidate,
  type RevolveRigPlacement
} from './revolve';
import type { ModelingOperationFormState } from '../modelingOperations';
import { holePositionAxes, holePositionFromPick } from '../holePositionAxes';
import { datumAxis, datumPlane, type RefKind, type RefPick } from './datums';
import { referenceImage, type ImageSlot } from './image';

export type { RefPick } from './datums';
export type { ImagePlacement, ImageSlot } from './image';

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
  | 'grid-pattern'
  | 'datum-plane'
  | 'datum-axis'
  | 'reference-image';

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
  'grid-pattern',
  'datum-plane',
  'datum-axis',
  'reference-image'
];

export function isInPlaceTool(tool: string): tool is InPlaceToolId {
  return (IN_PLACE_TOOLS as readonly string[]).includes(tool);
}

/** A picked region: its sketch, its stored reference, and which cell. */
export interface ProfilePick {
  sketchId: SketchId;
  reference: SketchProfileReference;
  regionFingerprint: number;
  /**
   * An edited revolve that stores no profile (its sketch's first object, as
   * before profiles were stored): kept that way until another is picked.
   */
  implicit?: true;
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
  /**
   * `point` is where an edited hole already stands, not a click: its stored
   * position is kept, expressions and all, until the face is clicked again.
   */
  savedPosition?: true;
  /**
   * The lineage reference an edit found a stored face by, so a later
   * re-check finds it the same way when its hash moves.
   */
  reference?: FaceTopologyReferenceV5;
}

/** A picked body, with the box its handles are placed from. */
export interface BodyPick {
  bodyId: BodyId;
  min: Vector3;
  max: Vector3;
  /**
   * A later direct edit reshapes this body (one an edit was retargeted
   * to): its box is only approximate, as `InPlaceContext.reshapedLater`.
   */
  reshapedLater?: true;
}

/** The text of a plane's stored fields, expressions as written. */
export interface PlaneFieldsText {
  origin: { x: string; y: string; z: string };
  normal: { x: string; y: string; z: string };
}

/** A plane to mirror or split across. */
export type PlanePick =
  | { kind: 'principal'; plane: string; origin: Vector3; normal: Vector3 }
  | { kind: 'face'; origin: Vector3; normal: Vector3 }
  | { kind: 'datum'; featureId: FeatureId }
  /** An edited feature's own plane, stored back as written until slid. */
  | {
      kind: 'saved';
      origin: Vector3;
      normal: Vector3;
      fields: PlaneFieldsText;
    };

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
  /** A datum's sources, in pick order: planes, edge ends, an edge, a face. */
  refs: RefPick[];
  /** The picture an Image command is placing. */
  image: ImageSlot | null;
}

/** A choice too rare for a handle: it lives in the bar's Options menu. */
export interface OptionSpec {
  id: string;
  label: string;
  /** A choice's `note` explains it under the row while it is chosen. */
  choices: readonly { value: string; label: string; note?: string }[];
  initial: string;
  /**
   * Another option this one may never equal (a grid's two directions):
   * choosing that option's value swaps the two instead.
   */
  distinctFrom?: string;
  /**
   * Its values are tool ids that share this tool's slots (a boolean's
   * operation): choosing one switches the command to that tool.
   */
  switchesTool?: boolean;
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
  /**
   * `min` and `max` are themselves refused (a countersink's angle, strictly
   * between 0° and 180°): a value is kept just inside them. `'min'` refuses
   * only `min` (a revolve: more than 0°, up to 360°).
   */
  exclusive?: boolean | 'min';
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
  /**
   * An edited body's box is only approximate (a later direct edit reshapes
   * it): handles measured from it are typed chips instead.
   */
  reshapedLater?: boolean;
  sketchViews: readonly InPlaceSketchView[];
  datumAxes: Record<FeatureId, DatumAxisLine> | undefined;
  datumLabel(featureId: FeatureId): string;
  /** The linear snap a clicked position rounds to; null when snapping is off. */
  linearSnap?: number | null;
  /** A body's bounding box, for references measured on it (a draft's base). */
  bodyBounds?(bodyId: BodyId): { min: Vector3; max: Vector3 } | null;
  /**
   * The stored data of the feature being edited, for whatever the command
   * keeps as stored rather than showing (a hole's position until it is
   * clicked again, a draft's typed pull direction). Absent when creating.
   */
  saved?: FeatureData;
  /** A stored value as a number, or null when it does not resolve. */
  evaluate?(value: ParamValue): number | null;
  /** The values the user has set (typed or dragged) in this session. */
  touched?: readonly string[];
  /** Where a reference image's plane lies now; null while it is unresolved. */
  imagePlaneBasis?(plane: ReferenceImagePlane): PlaneBasis | null;
}

/** What to build, without names or ids; App turns it into the command. */
export type InPlaceRequest =
  | {
      tool: 'revolve';
      sketchId: SketchId;
      /** Absent only for an edited revolve that never stored one. */
      profile?: SketchProfileReference;
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
      /** A linear pattern's own repeat vector, replacing `axis`. */
      direction?: ParametricVector3;
    }
  | { tool: 'datum-plane'; definition: DatumPlaneDefinition }
  | { tool: 'datum-axis'; definition: DatumAxisDefinition }
  | {
      /** The picture as Done adds it: placed, scaled, turned. */
      tool: 'reference-image';
      image: ReferenceImage;
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
  /** The datum sources its picks may be, and how a pick joins the others. */
  refKinds?: readonly RefKind[];
  takeRef?(refs: readonly RefPick[], ref: RefPick): RefPick[];
  /**
   * Nothing for the kernel to build (a reference image): the request is
   * drawn as it stands, and Done adds it once it is ready.
   */
  instant?: boolean;
  /**
   * Values read from and written into others rather than held: a picture's
   * real distance between two picks is its width, measured. `write` returns
   * the values to set, or null to refuse the value.
   */
  linked?: Record<
    string,
    {
      read(slots: InPlaceSlots, numbers: Record<string, number>): number | null;
      write(
        slots: InPlaceSlots,
        numbers: Record<string, number>,
        value: number
      ): Record<string, number> | null;
    }
  >;
  /**
   * Where its axis lines come from: the profile's sketch, datum axes, or the
   * world axes through the origin as well as datum axes.
   */
  axisSource?: 'sketch' | 'datum' | 'world';
  faceFilter?: 'planar';
  /**
   * While this option has this value, a click places a point (a draft's
   * clicked hinge): a picked face clicked again keeps its place in the set
   * and takes the point, rather than coming back out, and only the latest
   * click carries one.
   */
  clickPlacesPoint?: { optionId: string; value: string };
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
  hint(
    slots: InPlaceSlots,
    options?: Record<string, string>,
    ctx?: InPlaceContext
  ): string;
  /**
   * Whether the picks (and, for a typed plane or axis, the options) suffice.
   * `ctx` lets a slot that names a plane require it to have resolved.
   */
  ready(
    slots: InPlaceSlots,
    options?: Record<string, string>,
    ctx?: InPlaceContext
  ): boolean;
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
  // Found again by its entities when an undo or redo renumbered it. An
  // implicit pick (a revolve stored before profiles) builds the sketch's
  // first object only, so only that region places its handles: the one
  // seeded, else the sketch's first as it is now (hidden when seeded, or
  // renumbered since).
  const regions = pick.implicit
    ? (() => {
        const seeded = view.regions.filter(
          (region) => region.regionFingerprint === pick.regionFingerprint
        );
        return seeded.length > 0 ? seeded : view.regions.slice(0, 1);
      })()
    : revolveProfileRegions(view.regions, pick);
  return regions.flatMap((region) =>
    region.outer.map((point) => toWorld(view.basis, point))
  );
}

/** The axes a profile's sketch offers: its own two, and in-plane datums. */
export function axisCandidatesFor(
  slots: InPlaceSlots,
  ctx: InPlaceContext,
  source: 'sketch' | 'datum' | 'world' = 'sketch',
  keep?: string | null
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
    ? revolveAxisCandidates(view.basis, ctx.datumAxes, ctx.datumLabel, keep)
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
      // Every angle the stored feature takes: more than 0°, up to a turn.
      min: 0,
      exclusive: 'min',
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
    if (!pick || !choice || 'world' in choice || 'saved' in choice) {
      return null;
    }
    const angle = values.angle ?? 360;
    return {
      tool: 'revolve',
      sketchId: pick.sketchId,
      // An edited revolve that stores no profile keeps none.
      ...(pick.implicit ? {} : { profile: pick.reference }),
      axis: choice,
      ...(angle === 360 ? {} : { angleDeg: angle })
    };
  },
  handles(slots, _values, ctx) {
    const pick = slots.profiles[0];
    if (!pick || !slots.axis) return [];
    const outline = profileOutline(ctx, pick);
    const placement = profileTurnRig(outline, slots.axis);
    if (!placement) {
      // A profile with nothing off its axis has no rig: its angle is typed.
      return [
        {
          valueId: 'angle',
          kind: 'chip',
          key: keyOf(pick.sketchId, pick.regionFingerprint, slots.axis.id),
          params: { anchor: outline[0] ?? slots.axis.origin }
        }
      ];
    }
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
    { id: 'apex', label: 'Apex', unit: 'length', initial: 10 },
    // Or the apex anywhere, as the card's X, Y and Z fields placed it.
    { id: 'apexX', label: 'X', unit: 'length', initial: 0 },
    { id: 'apexY', label: 'Y', unit: 'length', initial: 0 },
    { id: 'apexZ', label: 'Z', unit: 'length', initial: 0 }
  ],
  options: [
    {
      id: 'end',
      label: 'Ends',
      choices: [
        { value: 'section', label: 'On the last section' },
        { value: 'apex', label: 'At an apex point' },
        { value: 'point', label: 'At a point (X, Y, Z)' }
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
  // A point apex not yet set starts where the apex off the last section
  // stands.
  defaults(slots, ctx, numbers): Record<string, number> {
    const apex = loftApex(slots, ctx, numbers.apex ?? 10);
    return apex
      ? { apexX: apex.point.x, apexY: apex.point.y, apexZ: apex.point.z }
      : {};
  },
  ready: (slots) => slots.profiles.length >= 2,
  request(slots, values, options, ctx, numbers) {
    if (slots.profiles.length < 2) return null;
    const apex =
      options.end === 'apex' ? loftApex(slots, ctx, numbers?.apex ?? 10) : null;
    // A point apex is stored as given, expressions and all.
    const point =
      options.end === 'point'
        ? {
            x: values.apexX ?? 0,
            y: values.apexY ?? 0,
            z: values.apexZ ?? 0
          }
        : undefined;
    return {
      tool: 'loft',
      sections: slots.profiles.map(section),
      mode: options.shape === 'smooth' ? 'smooth' : 'ruled',
      ...(point
        ? { endPoint: point }
        : apex
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
  handles(slots, values, ctx, options) {
    const last = slots.profiles.at(-1);
    if (options.end === 'point' && last) {
      // Typed, each on its chip by the point (spread so none hides
      // another), as the card's three fields were.
      const point = {
        x: values.apexX ?? 0,
        y: values.apexY ?? 0,
        z: values.apexZ ?? 0
      };
      const spread = Math.max(profileSpan(ctx, last) / 4, 1e-3);
      return (['apexX', 'apexY', 'apexZ'] as const).map((valueId, index) => ({
        valueId,
        kind: 'chip' as const,
        key: `${last.sketchId}:${last.regionFingerprint}:${valueId}`,
        params: {
          anchor: {
            x: point.x + (index - 1) * spread,
            y: point.y,
            z: point.z + spread
          }
        }
      }));
    }
    if (options.end !== 'apex') return [];
    const apex = loftApex(slots, ctx, 0);
    if (!apex || !last) return [];
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

/** The widest extent of a picked section's outline. */
function profileSpan(ctx: InPlaceContext, pick: ProfilePick): number {
  const outline = profileOutline(ctx, pick);
  if (outline.length === 0) return 0;
  const extent = (axis: 'x' | 'y' | 'z') =>
    Math.max(...outline.map((point) => point[axis])) -
    Math.min(...outline.map((point) => point[axis]));
  return Math.max(extent('x'), extent('y'), extent('z'));
}

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
        {
          value: 'smooth',
          label: 'Smooth',
          // The card's own explanation, so Smooth is not taken for exact.
          note: 'Smooth samples a path of one line, or one arc of up to a quarter turn, more finely. It does not make exact curved surfaces, and a longer path builds the same body as Standard.'
        }
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
        {
          value: 'guide',
          label: 'Guide rail',
          note: 'The profile turns to keep facing the rail instead of holding a rotation-minimizing frame. Both the path and the rail must be one curve: a line, or an arc of at most a quarter turn.'
        }
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

/** Choose between a picked axis and one typed by its origin and direction. */
const AXIS_MODE_OPTION: OptionSpec = {
  id: 'axisMode',
  label: 'Axis',
  choices: [
    { value: 'picked', label: 'A picked axis' },
    { value: 'typed', label: 'Typed (origin and direction)' }
  ],
  initial: 'picked'
};

const TYPED_AXIS_VALUES: ValueSpec[] = [
  ...vectorValues('axisO', 'length', { x: 0, y: 0, z: 0 }),
  ...vectorValues('axisD', 'count', { x: 0, y: 0, z: 1 })
];

const helicalSweep: InPlaceToolSpec = {
  id: 'helical-sweep',
  title: 'Helical sweep',
  profileMode: 'one',
  wantsAxis: true,
  wantsPath: false,
  values: [
    // Ranges here are what the stored feature takes, no narrower: a value
    // made elsewhere (an import, an older card) stays editable.
    {
      id: 'radius',
      label: 'Radius',
      unit: 'length',
      initial: 10,
      min: 0,
      exclusive: true
    },
    { id: 'pitch', label: 'Pitch', unit: 'length', initial: 5 },
    {
      id: 'turns',
      label: 'Turns',
      unit: 'count',
      initial: 3,
      min: 0,
      exclusive: true,
      max: MAX_HELICAL_SWEEP_TURNS
    },
    ...TYPED_AXIS_VALUES
  ],
  options: [AXIS_MODE_OPTION],
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
  hint(slots, options) {
    if (slots.profiles.length === 0) return 'Pick the profile to coil';
    if (options?.axisMode === 'typed') {
      return `Type the axis origin and direction on their chips · ${FINISH}`;
    }
    if (!slots.axis) return 'Pick the helix axis';
    return `Drag radius and pitch, tap turns to type · ${FINISH}`;
  },
  ready: (slots, options) =>
    slots.profiles.length > 0 &&
    (slots.axis !== null || options?.axisMode === 'typed'),
  request(slots, values, options, ctx, numbers) {
    const pick = slots.profiles[0];
    if (!pick) return null;
    if (options.axisMode === 'typed') {
      // A typed axis goes out as typed, expressions and all.
      if (!commandAxis(slots, numbers ?? {}, options)) return null;
      return {
        tool: 'helical-sweep',
        profile: section(pick),
        axisOrigin: typedVector(values, 'axisO', { x: 0, y: 0, z: 0 }),
        axisDirection: typedVector(values, 'axisD', { x: 0, y: 0, z: 1 }),
        radius: values.radius ?? 10,
        pitch: values.pitch ?? 5,
        turns: values.turns ?? 3
      };
    }
    if (!slots.axis) return null;
    const direction = unit(slots.axis.direction);
    // An edited helix's own axis goes back as stored, expressions and all.
    const saved =
      'saved' in slots.axis.choice && ctx.saved?.featureKind === 'helical-sweep'
        ? ctx.saved
        : null;
    return {
      tool: 'helical-sweep',
      profile: section(pick),
      axisOrigin: saved ? { ...saved.axisOrigin } : { ...slots.axis.origin },
      axisDirection: saved ? { ...saved.axisDirection } : { ...direction },
      radius: values.radius ?? 10,
      pitch: values.pitch ?? 5,
      turns: values.turns ?? 3
    };
  },
  handles(slots, values, ctx, options) {
    const pick = slots.profiles[0];
    if (!pick) return [];
    const outline = profileOutline(ctx, pick);
    const chips =
      options.axisMode === 'typed' ? typedAxisChips(pick, outline) : [];
    const axisLine = commandAxis(slots, values, options);
    if (!axisLine) return chips;
    const placement = helixRigPlacement(outline, axisLine);
    if (!placement) return chips;
    const { center, axis, startDirection } = placement;
    const base = keyOf(
      pick.sketchId,
      pick.regionFingerprint,
      axisLine.id === 'typed'
        ? `typed:${[axisLine.origin, axisLine.direction].map((v) => `${v.x},${v.y},${v.z}`).join(':')}`
        : axisLine.id
    );
    const radius = values.radius ?? 10;
    return [
      ...chips,
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

/** The axis a helix coils about: the picked one, or the typed one. */
function commandAxis(
  slots: InPlaceSlots,
  numbers: Record<string, number>,
  options: Record<string, string>
): RevolveAxisCandidate | null {
  if (options.axisMode !== 'typed') return slots.axis;
  const direction = typedNumbers(numbers, 'axisD', { x: 0, y: 0, z: 1 });
  if (Math.hypot(direction.x, direction.y, direction.z) === 0) return null;
  return {
    id: 'typed',
    label: 'Typed axis',
    origin: typedNumbers(numbers, 'axisO', { x: 0, y: 0, z: 0 }),
    direction,
    choice: { saved: true }
  };
}

/** A typed axis's six numbers, each on its chip beside the profile. */
function typedAxisChips(
  pick: ProfilePick,
  outline: readonly Vector3[]
): HandleSpec[] {
  if (outline.length === 0) return [];
  const min = boxOfPoints(outline, Math.min);
  const max = boxOfPoints(outline, Math.max);
  const centre = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: max.z };
  const spread = Math.max((max.x - min.x) / 4, (max.y - min.y) / 4, 1);
  const key = keyOf(pick.sketchId, pick.regionFingerprint, 'axis');
  return [
    ...vectorChips('axisO', key, centre, spread),
    ...vectorChips('axisD', key, { ...centre, z: centre.z + spread }, spread)
  ];
}

function boxOfPoints(
  points: readonly Vector3[],
  pick: (...values: number[]) => number
): Vector3 {
  return {
    x: pick(...points.map((point) => point.x)),
    y: pick(...points.map((point) => point.y)),
    z: pick(...points.map((point) => point.z))
  };
}

/**
 * Where a helix's handles stand: as a revolve's, or — for a profile centred
 * on its axis, which a stored helix may be (its radius then sets it off) —
 * level with the profile, pointing any way square to the axis.
 */
function helixRigPlacement(
  outline: readonly Vector3[],
  axisLine: RevolveAxisCandidate
): { center: Vector3; axis: Vector3; startDirection: Vector3 } | null {
  const placement = revolveRigPlacement(outline, axisLine);
  if (placement) return placement;
  if (outline.length === 0) return null;
  const axis = unit(axisLine.direction);
  const middle = outline.reduce(
    (sum, point) => ({
      x: sum.x + point.x / outline.length,
      y: sum.y + point.y / outline.length,
      z: sum.z + point.z / outline.length
    }),
    { x: 0, y: 0, z: 0 }
  );
  const along = dot(
    {
      x: middle.x - axisLine.origin.x,
      y: middle.y - axisLine.origin.y,
      z: middle.z - axisLine.origin.z
    },
    axis
  );
  const reference =
    Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  return {
    center: {
      x: axisLine.origin.x + axis.x * along,
      y: axisLine.origin.y + axis.y * along,
      z: axisLine.origin.z + axis.z * along
    },
    axis,
    startDirection: unit({
      x: axis.y * reference.z - axis.z * reference.y,
      y: axis.z * reference.x - axis.x * reference.z,
      z: axis.x * reference.y - axis.y * reference.x
    })
  };
}

/**
 * The rig a body turns on about an axis (a turn, a circular pattern). An
 * axis through the body's middle has no side for the rig to start from: it
 * then starts square to the axis, out to the farthest corner. Null only for
 * a body with no extent off the axis.
 */
function bodyTurnRig(
  body: BodyPick,
  axis: RevolveAxisCandidate
): RevolveRigPlacement | null {
  const placement = revolveRigPlacement(
    [body.min, body.max, centre(body)],
    axis
  );
  if (placement) return placement;
  const corners = boxCornersOf(body);
  const centred = helixRigPlacement(corners, axis);
  const reach = Math.max(
    ...corners.map((corner) => radialDistance(corner, axis))
  );
  return centred && reach > 1e-9 ? { ...centred, radius: reach * 1.15 } : null;
}

/**
 * The rig a profile turns on about an axis: as `revolveRigPlacement` places
 * it, or, for a profile whose middle is on the axis (a symmetric pair of
 * regions), square to the axis out to its farthest point.
 */
function profileTurnRig(
  outline: readonly Vector3[],
  axis: RevolveAxisCandidate
): RevolveRigPlacement | null {
  const placement = revolveRigPlacement(outline, axis);
  if (placement) return placement;
  const centred = helixRigPlacement(outline, axis);
  const reach = Math.max(
    0,
    ...outline.map((point) => radialDistance(point, axis))
  );
  return centred && reach > 1e-9 ? { ...centred, radius: reach * 1.15 } : null;
}

/** A box's eight corners. */
function boxCornersOf(box: { min: Vector3; max: Vector3 }): Vector3[] {
  const corners: Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) corners.push({ x, y, z });
    }
  }
  return corners;
}

/** How far a point stands from an axis line. */
function radialDistance(
  point: Vector3,
  axis: Pick<RevolveAxisCandidate, 'origin' | 'direction'>
): number {
  const direction = unit(axis.direction);
  const offset = {
    x: point.x - axis.origin.x,
    y: point.y - axis.origin.y,
    z: point.z - axis.origin.z
  };
  const along = dot(offset, direction);
  return Math.hypot(
    offset.x - direction.x * along,
    offset.y - direction.y * along,
    offset.z - direction.z * along
  );
}

/** A value as the card's text field would hold it. */
function text(value: ParamValue | undefined, fallback: number): string {
  return value === undefined ? String(fallback) : String(value);
}

/** A stored vector as the card's three text fields. */
function vectorText(vector: ParametricVector3): {
  x: string;
  y: string;
  z: string;
} {
  return { x: String(vector.x), y: String(vector.y), z: String(vector.z) };
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
    {
      id: 'diameter',
      label: '⌀',
      unit: 'length',
      initial: 6,
      min: 0,
      exclusive: true
    },
    {
      id: 'depth',
      label: 'Depth',
      unit: 'length',
      initial: 10,
      min: 0,
      exclusive: true
    },
    // The step's sizes, on chips while its style is chosen. Until one is
    // set it follows the bore, as the card's defaults did.
    // Any positive size, as the card's validation takes it (a step's
    // diameter must also clear the bore, which the preview refuses by name).
    {
      id: 'counterboreDiameter',
      label: 'Counterbore ⌀',
      unit: 'length',
      initial: 10.8,
      min: 0,
      exclusive: true
    },
    {
      id: 'counterboreDepth',
      label: 'Counterbore depth',
      unit: 'length',
      initial: 3,
      min: 0,
      exclusive: true
    },
    {
      id: 'countersinkDiameter',
      label: 'Countersink ⌀',
      unit: 'length',
      initial: 12,
      min: 0,
      exclusive: true
    },
    {
      // The full included angle, strictly between 0° and 180°, as the
      // card's validation takes it.
      id: 'countersinkAngleDeg',
      label: 'Countersink angle',
      unit: 'angle',
      initial: 90,
      min: 0,
      max: 180,
      exclusive: true
    },
    // A typed position, measured on the face from its anchor.
    { id: 'positionU', label: 'U', unit: 'length', initial: 0 },
    { id: 'positionV', label: 'V', unit: 'length', initial: 0 }
  ],
  options: [
    {
      id: 'place',
      label: 'Position',
      choices: [
        { value: 'clicked', label: 'Where clicked' },
        { value: 'typed', label: 'Typed (U, V)' }
      ],
      initial: 'clicked'
    },
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
    if (options?.place === 'typed') {
      return `Type its U and V on their chips · drag the diameter${step} · ${FINISH}`;
    }
    return `Click again to move it · drag the diameter${step} · ${FINISH}`;
  },
  ready: (slots) => slots.faces.length > 0,
  request(slots, values, options, ctx, numbers) {
    const face = slots.faces[0];
    if (!face || !face.normal) return null;
    const saved = ctx.saved?.featureKind === 'hole' ? ctx.saved : null;
    // A new hole measures from the face's centroid; an edited one keeps the
    // anchor it was drilled against, which no edit may change.
    const anchor = saved
      ? saved.positionAnchor === 'centroid'
        ? 'centroid'
        : 'center'
      : face.centroid
        ? 'centroid'
        : 'center';
    // Rounded to the sketch snap, exactly as the card placed a clicked hole;
    // a typed one as typed, expressions and all.
    const position =
      options.place === 'typed'
        ? { u: text(values.positionU, 0), v: text(values.positionV, 0) }
        : face.savedPosition && saved
          ? {
              u: String(saved.position.u),
              v: String(saved.position.v)
            }
          : face.point
            ? holePositionFromPick(
                face,
                anchor,
                face.point,
                ctx.linearSnap ?? null
              )
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
  handles(slots, values, ctx, options) {
    const face = slots.faces[0];
    const clicked = face ? faceAnchor(face) : null;
    if (!face || !clicked || !face.normal) return [];
    const axes = holePositionAxes(face.normal);
    if (!axes) return [];
    const typed = options.place === 'typed';
    // A typed hole's handles stand where its U and V put it.
    const entry = typed ? typedHoleEntry(face, axes, values, ctx) : clicked;
    if (!entry) return [];
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
    if (typed) {
      // Its U and V across the hole, clear of the step's chips.
      const reach = Math.max((values.diameter ?? 6) * 1.5, 1e-3);
      for (const [valueId, side] of [
        ['positionU', -1],
        ['positionV', 1]
      ] as const) {
        handles.push({
          valueId,
          kind: 'chip',
          key: `${faceKey(face)}:${valueId}`,
          params: {
            anchor: {
              x: entry.x + axes.u.x * reach * side,
              y: entry.y + axes.u.y * reach * side,
              z: entry.z + axes.u.z * reach * side
            }
          }
        });
      }
    }
    return handles;
  }
};

/** Where a typed U and V put a hole on its face; null with no anchor. */
function typedHoleEntry(
  face: FacePick,
  axes: { u: Vector3; v: Vector3 },
  values: Record<string, number>,
  ctx: InPlaceContext
): Vector3 | null {
  const saved = ctx.saved?.featureKind === 'hole' ? ctx.saved : null;
  // The anchor it is measured from, as the request stores it.
  const anchor = saved
    ? saved.positionAnchor === 'centroid'
      ? (face.centroid ?? face.center)
      : (face.center ?? face.centroid)
    : (face.centroid ?? face.center);
  if (!anchor) return null;
  const u = values.positionU ?? 0;
  const v = values.positionV ?? 0;
  return {
    x: anchor.x + axes.u.x * u + axes.v.x * v,
    y: anchor.y + axes.u.y * u + axes.v.y * v,
    z: anchor.z + axes.u.z * u + axes.v.z * v
  };
}

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
    {
      id: 'thickness',
      label: 'Wall',
      unit: 'length',
      initial: 2,
      min: 0,
      exclusive: true
    }
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
    {
      id: 'distance',
      label: 'Offset',
      unit: 'length',
      initial: 1,
      min: 0,
      exclusive: true
    }
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
  handles(slots, _values, ctx) {
    const face = slots.faces[0];
    const onFace = normalHandle('distance', face, 1);
    if (onFace.length > 0 || !face) return onFace;
    // A curved-only body (a sphere) publishes no face normal: the offset
    // still has a handle, rising from the top of the body's box, since
    // every face moves outward by the same distance.
    const box = ctx.bodyBounds?.(face.bodyId);
    if (!box) return [];
    return [
      {
        valueId: 'distance',
        kind: 'linear',
        key: `${face.bodyId}:distance:box`,
        params: {
          origin: {
            x: (box.min.x + box.max.x) / 2,
            y: (box.min.y + box.max.y) / 2,
            z: box.max.z
          },
          direction: { x: 0, y: 0, z: 1 }
        }
      }
    ];
  }
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

/**
 * The picked face whose click places the hinge: the only one carrying a
 * point while the hinge is clicked (an edited draft's seeded faces carry
 * none).
 */
function clickedFace(slots: InPlaceSlots): FacePick | undefined {
  return slots.faces.find((face) => face.point !== undefined);
}

const draft: InPlaceToolSpec = {
  id: 'draft',
  title: 'Draft',
  profileMode: 'none',
  faceMode: 'many',
  clickPlacesPoint: { optionId: 'neutral', value: 'point' },
  wantsAxis: false,
  wantsPath: false,
  values: [
    {
      id: 'angle',
      label: 'Draft',
      unit: 'angle',
      initial: 3,
      // Either way and up to a right angle, as the kernel takes it: an
      // edited draft keeps the range it was made with.
      min: -90,
      max: 90,
      exclusive: true
    },
    ...vectorValues('pull', 'count', { x: 0, y: 0, z: 1 }),
    ...vectorValues('neutral', 'length', { x: 0, y: 0, z: 0 })
  ],
  options: [
    {
      id: 'pull',
      label: 'Pull',
      choices: [
        ...Object.keys(PULL_DIRECTIONS).map((value) => ({
          value,
          label: value
        })),
        { value: 'custom', label: 'Custom (X, Y, Z)' }
      ],
      initial: '+Z'
    },
    {
      id: 'neutral',
      label: 'Hinge',
      choices: [
        { value: 'base', label: 'Base' },
        { value: 'top', label: 'Top' },
        { value: 'point', label: 'Clicked point' },
        { value: 'origin', label: 'Origin' },
        { value: 'custom', label: 'At a point (X, Y, Z)' }
      ],
      initial: 'base'
    }
  ],
  hint(slots, options) {
    if (slots.faces.length === 0) return 'Click the faces to draft';
    if (options?.neutral === 'point' && !clickedFace(slots)) {
      return 'Click a face where the hinge goes';
    }
    const count = slots.faces.length;
    return `${count} ${count === 1 ? 'face' : 'faces'} · tap the angle to type · ${FINISH}`;
  },
  ready: (slots, options) =>
    slots.faces.length > 0 &&
    // A clicked hinge needs its click: an edited draft's faces carry none.
    (options?.neutral !== 'point' || clickedFace(slots) !== undefined),
  request(slots, values, options, ctx, numbers) {
    const first = slots.faces[0];
    if (!first) return null;
    const clicked = clickedFace(slots);
    if (options.neutral === 'point' && !clicked) return null;
    // A typed pull and hinge go out as typed, expressions and all.
    const customPull = options.pull === 'custom';
    const pull = customPull
      ? typedNumbers(numbers ?? {}, 'pull', { x: 0, y: 0, z: 1 })
      : (PULL_DIRECTIONS[options.pull ?? '+Z'] ?? PULL_DIRECTIONS['+Z']!);
    if (Math.hypot(pull.x, pull.y, pull.z) === 0) return null;
    const neutral = draftNeutralPoint(
      options.neutral,
      pull,
      options.neutral === 'point' && clicked ? clicked : first,
      ctx
    );
    return {
      tool: 'modeling',
      state: {
        operation: 'draft',
        value: {
          name: 'Draft',
          targetBodyId: first.bodyId,
          faceHashes: slots.faces.map((face) => face.hash),
          pullDirection: vectorText(
            customPull ? typedVector(values, 'pull', pull) : pull
          ),
          neutralPoint: vectorText(
            options.neutral === 'custom'
              ? typedVector(values, 'neutral', neutral)
              : neutral
          ),
          angleDeg: text(values.angle, 3)
        }
      }
    };
  },
  handles(slots, _values, ctx, options) {
    const face = slots.faces[0];
    const anchor = face ? (face.centroid ?? face.center ?? face.point) : null;
    if (!face || !anchor) return [];
    // A typed pull's and hinge's numbers, a row of chips each above the
    // angle's.
    const bounds = ctx.bodyBounds?.(face.bodyId);
    const spread = bounds
      ? Math.max((bounds.max.x - bounds.min.x) / 4, 1e-3)
      : 5;
    const row = (index: number) => ({
      ...anchor,
      z: anchor.z + spread * index
    });
    return [
      {
        valueId: 'angle',
        kind: 'chip',
        key: `${faceKey(face)}:angle`,
        params: { anchor }
      },
      ...(options.pull === 'custom'
        ? vectorChips('pull', faceKey(face), row(1), spread)
        : []),
      ...(options.neutral === 'custom'
        ? vectorChips('neutral', faceKey(face), row(2), spread)
        : [])
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
function planeHandles(
  slots: InPlaceSlots,
  values: Record<string, number>,
  _ctx: InPlaceContext,
  options: Record<string, string>
): HandleSpec[] {
  const body = slots.bodies[0];
  const typed = options.planeMode === 'typed';
  // A typed plane's six numbers, each on its chip above the body.
  const chips =
    typed && body
      ? (() => {
          const centre = {
            x: (body.min.x + body.max.x) / 2,
            y: (body.min.y + body.max.y) / 2,
            z: body.max.z
          };
          const spread = Math.max((body.max.x - body.min.x) / 4, 1e-3);
          return [
            ...vectorChips('planeO', bodyKey(body), centre, spread),
            ...vectorChips(
              'planeN',
              bodyKey(body),
              { ...centre, z: centre.z + spread },
              spread
            )
          ];
        })()
      : [];
  const plane = commandPlane(slots, values, values, options);
  if (!plane || plane.kind === 'datum' || !body) return chips;
  const origin = planeHandleOrigin(plane, body);
  if (!origin) return chips;
  return [
    ...chips,
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
  const origin = {
    x: plane.origin.x + normal.x * offset,
    y: plane.origin.y + normal.y * offset,
    z: plane.origin.z + normal.z * offset
  };
  // A slid stored plane is a new plane: its numbers, not its old text.
  return plane.kind === 'principal'
    ? { ...plane, origin }
    : { kind: 'face', origin, normal: plane.normal };
}

/**
 * A picked plane slid `offset` along its normal, as the card's plane fields.
 * A typed offset stays an expression in each coordinate it moves; a plane
 * stored by its fields keeps them as written, each coordinate the slide
 * does not move untouched and each it moves composed from its own text.
 */
function offsetPlaneFields(
  plane: PlanePick,
  offset: ParamValue | undefined
): ReturnType<typeof planeFields> {
  if (plane.kind === 'datum') return planeFields(plane);
  const amount = offset ?? 0;
  if (amount === 0) return planeFields(plane);
  if (plane.kind !== 'saved' && typeof amount === 'number') {
    return planeFields(offsetPlane(plane, amount));
  }
  const normal = unit(plane.normal);
  const base = (axis: 'x' | 'y' | 'z') =>
    plane.kind === 'saved'
      ? plane.fields.origin[axis]
      : String(plane.origin[axis]);
  const term = (n: number): string => {
    if (typeof amount === 'number') return String(amount * n);
    return Math.abs(n - 1) < 1e-12
      ? `(${amount})`
      : Math.abs(n + 1) < 1e-12
        ? `-(${amount})`
        : `(${amount}) * ${n}`;
  };
  const along = (axis: 'x' | 'y' | 'z'): string => {
    const n = normal[axis];
    const from = base(axis);
    if (Math.abs(n) < 1e-12) return from;
    // Plain numbers on both sides add up; text is kept and added to.
    const literal = Number(from);
    if (
      typeof amount === 'number' &&
      from.trim() !== '' &&
      Number.isFinite(literal)
    ) {
      return String(literal + amount * n);
    }
    return from.trim() === '0' ? term(n) : `${from} + ${term(n)}`;
  };
  return {
    ...planeFields(plane),
    origin: { x: along('x'), y: along('y'), z: along('z') }
  };
}

const PLANE_OFFSET: ValueSpec = {
  id: 'offset',
  label: 'Offset',
  unit: 'length',
  initial: 0
};

/**
 * Three values for a typed point or vector, `prefix`X, Y and Z: what the
 * retired cards took as three fields, a chip each in place.
 */
function vectorValues(
  prefix: string,
  unit: ValueSpec['unit'],
  initial: Vector3
): ValueSpec[] {
  return (['x', 'y', 'z'] as const).map((axis) => ({
    id: `${prefix}${axis.toUpperCase()}`,
    label: `${axis.toUpperCase()}`,
    unit,
    initial: initial[axis]
  }));
}

/** A typed vector as stored: each part as typed, expressions and all. */
function typedVector(
  values: Record<string, ParamValue>,
  prefix: string,
  fallback: Vector3
): ParametricVector3 {
  return {
    x: values[`${prefix}X`] ?? fallback.x,
    y: values[`${prefix}Y`] ?? fallback.y,
    z: values[`${prefix}Z`] ?? fallback.z
  };
}

/** A typed vector as numbers. */
function typedNumbers(
  values: Record<string, number>,
  prefix: string,
  fallback: Vector3
): Vector3 {
  return {
    x: values[`${prefix}X`] ?? fallback.x,
    y: values[`${prefix}Y`] ?? fallback.y,
    z: values[`${prefix}Z`] ?? fallback.z
  };
}

/** A typed vector's three chips, side by side at `anchor`. */
function vectorChips(
  prefix: string,
  key: string,
  anchor: Vector3,
  spread: number
): HandleSpec[] {
  return (['X', 'Y', 'Z'] as const).map((axis, index) => ({
    valueId: `${prefix}${axis}`,
    kind: 'chip' as const,
    key: `${key}:${prefix}${axis}`,
    params: {
      anchor: {
        x: anchor.x + (index - 1) * spread,
        y: anchor.y,
        z: anchor.z
      }
    }
  }));
}

/** Choose between a picked plane and one typed by its origin and normal. */
const PLANE_MODE_OPTION: OptionSpec = {
  id: 'planeMode',
  label: 'Plane',
  choices: [
    { value: 'picked', label: 'A picked plane' },
    { value: 'typed', label: 'Typed (origin and normal)' }
  ],
  initial: 'picked'
};

const TYPED_PLANE_VALUES: ValueSpec[] = [
  ...vectorValues('planeO', 'length', { x: 0, y: 0, z: 0 }),
  ...vectorValues('planeN', 'count', { x: 0, y: 0, z: 1 })
];

/**
 * The plane a Mirror or Split stands on: the picked one, or the typed one
 * (kept as typed, a `saved` plane, so it slides like any other).
 */
function commandPlane(
  slots: InPlaceSlots,
  values: Record<string, ParamValue>,
  numbers: Record<string, number>,
  options: Record<string, string>
): PlanePick | null {
  if (options.planeMode !== 'typed') return slots.plane;
  const text = (vector: ParametricVector3) => ({
    x: String(vector.x),
    y: String(vector.y),
    z: String(vector.z)
  });
  const normal = typedNumbers(numbers, 'planeN', { x: 0, y: 0, z: 1 });
  if (Math.hypot(normal.x, normal.y, normal.z) === 0) return null;
  return {
    kind: 'saved',
    origin: typedNumbers(numbers, 'planeO', { x: 0, y: 0, z: 0 }),
    normal,
    fields: {
      origin: text(typedVector(values, 'planeO', { x: 0, y: 0, z: 0 })),
      normal: text(typedVector(values, 'planeN', { x: 0, y: 0, z: 1 }))
    }
  };
}

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
  if (plane.kind === 'saved') {
    return {
      origin: { ...plane.fields.origin },
      normal: { ...plane.fields.normal }
    };
  }
  return { origin: strings(plane.origin), normal: strings(plane.normal) };
}

function planeHint(
  slots: InPlaceSlots,
  what: string,
  options?: Record<string, string>
): string | null {
  if (slots.bodies.length === 0) return `Click the body to ${what}`;
  if (options?.planeMode === 'typed') {
    return `Slide the plane, or type its origin and normal on their chips · ${FINISH}`;
  }
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
  values: [PLANE_OFFSET, ...TYPED_PLANE_VALUES],
  options: [PLANE_MODE_OPTION],
  hint: (slots, options) =>
    planeHint(slots, 'mirror', options) ??
    `Slide the plane, or pick another · ${FINISH}`,
  ready: (slots, options) =>
    slots.bodies.length > 0 &&
    (slots.plane !== null || options?.planeMode === 'typed'),
  request(slots, values, options, _ctx, numbers) {
    const body = slots.bodies[0];
    const plane = commandPlane(slots, values, numbers ?? {}, options);
    if (!body || !plane) return null;
    const fields = offsetPlaneFields(plane, values.offset);
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
  values: [PLANE_OFFSET, ...TYPED_PLANE_VALUES],
  options: [
    PLANE_MODE_OPTION,
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
  hint: (slots, options) =>
    planeHint(slots, 'split', options) ??
    `Slide the plane, or pick another · ${FINISH}`,
  ready: (slots, options) =>
    slots.bodies.length > 0 &&
    (slots.plane !== null || options?.planeMode === 'typed'),
  request(slots, values, options, _ctx, numbers) {
    const body = slots.bodies[0];
    const plane = commandPlane(slots, values, numbers ?? {}, options);
    if (!body || !plane) return null;
    const fields = offsetPlaneFields(plane, values.offset);
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
    // Any positive factor, as the kernel takes it (a unit conversion's
    // 0.001 or 1000 included).
    {
      id: 'factor',
      label: '×',
      unit: 'count',
      initial: 1,
      min: 0,
      exclusive: true
    },
    ...vectorValues('pivot', 'length', { x: 0, y: 0, z: 0 })
  ],
  options: [
    {
      id: 'pivot',
      label: 'About',
      choices: [
        { value: 'centre', label: 'Body centre' },
        { value: 'origin', label: 'Origin' },
        { value: 'typed', label: 'A point (X, Y, Z)' }
      ],
      // About the body's own centre, not the world origin, so it grows in
      // place rather than drifting away.
      initial: 'centre'
    },
    COPY_OPTION
  ],
  hint: (slots, options) =>
    slots.bodies.length === 0
      ? 'Click the body to scale'
      : options?.pivot === 'typed'
        ? `Type the point it scales about on its chips · drag the corner handle · ${FINISH}`
        : `Drag the corner handle, or tap × to type · ${FINISH}`,
  ready: (slots) => slots.bodies.length > 0,
  request(slots, values, options) {
    const body = slots.bodies[0];
    if (!body) return null;
    // The origin is the absent pivot, as a scale has always stored it; a
    // typed one goes out as typed, expressions and all.
    const pivot =
      options.pivot === 'origin'
        ? undefined
        : options.pivot === 'typed'
          ? typedVector(values, 'pivot', { x: 0, y: 0, z: 0 })
          : centre(body);
    return {
      tool: 'transform',
      targetBodyId: body.bodyId,
      translation: { x: 0, y: 0, z: 0 },
      scale: values.factor ?? 1,
      ...(pivot ? { pivot } : {}),
      ...(options.copy === 'yes' ? { copy: true } : {})
    };
  },
  handles(slots, values, ctx, options) {
    const body = slots.bodies[0];
    if (!body) return [];
    // From the pivot the result scales about, so the handle rides a corner
    // of the preview.
    const origin =
      options.pivot === 'origin'
        ? { x: 0, y: 0, z: 0 }
        : options.pivot === 'typed'
          ? typedNumbers(values, 'pivot', { x: 0, y: 0, z: 0 })
          : centre(body);
    const chips =
      options.pivot === 'typed'
        ? vectorChips(
            'pivot',
            bodyKey(body),
            {
              x: (body.min.x + body.max.x) / 2,
              y: (body.min.y + body.max.y) / 2,
              z: body.max.z
            },
            Math.max((body.max.x - body.min.x) / 4, 1e-3)
          )
        : [];
    const toCorner = (point: Vector3) => ({
      x: point.x - origin.x,
      y: point.y - origin.y,
      z: point.z - origin.z
    });
    const [far, near] = [toCorner(body.max), toCorner(body.min)];
    const corner =
      Math.hypot(far.x, far.y, far.z) >= Math.hypot(near.x, near.y, near.z)
        ? far
        : near;
    const reach = Math.hypot(corner.x, corner.y, corner.z);
    if (ctx.reshapedLater || body.reshapedLater) {
      // A box that is only approximate would mismeasure a drag.
      return [
        ...chips,
        {
          valueId: 'factor',
          kind: 'chip',
          key: `${bodyKey(body)}:factor-chip`,
          params: { anchor: body.max }
        }
      ];
    }
    if (reach <= 1e-9) return chips;
    return [
      ...chips,
      {
        valueId: 'factor',
        kind: 'linear',
        key: `${bodyKey(body)}:factor:${origin.x}:${origin.y}:${origin.z}`,
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
      initial: 90
      // Signed and unbounded, as the Transform card allowed: a negative
      // angle turns the body the other way, and more than a turn is kept.
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
    const key = `${bodyKey(body)}:${slots.axis.id}`;
    const placement = bodyTurnRig(body, slots.axis);
    if (!placement) {
      // Nothing to turn a rig around (a body with no extent): the angle is
      // typed on its chip.
      return [
        { valueId: 'angle', kind: 'chip', key, params: { anchor: body.max } }
      ];
    }
    return [{ valueId: 'angle', kind: 'angle', key, params: placement }];
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
        // The operation, as a choice that keeps the picked bodies: the
        // command becomes that tool.
        id: 'operation',
        label: 'Operation',
        choices: [
          { value: 'union', label: 'Union' },
          { value: 'subtract', label: 'Subtract' },
          { value: 'intersect', label: 'Intersect' }
        ],
        initial: id,
        switchesTool: true
      },
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
    },
    // A custom repeat direction, as the card's X, Y and Z fields gave it.
    { id: 'dirX', label: 'X', unit: 'count', initial: 1 },
    { id: 'dirY', label: 'Y', unit: 'count', initial: 0 },
    { id: 'dirZ', label: 'Z', unit: 'count', initial: 0 }
  ],
  options: [
    {
      ...AXIS_OPTION('x'),
      choices: [
        ...AXIS_OPTION('x').choices,
        { value: 'custom', label: 'Custom vector' }
      ]
    }
  ],
  hint: (slots) =>
    slots.bodies.length === 0
      ? 'Click the body to repeat'
      : `Drag the spacing, tap the count · ${FINISH}`,
  ready: (slots) => slots.bodies.length > 0,
  request(slots, values, options, ctx) {
    const body = slots.bodies[0];
    if (!body) return null;
    // A custom vector is stored as given, expressions and all.
    const direction =
      options.axis === 'custom'
        ? {
            x: values.dirX ?? 1,
            y: values.dirY ?? 0,
            z: values.dirZ ?? 0
          }
        : null;
    return {
      tool: 'pattern',
      targetBodyId: body.bodyId,
      patternKind: 'linear',
      count: values.count ?? 3,
      axis:
        direction && ctx.saved?.featureKind === 'pattern'
          ? ctx.saved.axis
          : axisOf(options.axis),
      spacing: values.spacing ?? 20,
      ...(direction ? { direction } : {})
    };
  },
  handles(slots, values, _ctx, options) {
    const body = slots.bodies[0];
    if (!body) return [];
    const custom = options.axis === 'custom';
    const typed = {
      x: values.dirX ?? 1,
      y: values.dirY ?? 0,
      z: values.dirZ ?? 0
    };
    const vector =
      custom && Math.hypot(typed.x, typed.y, typed.z) > 0
        ? unit(typed)
        : AXIS_VECTORS[axisOf(options.axis)]!;
    const origin = centre(body);
    const width = Math.max(body.max.x - body.min.x, 1e-3);
    return [
      {
        valueId: 'spacing',
        kind: 'linear',
        key: `${bodyKey(body)}:spacing:${custom ? 'custom' : axisOf(options.axis)}`,
        params: { origin, direction: vector }
      },
      {
        valueId: 'count',
        kind: 'chip',
        key: `${bodyKey(body)}:count`,
        params: { anchor: { x: origin.x, y: origin.y, z: body.max.z } }
      },
      // The vector's parts under the body, side by side.
      ...(custom
        ? (['dirX', 'dirY', 'dirZ'] as const).map((valueId, index) => ({
            valueId,
            kind: 'chip' as const,
            key: `${bodyKey(body)}:${valueId}`,
            params: {
              anchor: {
                x: origin.x + (index - 1) * (width / 3),
                y: origin.y,
                z: body.min.z
              }
            }
          }))
        : [])
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
      initial: 360
      // Signed and unbounded, as the pattern itself takes it: a negative
      // total turns the copies the other way.
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
    const placement = bodyTurnRig(body, slots.axis);
    const key = `${bodyKey(body)}:angle:${slots.axis.id}`;
    return [
      // A body with no extent to turn a rig around types its angle.
      placement
        ? { valueId: 'angle', kind: 'angle', key, params: placement }
        : {
            valueId: 'angle',
            kind: 'chip',
            key,
            params: { anchor: body.max }
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
  // An edited grid whose second spacing or count is absent took the first's:
  // until the user sets it, it still follows the first.
  defaults(_slots, ctx, numbers) {
    const saved = ctx.saved;
    if (saved?.featureKind !== 'pattern' || saved.patternKind !== 'grid') {
      return {};
    }
    return {
      ...(saved.spacing2 === undefined && numbers.spacing !== undefined
        ? { spacing2: numbers.spacing }
        : {}),
      ...(saved.count2 === undefined && numbers.count !== undefined
        ? { count2: numbers.count }
        : {})
    };
  },
  ready: (slots) => slots.bodies.length > 0,
  request(slots, values, options, ctx, numbers) {
    const body = slots.bodies[0];
    if (!body) return null;
    // A second value still following the first (an edit's absent one, not
    // set since) is left out, so the edit keeps it absent.
    const saved = ctx.saved?.featureKind === 'pattern' ? ctx.saved : undefined;
    const follows = (second: 'spacing2' | 'count2', first: string) =>
      saved !== undefined &&
      saved[second] === undefined &&
      !ctx.touched?.includes(second) &&
      numbers?.[second] !== undefined &&
      numbers[second] === numbers[first];
    return {
      tool: 'pattern',
      targetBodyId: body.bodyId,
      patternKind: 'grid',
      count: values.count ?? 3,
      axis: axisOf(options.axis),
      spacing: values.spacing ?? 20,
      axis2: axisOf(options.axis2 ?? 'y'),
      ...(follows('spacing2', 'spacing')
        ? {}
        : { spacing2: values.spacing2 ?? 20 }),
      ...(follows('count2', 'count') ? {} : { count2: values.count2 ?? 3 })
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
  'grid-pattern': gridPattern,
  'datum-plane': datumPlane,
  'datum-axis': datumAxis,
  'reference-image': referenceImage
};

/**
 * Whether a typed value is one the spec takes as it is: finite, whole if it
 * must be, and inside its range (strictly, for an open range).
 */
export function valueInRange(spec: ValueSpec, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (spec.integer && !Number.isInteger(value)) return false;
  const { min, max } = spec;
  const openMax = spec.exclusive === true;
  const aboveMin =
    min === undefined || (spec.exclusive ? value > min : value >= min);
  const belowMax = max === undefined || (openMax ? value < max : value <= max);
  return aboveMin && belowMax;
}

/**
 * A value as a chip or the keypad shows it: to two places, unless that
 * would show a value the spec refuses (179.9999995° is not 180°), when it
 * is shown in full.
 */
export function displayedValue(
  spec: ValueSpec | undefined,
  value: number
): number {
  const rounded = Math.round(value * 100) / 100;
  // Two places only where they keep the value: a typed 0.005 is not 0.01,
  // and a valid 179.9999995° is not the refused 180°.
  const close = Math.abs(rounded - value) <= Math.abs(value) * 1e-3;
  const valid =
    !spec || valueInRange(spec, rounded) || !valueInRange(spec, value);
  if (close && valid) return rounded;
  // Ten places, unless even they would cross into what the spec refuses
  // (179.9999999999° rounds to 180°): then the value as it is.
  const shortened = Number(value.toPrecision(10));
  return !spec || valueInRange(spec, shortened) || !valueInRange(spec, value)
    ? shortened
    : value;
}

/**
 * A value as the keypad opens on it: exactly, so reopening it and pressing
 * Enter never changes what is stored.
 */
export function keypadText(value: number): string {
  // The shortest text that reads back as the same number: a short form only
  // where it is exact, never a truncation (1.0000000000004 is not 1).
  const short = Number(value.toPrecision(12));
  return String(short === value ? short : value);
}

/**
 * A dragged value brought inside its spec's range, finite. An open range's
 * ends are kept just inside it; a typed value is checked with
 * {@link valueInRange} instead, so no valid entry is nudged.
 */
export function clampValue(spec: ValueSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.initial;
  const whole = spec.integer ? Math.round(value) : value;
  const minInset = spec.exclusive ? EXCLUSIVE_INSET : 0;
  const maxInset = spec.exclusive === true ? EXCLUSIVE_INSET : 0;
  return Math.min(
    (spec.max ?? Infinity) - maxInset,
    Math.max((spec.min ?? -Infinity) + minInset, whole)
  );
}

/** How far inside an exclusive range's ends a clamped value is kept. */
const EXCLUSIVE_INSET = 1e-6;
