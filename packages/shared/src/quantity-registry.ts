/**
 * I03 (stored-unit conversion plan §1.4): what every number a feature,
 * sketch or parameter stores measures, in one machine-checked place.
 *
 * Three checks keep it whole:
 *
 * 1. **Type level.** {@link QuantityMap} requires an entry for every key whose
 *    type holds a `number` or `ParamValue` anywhere beneath it, through
 *    nested objects, arrays and union members. Adding a numeric field to a
 *    feature kind, sketch object, sketch constraint or the sketch node without
 *    classifying it fails `pnpm typecheck`; so does classifying a stored
 *    `number` (never an expression) as an expression field, or the reverse.
 * 2. **Runtime coverage.** `test/quantity-registry-coverage.test.ts` walks
 *    every numeric leaf of the parity documents and repository fixtures and
 *    fails on a JSON path the registry does not classify. That catches what
 *    the mapped type cannot see: `Record<string, …>` maps and stale data.
 * 3. **Single source.** document-core's `rewriteNodeExpressions` (parameter
 *    rename, F05 typed-parameter checks and suggestions, display units) is
 *    derived from this registry rather than listing fields by hand.
 *
 * Every expression-capable field is visited, except a sketch promotion's
 * verbatim source record ({@link UnvisitedQuantity}).
 *
 * Scope: feature data (direct edits included), sketch objects, sketch
 * constraints, the sketch node and a parameter's expression. The document's
 * top level (`printClearance`), drawings, PMI, assemblies and reference
 * images follow in later I03 work; nothing here converts anything.
 */
import type {
  DatumAxisEdgeSource,
  DatumAxisFaceSource,
  DatumEdgePosition,
  DatumPlaneSource,
  DatumPointSource,
  DirectEditOperation,
  EdgeTopologyReferenceV5,
  EdgeWitnessV1,
  ExtrudeToSurfaceTarget,
  FacePlaneSource,
  FaceTopologyReferenceV5,
  FaceWitnessV1,
  FeatureData,
  ImportedSourceReference,
  ModelingPlaneReference,
  ParameterNode,
  ParametricVector3,
  PlanarEmbossSelection,
  SketchConstraintData,
  SketchNode,
  SketchObjectData,
  SketchPlaneFrame,
  SketchPlaneRef,
  SketchProfileReference,
  SketchProjection
} from './index';
import type { SheetMetalRelief } from './sheet-metal';

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

/**
 * What a stored number measures (plan §1 tags).
 *
 * - `length`: a distance in document units. Scales with a unit conversion.
 * - `area`: document units squared (a fingerprint's source area).
 * - `angle`: degrees. Never scales.
 * - `angle-rad`: radians (direct-edit countersink angles). Never scales.
 * - `number`: unit-free: a count, ratio or factor. Never scales.
 * - `position`: a coordinate (a vector's component) in document units.
 * - `direction`: a unit-vector component. Never scales.
 * - `hash`: a geometry-derived hash, fingerprint or quantized witness.
 *   Re-captured, never scaled arithmetically (plan §3).
 * - `index`: an identity integer: an index, version, side or byte count.
 * - `fraction`: a unit-free position along a span, from 0 to 1.
 * - `condition`: an on/off expression (a boolean's `activeWhen`).
 * - `script`: a custom feature's input, whose quantity the embedded script
 *   declares per instance (`ScriptInputQuantity`). The scripting package
 *   resolves it; plan §9 refuses conversion of a custom feature anyway.
 * - `untyped`: the legacy unitless parameter (absent `quantity`): ambiguous
 *   for conversion (plan §1.1), dimensionless in expressions.
 */
export type QuantityClass =
  | 'length'
  | 'area'
  | 'angle'
  | 'angle-rad'
  | 'number'
  | 'position'
  | 'direction'
  | 'hash'
  | 'index'
  | 'fraction'
  | 'condition'
  | 'script'
  | 'untyped';

/** A leaf's path below the field that declared the entry (array indices, keys). */
export type QuantitySubpath = readonly (string | number)[];

/**
 * A class decided per instance from the object holding the field, such as a
 * gear's `pitch` (a length, or teeth per inch with diametral sizing) or a
 * lock's `at` slots (lengths, and an arc's two trailing angles).
 */
export class DynamicQuantity<H = never> {
  constructor(
    readonly resolve: (holder: H, subpath: QuantitySubpath) => QuantityClass
  ) {}
}

/**
 * A stored `number` that never holds an expression: a fingerprint, a source
 * measurement, a witness. Its class still says how it converts.
 */
export class LiteralQuantity<H = never> {
  constructor(readonly quantity: QuantityClass | DynamicQuantity<H>) {}
}

/**
 * An expression-capable field `rewriteNodeExpressions` deliberately never
 * visits: a sketch promotion's `sourceData`, the verbatim record of the
 * legacy shape's parameters as the user wrote them before S04 converted it
 * (sketch-composite-identity plan, "Explicit conversion mapping"). Nothing
 * evaluates it (the kernel reads only its `objectKind`; the editable edges
 * carry the geometry) and the user cannot see or edit it. It stays
 * byte-identical through a parameter rename (S04,
 * `test/sketch-legacy-conversion.test.ts`), and `isSketchPromotion` accepts
 * a name no parameter holds. Visiting it would also let hidden inert text
 * fail a build (F05 misuse), block a parameter delete or a retype, or sway a
 * quantity suggestion.
 */
export class UnvisitedQuantity {
  constructor(
    readonly quantity: QuantityClass,
    readonly reason: string
  ) {}
}

/** Dispatches a discriminated union to one map per member. */
export class SwitchQuantity<T> {
  declare private readonly phantom?: (value: T) => void;
  constructor(
    readonly discriminant: string,
    readonly cases: Readonly<Record<string, QuantityMapShape>>
  ) {}
}

function literal<H = never>(
  quantity: QuantityClass | DynamicQuantity<H>
): LiteralQuantity<H> {
  return new LiteralQuantity(quantity);
}

function dynamic<H>(
  resolve: (holder: H, subpath: QuantitySubpath) => QuantityClass
): DynamicQuantity<H> {
  return new DynamicQuantity(resolve);
}

function unvisited(quantity: QuantityClass, reason: string): UnvisitedQuantity {
  return new UnvisitedQuantity(quantity, reason);
}

/** One exhaustive map per member of the union `T`, keyed by its `D`. */
export type QuantityCases<T, D extends keyof T & string> = {
  [K in T[D] & string]: QuantityMap<Extract<T, Record<D, K>>>;
};

/** `switchOn<T>()('kind', { … })`: one exhaustive map per union member. */
function switchOn<T>() {
  return <D extends keyof T & string>(
    discriminant: D,
    cases: QuantityCases<T, D>
  ): SwitchQuantity<T> => new SwitchQuantity<T>(discriminant, cases);
}

/** What an entry is at runtime. */
export type QuantityEntry =
  | QuantityClass
  | DynamicQuantity<never>
  | LiteralQuantity<never>
  | UnvisitedQuantity
  | SwitchQuantity<never>
  | QuantityMapShape;
export interface QuantityMapShape {
  readonly [key: string]: QuantityEntry;
}

// ---------------------------------------------------------------------------
// Type-level exhaustiveness
// ---------------------------------------------------------------------------

type Defined<T> = Exclude<T, undefined | null>;
type Primitive = string | number | boolean | bigint | symbol;
type ElementOf<T> = T extends readonly (infer E)[] ? ElementOf<E> : T;
type Scalars<T> = Extract<Defined<T>, Primitive>;
type Objects<T> =
  ElementOf<Exclude<Defined<T>, Primitive>> extends infer O
    ? Exclude<O, Primitive | undefined | null>
    : never;
type ArrayScalars<T> = Extract<
  ElementOf<Exclude<Defined<T>, Primitive>>,
  Primitive
>;
type AllKeys<T> = T extends unknown ? keyof T & string : never;
type Prop<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never;
type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/** `expr` for a `ParamValue`, `literal` for a stored `number`, else `other`. */
type ScalarLeaf<S> = [S] extends [never]
  ? never
  : [Extract<S, number>] extends [never]
    ? 'other'
    : string extends S
      ? 'expr'
      : 'literal';

/** The kinds of leaf beneath a type. */
export type QuantityLeaves<T, D extends number = 12> = [D] extends [never]
  ? 'too-deep'
  : | ScalarLeaf<Scalars<T>>
    | ScalarLeaf<ArrayScalars<T>>
    | ObjectLeaves<Objects<T>, D>;
type ObjectLeaves<O, D extends number> = [O] extends [never]
  ? never
  : O extends unknown
    ? { [K in keyof O]-?: QuantityLeaves<O[K], Depth[D]> }[keyof O]
    : never;

type NumericKeys<T> = {
  [K in AllKeys<T>]-?: [
    Extract<QuantityLeaves<Prop<T, K>>, 'expr' | 'literal' | 'too-deep'>
  ] extends [never]
    ? never
    : K;
}[AllKeys<T>];

/**
 * The keys a homogeneous value may have: the components of a coordinate or
 * vector and the corners of a box. One class may cover every leaf beneath
 * such a value. A named field beside them (`rotationDeg` next to `x`, `y`,
 * `z`) can measure something else, so it needs a map with its own entry.
 */
type HomogeneousKey = 'x' | 'y' | 'z' | 'u' | 'v' | 'min' | 'max';
type ObjectKeysBeneath<T, D extends number = 12> = [D] extends [never]
  ? never
  : Objects<T> extends infer O
    ? O extends unknown
      ? // A record keyed by arbitrary names (primitive dimensions) is a
        // homogeneous collection, like an array: only its values count.
        | (string extends keyof O ? never : keyof O & string)
        | { [K in keyof O]-?: ObjectKeysBeneath<O[K], Depth[D]> }[keyof O]
      : never
    : never;
/** Whether one class may stand for every leaf beneath `T`. */
type Homogeneous<T> = [Exclude<ObjectKeysBeneath<T>, HomogeneousKey>] extends [
  never
]
  ? true
  : false;

type ObjectEntry<T> = [Objects<T>] extends [never]
  ? never
  : QuantityMap<Objects<T>> | SwitchQuantity<Objects<T>>;

/**
 * Every leaf an expression: a class (applied to every leaf beneath), a
 * dynamic class, an unvisited class, or a map. Every leaf a stored number: a
 * literal or a map. Both, or other leaves too: a map.
 */
type Entry<T> =
  Homogeneous<T> extends false
    ? ObjectEntry<T>
    : [Exclude<QuantityLeaves<T>, 'expr'>] extends [never]
      ? | QuantityClass
        | DynamicQuantity<never>
        | UnvisitedQuantity
        | ObjectEntry<T>
      : [Exclude<QuantityLeaves<T>, 'literal'>] extends [never]
        ? LiteralQuantity<never> | ObjectEntry<T>
        : ObjectEntry<T>;

/**
 * One required entry per key of `T` that holds a number. A union's members
 * share one map: keys are the union of every member's keys.
 */
export type QuantityMap<T> = {
  [K in NumericKeys<T>]-?: Entry<Prop<T, K>>;
};

export type FeatureKindName = FeatureData['featureKind'];
type FeatureOf<K extends FeatureKindName> = Extract<
  FeatureData,
  { featureKind: K }
>;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function vector(quantity: QuantityClass): QuantityMap<ParametricVector3> {
  return { x: quantity, y: quantity, z: quantity };
}

const POSITION = vector('position');
const DIRECTION = vector('direction');

/**
 * A reference's witness: quantized, geometry-derived fingerprint inputs.
 * Re-captured by the kernel on conversion, never scaled (plan §3).
 */
const FACE_WITNESS: QuantityMap<FaceWitnessV1> = {
  perimeter: literal('hash'),
  centroid: literal('hash'),
  analytic: {
    normal: literal('hash'),
    offset: literal('hash'),
    axis: literal('hash'),
    axisFoot: literal('hash'),
    radius: literal('hash')
  }
};
const EDGE_WITNESS: QuantityMap<EdgeWitnessV1> = {
  length: literal('hash'),
  endpoints: literal('hash'),
  midpoint: literal('hash'),
  center: literal('hash'),
  axis: literal('hash')
};

const FACE_REFERENCE: QuantityMap<FaceTopologyReferenceV5> = {
  witness: FACE_WITNESS,
  currentHash: literal('hash'),
  witnessVersion: literal('index')
};
const EDGE_REFERENCE: QuantityMap<EdgeTopologyReferenceV5> = {
  witness: EDGE_WITNESS,
  currentHash: literal('hash'),
  witnessVersion: literal('index')
};

const PLANE_FRAME: QuantityMap<SketchPlaneFrame> = {
  origin: literal('position'),
  xAxis: literal('direction'),
  yAxis: literal('direction'),
  zAxis: literal('direction')
};

/** A face a plane was taken from, with its exact-match fingerprint. */
const FACE_PLANE_SOURCE: QuantityMap<FacePlaneSource> = {
  faceHash: literal('hash'),
  faceReference: FACE_REFERENCE,
  sourceArea: literal('area'),
  sourceCenter: literal('position'),
  sourceCentroid: literal('position'),
  sourceNormal: literal('direction'),
  frame: PLANE_FRAME
};

const DATUM_PLANE_SOURCE: QuantityMap<DatumPlaneSource> = {
  offset: 'length',
  basisRevision: literal('index'),
  ...FACE_PLANE_SOURCE
};

const DATUM_POINT_SOURCE: QuantityMap<DatumPointSource> = {
  point: POSITION,
  edgeReference: EDGE_REFERENCE,
  end: literal('index')
};

const DATUM_EDGE_SOURCE: QuantityMap<DatumAxisEdgeSource> = {
  edgeReference: EDGE_REFERENCE
};

const DATUM_AXIS_SOURCE: QuantityMap<
  DatumAxisEdgeSource | DatumAxisFaceSource
> = {
  edgeReference: EDGE_REFERENCE,
  faceReference: FACE_REFERENCE
};

const DATUM_EDGE_POSITION: QuantityMap<DatumEdgePosition> = {
  fraction: 'fraction',
  point: DATUM_POINT_SOURCE
};

const PROFILE: QuantityMap<SketchProfileReference> = {
  regionFingerprint: literal('hash'),
  samplePoint: literal('position'),
  sourceArea: literal('area')
};

const MODELING_PLANE: QuantityMap<ModelingPlaneReference> = {
  origin: POSITION,
  normal: DIRECTION
};

const RELIEF: QuantityMap<SheetMetalRelief> = {
  width: 'length',
  extension: 'length'
};

const SOURCE_REFERENCE: QuantityMap<ImportedSourceReference> = {
  version: literal('index'),
  logicalBytes: literal('index')
};

const EMBOSS_SELECTION: QuantityMap<PlanarEmbossSelection> = {
  supportFaceHash: literal('hash'),
  capFaceHashes: literal('hash'),
  normal: literal('direction'),
  depth: literal('length'),
  bounds: literal('position')
};

const SURFACE_TARGET: QuantityMap<ExtrudeToSurfaceTarget> = {
  faceReference: FACE_REFERENCE,
  sourceCentroid: literal('position')
};

/** A face a direct edit picked: its hash, reference and fingerprint. */
const PICKED_FACE = {
  faceHash: literal('hash'),
  faceReference: FACE_REFERENCE
} as const;

const PROJECTION: QuantityMap<SketchProjection> = {
  source: { edgeReference: EDGE_REFERENCE }
};

// ---------------------------------------------------------------------------
// Direct edits
// ---------------------------------------------------------------------------

/** Every direct-edit operation (`direct-edit` features), by `kind`. */
export const DIRECT_EDIT_QUANTITIES = switchOn<DirectEditOperation>()('kind', {
  'resize-through-hole': {
    diameter: 'length',
    ...PICKED_FACE,
    sourceDiameter: literal('length'),
    sourceAxisStart: literal('position'),
    sourceAxisEnd: literal('position')
  },
  'resize-imported-blind-hole': {
    diameter: 'length',
    depth: 'length',
    ...PICKED_FACE,
    sourceOpeningPoint: literal('position'),
    sourceAxisDirection: literal('direction'),
    sourceDiameter: literal('length'),
    sourceDepth: literal('length')
  },
  'resize-imported-counterbore': {
    boreDiameter: 'length',
    counterboreDiameter: 'length',
    counterboreDepth: 'length',
    ...PICKED_FACE,
    sourceOpeningPoint: literal('position'),
    sourceAxisDirection: literal('direction'),
    sourceBoreDiameter: literal('length'),
    sourceCounterboreDiameter: literal('length'),
    sourceCounterboreDepth: literal('length'),
    sourceTotalDepth: literal('length')
  },
  'resize-imported-countersink': {
    boreDiameter: 'length',
    sinkDiameter: 'length',
    // Stored as raw radians: a typed angle (degrees) or length would be
    // reinterpreted, so only a unitless value may drive it.
    angleRadians: 'angle-rad',
    ...PICKED_FACE,
    sourceOpeningPoint: literal('position'),
    sourceAxisDirection: literal('direction'),
    sourceBoreDiameter: literal('length'),
    sourceSinkDiameter: literal('length'),
    sourceAngleRadians: literal('angle-rad'),
    sourceCountersinkDepth: literal('length'),
    sourceTotalDepth: literal('length')
  },
  'remove-face-feature': {
    ...PICKED_FACE,
    sourceArea: literal('area'),
    sourceCenter: literal('position'),
    sourceDiameter: literal('length'),
    sourceAxisStart: literal('position'),
    sourceAxisEnd: literal('position')
  },
  'remove-faces': {
    ...PICKED_FACE,
    sourceArea: literal('area'),
    sourceCenter: literal('position'),
    additionalFaces: {
      ...PICKED_FACE,
      sourceArea: literal('area'),
      sourceCenter: literal('position')
    }
  },
  'offset-faces': {
    offset: 'length',
    ...PICKED_FACE,
    sourceArea: literal('area'),
    sourceCenter: literal('position'),
    sourceNormal: literal('direction'),
    additionalFaces: {
      ...PICKED_FACE,
      sourceArea: literal('area'),
      sourceCenter: literal('position'),
      sourceNormal: literal('direction')
    }
  },
  'offset-face': {
    offset: 'length',
    ...PICKED_FACE,
    sourceArea: literal('area'),
    sourceCenter: literal('position'),
    sourceNormal: literal('direction')
  },
  'set-face-distance': {
    distance: 'length',
    ...PICKED_FACE,
    oppositeFaceHash: literal('hash'),
    oppositeFaceReference: FACE_REFERENCE,
    sourceDistance: literal('length')
  },
  'resize-cylindrical-face': {
    radius: 'length',
    ...PICKED_FACE,
    sourceRadius: literal('length'),
    sourceAxisStart: literal('position'),
    sourceAxisEnd: literal('position')
  },
  'resize-blend': {
    newRadius: 'length',
    ...PICKED_FACE,
    recordedRadius: literal('length'),
    recordedCenter: literal('position'),
    recordedAxis: literal('direction')
  },
  'remove-blends': {
    ...PICKED_FACE,
    blends: {
      radius: literal('length'),
      center: literal('position'),
      axis: literal('direction')
    }
  }
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/**
 * A diametral pitch is teeth per inch of pitch diameter: a number in every
 * unit system. A module or circular pitch is a length.
 */
const GEAR_PITCH = dynamic<FeatureOf<'gear'>>((gear) =>
  gear.sizing === 'diametral-pitch' ? 'number' : 'length'
);

/** Every feature kind's stored numbers, by `featureKind`. */
export const FEATURE_QUANTITY_CASES: QuantityCases<FeatureData, 'featureKind'> =
  {
    'datum-plane': {
      definition: {
        offset: 'length',
        angleDeg: 'angle',
        at: DATUM_EDGE_POSITION,
        source: DATUM_PLANE_SOURCE,
        sources: DATUM_PLANE_SOURCE,
        reference: DATUM_PLANE_SOURCE,
        points: DATUM_POINT_SOURCE,
        point: DATUM_POINT_SOURCE,
        edge: DATUM_EDGE_SOURCE
      }
    },
    'custom-feature': {
      script: { api: literal('index') },
      // L15: each input's quantity is the script's to declare.
      inputs: 'script'
    },
    'datum-axis': {
      definition: {
        sources: DATUM_PLANE_SOURCE,
        points: DATUM_POINT_SOURCE,
        source: DATUM_AXIS_SOURCE,
        point: DATUM_POINT_SOURCE
      }
    },
    'datum-point': {
      definition: {
        offset: POSITION,
        plane: DATUM_PLANE_SOURCE,
        from: DATUM_POINT_SOURCE,
        source: DATUM_EDGE_SOURCE
      }
    },
    'datum-csys': {
      definition: {
        rotationDeg: vector('angle'),
        source: DATUM_PLANE_SOURCE,
        points: DATUM_POINT_SOURCE,
        origin: DATUM_POINT_SOURCE
      }
    },
    // Every legal primitive dimension key is a length
    // (`kernel-adapter/src/exact-carry-edit-gate.ts`).
    primitive: { dimensions: 'length' },
    sketch: {},
    extrude: {
      distance: 'length',
      backDistance: 'length',
      toFaceOffset: 'length',
      startOffset: 'length',
      draftAngleDeg: 'angle',
      backDraftAngleDeg: 'angle',
      toFace: FACE_PLANE_SOURCE,
      toSurface: SURFACE_TARGET,
      profile: PROFILE,
      profiles: PROFILE
    },
    revolve: { angleDeg: 'angle', profile: PROFILE },
    loft: {
      endPoint: POSITION,
      sections: { profile: PROFILE },
      connections: { index: literal('index'), count: literal('index') }
    },
    sweep: {
      // M04 (v132): an exact sweep's twist is an angle, its end scale a
      // unit-free ratio; (v135) a round corner's radius is a length.
      twistDeg: 'angle',
      endScale: 'number',
      cornerRadius: 'length',
      profile: { profile: PROFILE }
    },
    'helical-sweep': {
      radius: 'length',
      pitch: 'length',
      turns: 'number',
      axisOrigin: POSITION,
      axisDirection: DIRECTION,
      profile: { profile: PROFILE }
    },
    boolean: { activeWhen: 'condition' },
    transform: {
      transform: {
        scale: 'number',
        translation: POSITION,
        rotationDeg: vector('angle'),
        pivot: POSITION
      },
      axisRotation: { angleDeg: 'angle' }
    },
    // A datum reference carries no numbers of its own; the datum's feature is
    // classified where it stands in history.
    mirror: { plane: MODELING_PLANE },
    hole: {
      diameter: 'length',
      depth: 'length',
      counterboreDiameter: 'length',
      counterboreDepth: 'length',
      countersinkDiameter: 'length',
      countersinkAngleDeg: 'angle',
      position: { u: 'length', v: 'length' },
      faceHash: literal('hash'),
      faceReference: FACE_REFERENCE,
      // The hole's thread: read as a Thread's `length` and `clearance`
      // (kernel-adapter `tapHoleBores`), in document units.
      tapped: { length: 'length', clearance: 'length' }
    },
    gear: {
      pitch: GEAR_PITCH,
      faceWidth: 'length',
      offset: 'length',
      backlash: 'length',
      boreDiameter: 'length',
      rimDiameter: 'length',
      backDepth: 'length',
      wormLength: 'length',
      // A throated wheel's tip diameter: the kernel reads a length (#1935).
      outsideDiameter: 'length',
      teeth: 'number',
      mateTeeth: 'number',
      diameterFactor: 'number',
      profileShift: 'number',
      addendum: 'number',
      dedendum: 'number',
      rootFillet: 'number',
      pressureAngleDeg: 'angle',
      phaseDeg: 'angle',
      helixAngleDeg: 'angle',
      shaftAngleDeg: 'angle',
      origin: POSITION,
      axis: DIRECTION,
      xDirection: DIRECTION,
      faceHash: literal('hash'),
      faceReference: FACE_REFERENCE
    },
    thread: {
      majorDiameter: 'length',
      pitch: 'length',
      depth: 'length',
      crestWidth: 'length',
      clearance: 'length',
      length: 'length',
      offset: 'length',
      upperFlankAngleDeg: 'angle',
      lowerFlankAngleDeg: 'angle',
      phaseDeg: 'angle',
      chamferAngleDeg: 'angle',
      starts: 'number',
      faceHash: literal('hash'),
      faceReference: FACE_REFERENCE
    },
    'standard-part': {
      length: 'length',
      origin: POSITION,
      axis: DIRECTION,
      xDirection: DIRECTION
    },
    'sheet-metal': {
      thickness: 'length',
      bendRadius: 'length',
      kFactor: 'number',
      relief: RELIEF,
      bends: {
        angleDeg: 'angle',
        radius: 'length',
        kFactor: 'number',
        relief: RELIEF
      },
      profiles: PROFILE,
      // A sketch-local point inside the fixed region.
      fixedPoint: literal('position')
    },
    split: { plane: MODELING_PLANE },
    shell: {
      thickness: 'length',
      openingFaceHashes: literal('hash'),
      openingFaceReferences: FACE_REFERENCE
    },
    'solid-offset': { distance: 'length' },
    rib: { thickness: 'length' },
    wrap: {
      depth: 'length',
      axialOffset: 'length',
      rotationDeg: 'angle',
      faceReference: FACE_REFERENCE,
      profiles: PROFILE
    },
    draft: {
      angleDeg: 'angle',
      pullDirection: DIRECTION,
      neutralPoint: POSITION,
      faceHashes: literal('hash'),
      faceReferences: FACE_REFERENCE
    },
    thicken: {
      thickness: 'length',
      faceHash: literal('hash'),
      faceReference: FACE_REFERENCE
    },
    fillet: {
      radius: 'length',
      endRadius: 'length',
      vertexRadii: {
        radius: 'length',
        edge: literal('index'),
        end: literal('index')
      },
      radiusStations: { radius: 'length', at: literal('fraction') },
      edgeHashes: literal('hash'),
      edgeReferences: EDGE_REFERENCE
    },
    chamfer: {
      distance: 'length',
      distance2: 'length',
      angleDeg: 'angle',
      edgeHashes: literal('hash'),
      edgeReferences: EDGE_REFERENCE
    },
    pattern: {
      count: 'number',
      count2: 'number',
      spacing: 'length',
      spacing2: 'length',
      angleDeg: 'angle',
      direction: DIRECTION,
      // M02 (schema v119): a mirror pattern's plane, as Mirror's.
      mirrorPlane: MODELING_PLANE
    },
    'direct-edit': { operation: DIRECT_EDIT_QUANTITIES },
    'imported-mesh': {
      triangleCount: literal('index'),
      // Baked into document units (plan §3.4).
      vertices: literal('position'),
      indices: literal('index'),
      meshPayloadRef: SOURCE_REFERENCE
    },
    'imported-step': {
      stepSourceRef: SOURCE_REFERENCE,
      solidIndices: literal('index'),
      planarEmboss: {
        selection: EMBOSS_SELECTION,
        sourcePlacement: {
          translation: literal('position'),
          rotationDeg: literal('angle')
        }
      }
    }
  };

/** Every feature kind's stored numbers, dispatched on `featureKind`. */
export const FEATURE_QUANTITIES = switchOn<FeatureData>()(
  'featureKind',
  FEATURE_QUANTITY_CASES
);

// ---------------------------------------------------------------------------
// Sketches and parameters
// ---------------------------------------------------------------------------

/** Every sketch object kind's stored numbers, by `objectKind`. */
export const SKETCH_OBJECT_QUANTITIES = switchOn<SketchObjectData>()(
  'objectKind',
  {
    rectangle: {
      width: 'length',
      height: 'length',
      centerX: 'length',
      centerY: 'length',
      projection: PROJECTION
    },
    circle: {
      radius: 'length',
      centerX: 'length',
      centerY: 'length',
      projection: PROJECTION
    },
    polygon: {
      sides: 'number',
      radius: 'length',
      centerX: 'length',
      centerY: 'length',
      projection: PROJECTION
    },
    line: {
      x1: 'length',
      y1: 'length',
      x2: 'length',
      y2: 'length',
      projection: PROJECTION
    },
    arc: {
      radius: 'length',
      centerX: 'length',
      centerY: 'length',
      startAngleDeg: 'angle',
      endAngleDeg: 'angle',
      projection: PROJECTION
    },
    ellipse: {
      centerX: 'length',
      centerY: 'length',
      radiusX: 'length',
      radiusY: 'length',
      rotationDeg: 'angle',
      startParamDeg: 'angle',
      endParamDeg: 'angle',
      projection: PROJECTION
    },
    spline: {
      points: { x: 'length', y: 'length' },
      degree: literal('number'),
      projection: PROJECTION
    },
    text: {
      size: 'length',
      x: 'length',
      y: 'length',
      rotation: 'angle',
      projection: PROJECTION
    },
    point: { x: 'length', y: 'length', projection: PROJECTION }
  }
);

/**
 * A locked entity's `at` slots: a line's `[x1, y1, x2, y2]` and a circle's
 * `[centerX, centerY, radius]` are lengths; an arc's
 * `[centerX, centerY, radius, startAngleDeg, endAngleDeg]` ends in angles.
 */
const LOCKED_ENTITY_SLOT = dynamic<
  Extract<SketchConstraintData, { constraintKind: 'lock-entity' }>
>((lock, [slot]) =>
  lock.at.length === 5 && typeof slot === 'number' && slot >= 3
    ? 'angle'
    : 'length'
);

/** Every sketch constraint kind's stored numbers, by `constraintKind`. */
export const SKETCH_CONSTRAINT_QUANTITIES = switchOn<SketchConstraintData>()(
  'constraintKind',
  {
    coincident: {},
    horizontal: {},
    vertical: {},
    parallel: {},
    perpendicular: {},
    tangent: {},
    equal: {},
    symmetric: {},
    concentric: {},
    midpoint: {},
    distance: { value: 'length' },
    radius: { value: 'length' },
    angle: { valueDeg: 'angle' },
    'point-on-object': {},
    lock: { x: literal('length'), y: literal('length') },
    'lock-entity': { at: literal(LOCKED_ENTITY_SLOT) },
    pattern: {
      instances: { step: literal('number') },
      // Resolved as a distance and as degrees (kernel-adapter `gcs-sketch`
      // and `gcs-pattern`), like `distance.value` and `angle.valueDeg`.
      layout: { spacing: 'length', stepDeg: 'angle' }
    },
    offset: { value: 'length', pairs: { side: literal('number') } }
  }
);

const SKETCH_PLANE: QuantityMap<SketchPlaneRef> = {
  offset: 'length',
  basisRevision: literal('index'),
  ...FACE_PLANE_SOURCE
};

const REFERENCE_TARGET = {
  index: literal('index'),
  count: literal('index'),
  topology: { version: literal('index') }
} as const;

const INERT_PROMOTION =
  'the verbatim legacy record a promotion keeps; nothing evaluates it';

/** A sketch node's own stored numbers (its `BaseNode` fields excluded). */
export const SKETCH_NODE_QUANTITIES: QuantityMap<Omit<SketchNode, 'metadata'>> =
  {
    planeRef: SKETCH_PLANE,
    /** Schema v3's plane offset, superseded by `planeRef`. */
    offset: 'length',
    constraints: { data: SKETCH_CONSTRAINT_QUANTITIES },
    // Plane-local label offsets, in document units (plan §1.3, inferred).
    dimensionLabelPositions: literal('position'),
    referenceDimensions: {
      data: { a: REFERENCE_TARGET, b: REFERENCE_TARGET }
    },
    promotions: {
      version: literal('index'),
      // The verbatim conversion record (see `UnvisitedQuantity`).
      sourceData: {
        width: unvisited('length', INERT_PROMOTION),
        height: unvisited('length', INERT_PROMOTION),
        centerX: unvisited('length', INERT_PROMOTION),
        centerY: unvisited('length', INERT_PROMOTION),
        radius: unvisited('length', INERT_PROMOTION),
        sides: unvisited('number', INERT_PROMOTION),
        projection: PROJECTION
      },
      topology: { version: literal('index'), count: literal('index') },
      aliases: { version: literal('index') }
    }
  };

/**
 * A parameter's expression measures what its F05 `quantity` says; absent is
 * the legacy unitless parameter. Its `value` caches the evaluation.
 */
const PARAMETER_QUANTITY = dynamic<ParameterNode>(
  (parameter) => parameter.quantity ?? 'untyped'
);
export const PARAMETER_QUANTITIES: QuantityMap<
  Omit<ParameterNode, 'metadata'>
> & {
  // A plain `string`, so the mapped type cannot see it: declared by hand.
  readonly expression: DynamicQuantity<ParameterNode>;
  readonly value: LiteralQuantity<ParameterNode>;
} = {
  expression: PARAMETER_QUANTITY,
  value: literal(PARAMETER_QUANTITY)
};

// ---------------------------------------------------------------------------
// Runtime walk
// ---------------------------------------------------------------------------

/** How a classified leaf behaves. */
export type QuantityRole =
  /** May hold an expression; `rewriteNodeExpressions` visits it. */
  | 'expression'
  /** A stored number; never an expression. */
  | 'literal'
  /**
   * May hold an expression, but is a verbatim record nothing evaluates and
   * nothing visits (see {@link UnvisitedQuantity}).
   */
  | 'unvisited';

export interface QuantityLeaf {
  /** From the walk's root, e.g. `['definition', 'source', 'offset']`. */
  readonly path: readonly (string | number)[];
  /** The object or array holding the leaf; `holder[key]` is its value. */
  readonly holder: Record<string | number, unknown>;
  readonly key: string | number;
  readonly value: number | string;
  readonly quantity: QuantityClass;
  readonly role: QuantityRole;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How every leaf beneath one class, dynamic, literal or unvisited entry is classified. */
interface LeafRule {
  /** The object holding the entry's field: what a dynamic class reads. */
  readonly owner: unknown;
  readonly classify: QuantityClass | DynamicQuantity<never>;
  readonly role: QuantityRole;
  readonly visit: (leaf: QuantityLeaf) => void;
}

function applyRule(
  value: unknown,
  holder: Record<string | number, unknown>,
  key: string | number,
  path: readonly (string | number)[],
  subpath: readonly (string | number)[],
  rule: LeafRule
): void {
  if (typeof value === 'number' || typeof value === 'string') {
    const { classify } = rule;
    const quantity =
      typeof classify === 'string'
        ? classify
        : (
            classify.resolve as (
              h: unknown,
              s: QuantitySubpath
            ) => QuantityClass
          )(rule.owner, subpath);
    rule.visit({ path, holder, key, value, quantity, role: rule.role });
    return;
  }
  if (Array.isArray(value))
    value.forEach((item, index) =>
      applyRule(
        item,
        value as unknown as Record<number, unknown>,
        index,
        [...path, index],
        [...subpath, index],
        rule
      )
    );
  else if (isRecord(value))
    for (const child of Object.keys(value))
      applyRule(
        value[child],
        value,
        child,
        [...path, child],
        [...subpath, child],
        rule
      );
}

function applyEntry(
  value: unknown,
  holder: Record<string | number, unknown>,
  key: string,
  path: (string | number)[],
  entry: QuantityEntry,
  visit: (leaf: QuantityLeaf) => void,
  expressionsOnly: boolean
): void {
  if (value === undefined || value === null) return;
  // A stored-number subtree (an embedded mesh's vertices and indices) holds
  // no expression: an expression walk never descends into it.
  if (
    expressionsOnly &&
    (entry instanceof LiteralQuantity || entry instanceof UnvisitedQuantity)
  )
    return;
  let rule: LeafRule | undefined;
  if (typeof entry === 'string' || entry instanceof DynamicQuantity)
    rule = { owner: holder, classify: entry, role: 'expression', visit };
  else if (entry instanceof LiteralQuantity)
    rule = { owner: holder, classify: entry.quantity, role: 'literal', visit };
  else if (entry instanceof UnvisitedQuantity)
    rule = {
      owner: holder,
      classify: entry.quantity,
      role: 'unvisited',
      visit
    };
  if (rule) applyRule(value, holder, key, path, [], rule);
  else
    walkQuantities(
      value,
      entry as QuantityMapShape | SwitchQuantity<never>,
      visit,
      path,
      expressionsOnly
    );
}

/**
 * Visits every classified numeric leaf of `value` (and every string at an
 * expression-capable path), in registry order: for a map, its keys in the
 * order they are declared; beneath a class, the value's own key order.
 * Unclassified leaves are skipped; the coverage test is what finds them.
 * With `expressionsOnly`, literal and unvisited entries are skipped without
 * descending into them, so only `'expression'` leaves are reported.
 */
export function walkQuantities(
  value: unknown,
  map: QuantityMapShape | SwitchQuantity<never>,
  visit: (leaf: QuantityLeaf) => void,
  path: (string | number)[] = [],
  expressionsOnly = false
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkQuantities(item, map, visit, [...path, index], expressionsOnly)
    );
    return;
  }
  if (!isRecord(value)) return;
  let fields: QuantityMapShape | undefined;
  if (map instanceof SwitchQuantity) {
    const tag = value[map.discriminant];
    fields = typeof tag === 'string' ? map.cases[tag] : undefined;
  } else fields = map;
  if (!fields) return;
  for (const key of Object.keys(fields)) {
    if (!(key in value)) continue;
    applyEntry(
      value[key],
      value,
      key,
      [...path, key],
      fields[key]!,
      visit,
      expressionsOnly
    );
  }
}

/** What an expression in a field of this class may evaluate to (F05). */
export type QuantityExpressionDimension = 'length' | 'angle' | 'number' | null;

/**
 * The F05 tag a class carries in expressions: positions are lengths per
 * component, radians are unit-free (a typed angle in degrees would be
 * reinterpreted), and everything else has no quantity rule.
 */
export function quantityExpressionDimension(
  quantity: QuantityClass
): QuantityExpressionDimension {
  switch (quantity) {
    case 'length':
    case 'position':
      return 'length';
    case 'angle':
      return 'angle';
    case 'number':
    case 'angle-rad':
      return 'number';
    case 'area':
    case 'direction':
    case 'hash':
    case 'index':
    case 'fraction':
    case 'condition':
    case 'script':
    case 'untyped':
      return null;
    default:
      return quantity satisfies never;
  }
}
