import {
  findSketch,
  isValidParameterName,
  listFeaturesInOrder,
  listParameters,
  resolvedSketchDocument
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  isImportedSourceReference,
  isReadOnlyRecognizedImportedFeature
} from '@openzcad/shared';
import type {
  SketchObjectData,
  AxisId,
  BodyId,
  BodyTopology,
  BooleanOperation,
  DirectEditOperation,
  DatumAxisLine,
  DatumFrame,
  EdgeTopologyReferenceV5,
  EditAnalysisRequest,
  FaceGeometry,
  FaceTopologyReferenceV5,
  FeatureId,
  PatternKind,
  ParametricPlane,
  ParametricVector3,
  ParamValue,
  PlanarEmbossSelection,
  OpposingPlanarFacePair,
  PrimitiveKind,
  ProjectDocument,
  OpeningRecognition,
  RecognizedImportedFeature,
  RecognizedOpening,
  RevolveAxis,
  SketchId,
  SketchPlaneFrame,
  SketchPlaneRef,
  TextAlign,
  TextFontStyle,
  TopologyReferenceV5,
  TopologySelection,
  Vector3
} from '@openzcad/shared';
import { sketchObjectExposesDimension } from './sketch-dimensions';
export {
  createAllEdgesFilletProposal,
  parseAllEdgesFilletRequest
} from './all-edge-fillets';
import {
  createEditCandidateCatalog,
  type EditCandidateCatalog
} from './edit-candidates';
export {
  unmodifiedImportedSource,
  createEditCandidateCatalog,
  proposalForEditCandidate,
  expandEditCandidateProposal,
  type EditCandidate,
  type EditCandidateCatalog
} from './edit-candidates';
export {
  createGrowingHolderProposal,
  growingHolderProposalTarget,
  GROWING_HOLDER_PARAMETER,
  type GrowingHolderProposalTarget
} from './growing-holder-proposal';

import {
  DRAWING_OPERATION_SCHEMAS,
  describeDrawingOperation,
  isDrawingOperation,
  parseDrawingOperation,
  validateDrawingOperation,
  type CadDigestDrawing,
  type CadDrawingOperation
} from './drawing-annotations';
export {
  DRAWING_OPERATION_KINDS,
  MAX_PROPOSED_DRAWING_ANNOTATIONS,
  drawingSpecEdgeRefs,
  isDrawingOperation,
  type CadAddDrawingAnnotationsOperation,
  type CadDigestDrawing,
  type CadDigestDrawingAnnotation,
  type CadDigestDrawingAudit,
  type CadDigestDrawingEdge,
  type CadDigestDrawingFinding,
  type CadDigestDrawingView,
  type CadDrawingAnnotationKind,
  type CadDrawingAnnotationSpec,
  type CadDrawingOperation,
  type CadDrawingPointSpec,
  type CadRemoveDrawingAnnotationsOperation
} from './drawing-annotations';

export {
  isSketchDimensionField,
  sketchObjectExposesDimension,
  SKETCH_DIMENSION_FIELDS
} from './sketch-dimensions';

const TEXT_FONT_STYLES: readonly TextFontStyle[] = [
  'regular',
  'bold',
  'italic',
  'boldItalic'
];
const TEXT_ALIGNMENTS: readonly TextAlign[] = ['left', 'center', 'right'];
/**
 * Every bundled font family id, as a constraint rather than a hint.
 *
 * `fontFamily` used to be validated only as "a non-empty string", so a
 * proposal naming `Arial` or `Helvetica` — the obvious guesses — was accepted,
 * persisted, and only failed at geometry rebuild, with a message about a face
 * not being loaded that reads like a transient problem rather than an
 * unsupported font. `fontStyle` and `align` in the same expression were
 * already checked against literal sets.
 *
 * Duplicated rather than imported: this package depends only on
 * `document-core` and `shared`, never on `@openzcad/geometry` where the font
 * registry lives. `ai-contracts.test.ts` asserts the two lists agree.
 */
export const TEXT_FONT_FAMILY_IDS = [
  'inter',
  'open-sans',
  'lora',
  'roboto-slab',
  'jetbrains-mono',
  'oswald',
  'pacifico'
] as const;

/**
 * A body reference inside a proposal. Either a `bodyId` that already exists in
 * the digest, or `$localId` naming a body an earlier operation in the same
 * proposal creates. The `$` sigil keeps the two namespaces unambiguous, so a
 * dangling reference is always a hard error instead of a silent mis-target.
 */
export type BodyRef = string;

/** Local alias a body-creating operation publishes for later operations. */
export type LocalBodyId = string | null;

export const LOCAL_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SAFE_QUESTION_ID_PATTERN = /^[A-Za-z0-9][\w-]{0,63}$/;

/** Strips the reference sigil so `$lid` and `lid` register the same alias. */
export function normalizeLocalId(value: string): string {
  return value.startsWith('$') ? value.slice(1) : value;
}

/** True when a body reference points at another operation in the same patch. */
export function isLocalBodyRef(value: string): boolean {
  return value.startsWith('$');
}

type RequiredFaceReference<T extends DirectEditOperation> = Omit<
  T,
  'faceReference'
> & {
  /** Must be copied verbatim from the current digest. */
  faceReference: FaceTopologyReferenceV5;
};

type AssistantDirectEditOperation = DirectEditOperation;

export type CadDirectEditOperation =
  AssistantDirectEditOperation extends infer Operation
    ? Operation extends AssistantDirectEditOperation
      ? RequiredFaceReference<Operation>
      : never
    : never;

/** A face plane whose reference and geometry snapshots came from the digest. */
export type CadFaceSketchPlaneRef = Omit<
  Extract<SketchPlaneRef, { type: 'face' }>,
  'faceReference'
> & {
  faceReference: FaceTopologyReferenceV5;
};

/**
 * R01 datum plane references in a patch: an existing datum feature's id from
 * the digest, or "$alias" naming an `add_datum_plane` earlier in the proposal.
 */
export type CadDatumRef = string;

export type CadDatumPlaneSource =
  | { type: 'canonical'; plane: 'XY' | 'XZ' | 'YZ'; offset: ParamValue }
  | { type: 'datum'; datum: CadDatumRef };

export type CadDatumPlaneDefinition =
  | {
      kind: 'offset';
      source: CadDatumPlaneSource;
      offset: ParamValue;
      reverseNormal?: boolean;
    }
  | {
      kind: 'midplane';
      sources: [CadDatumPlaneSource, CadDatumPlaneSource];
      reverseNormal?: boolean;
    };

/** R01 geometry operations use the qualified sources the manual commands store. */
export type CadDatumPlaneSourceV2 =
  | CadDatumPlaneSource
  | (Omit<CadFaceSketchPlaneRef, 'bodyId' | 'sourceCentroid'> & {
      bodyId: string;
      sourceCentroid: Vector3;
    });

export type CadDatumPointSource =
  | { type: 'point'; point: ParametricVector3 }
  | {
      type: 'edge-vertex';
      bodyId: string;
      edgeReference: EdgeTopologyReferenceV5;
      end: 0 | 1;
    };

export type CadDatumPlaneDefinitionV2 =
  | {
      kind: 'offset';
      source: CadDatumPlaneSourceV2;
      offset: ParamValue;
      reverseNormal?: boolean;
    }
  | {
      kind: 'midplane';
      sources: [CadDatumPlaneSourceV2, CadDatumPlaneSourceV2];
      reverseNormal?: boolean;
    }
  | {
      kind: 'three-point';
      points: [CadDatumPointSource, CadDatumPointSource, CadDatumPointSource];
      reverseNormal?: boolean;
    }
  | {
      kind: 'parallel-point';
      source: CadDatumPlaneSourceV2;
      point: CadDatumPointSource;
      reverseNormal?: boolean;
    };

export type CadDatumAxisRef = string;
export type CadDatumAxisDefinition =
  | {
      kind: 'two-point';
      points: [CadDatumPointSource, CadDatumPointSource];
      reverseDirection?: boolean;
    }
  | {
      kind: 'edge';
      source: {
        type: 'edge';
        bodyId: string;
        edgeReference: EdgeTopologyReferenceV5;
      };
      reverseDirection?: boolean;
    }
  | {
      kind: 'cylinder';
      source: {
        type: 'face';
        bodyId: string;
        faceReference: FaceTopologyReferenceV5;
      };
      reverseDirection?: boolean;
    }
  | {
      kind: 'plane-intersection';
      sources: [CadDatumPlaneSourceV2, CadDatumPlaneSourceV2];
      reverseDirection?: boolean;
    };

export type CadPatchOperation =
  | {
      /** App-compiled only; the AI selects its measured candidate. */
      kind: 'add_raised_feature_control';
      targetBodyId: string;
      parameter: string;
      selection: PlanarEmbossSelection;
    }
  | {
      kind: 'use_edit_candidate';
      candidateId: string;
      targetBodyId: string;
      parameterNames: Array<{ key: string; name: string }>;
      analysis: EditAnalysisRequest | null;
    }
  | {
      kind: 'set_parameter';
      name: string;
      expression: string;
    }
  | {
      kind: 'rename_parameter';
      name: string;
      newName: string;
    }
  | {
      kind: 'delete_parameter';
      name: string;
    }
  | {
      kind: 'set_feature_dimension';
      featureId: FeatureId;
      field: string;
      value: ParamValue;
    }
  | {
      kind: 'set_sketch_dimension';
      sketchId: SketchId;
      objectId: string;
      field: string;
      value: ParamValue;
    }
  | {
      kind: 'add_primitive';
      name: string;
      localId?: LocalBodyId;
      primitiveKind: PrimitiveKind;
      dimensions: {
        width: ParamValue | null;
        height: ParamValue | null;
        depth: ParamValue | null;
        radius: ParamValue | null;
        bottomRadius: ParamValue | null;
        topRadius: ParamValue | null;
        majorRadius: ParamValue | null;
        minorRadius: ParamValue | null;
      };
    }
  | {
      kind: 'delete_feature';
      featureId: FeatureId;
    }
  | {
      kind: 'rename_feature';
      featureId: FeatureId;
      name: string;
    }
  | {
      kind: 'add_sketch';
      name: string;
      /** \$alias other operations may use to reference this sketch. */
      localId?: LocalBodyId;
      plane: 'XY' | 'XZ' | 'YZ';
      offset: ParamValue;
      objects: SketchObjectData[];
    }
  | {
      kind: 'add_extrude';
      name: string;
      localId?: LocalBodyId;
      sketchId: SketchId;
      distance: ParamValue;
      /**
       * When set, extrudes only the detected closed region containing this
       * sketch-local point (resolved when the proposal is applied) instead of
       * the whole profile. Null extrudes the full profile.
       */
      samplePoint: { x: number; y: number } | null;
    }
  | {
      kind: 'add_revolve';
      name: string;
      localId?: LocalBodyId;
      sketchId: SketchId;
      axis: RevolveAxis;
      /**
       * Optional sweep angle in degrees, `(0, 360]`. Omitted means a full
       * turn. Rollout-controlled by `AI_PATCH_PARTIAL_REVOLVE_ENABLED`: the
       * property is pruned from the request schema while the flag is off, so
       * `add_revolve` itself stays available either way.
       *
       * Strict structured output requires every declared property in
       * `required`, so "omit this" travels as an explicit null, exactly as it
       * does for `add_primitive` dimensions.
       */
      angleDeg?: ParamValue | null;
    }
  | {
      /**
       * Grow a measured opening: the app measured `opening` on the target
       * imported body (`recognizedOpening` in the digest) and the operation
       * must copy it verbatim. It authors nothing: the compiler carves the
       * ends from the import, rebuilds the straight section and drives it by
       * `parameter`.
       */
      kind: 'add_growing_holder_recipe';
      name: string;
      localId?: LocalBodyId;
      targetBodyId: BodyRef;
      parameter: string;
      /** Parameter for the arm height when the opening carries one; null otherwise. */
      heightParameter?: string | null;
      opening: RecognizedOpening;
    }
  | {
      /**
       * Drive the two mirrored through bores of a growing holder by one
       * parameter. `holes` are the app's own measurements of the bores on
       * the carved end bodies and must be copied verbatim; compilation
       * refuses any value the document does not measure.
       */
      kind: 'add_growing_holder_hole_control';
      name: string;
      targetBodyId: BodyRef;
      parameter: string;
      holes: GrowingHolderHoleReference[];
    }
  | {
      kind: 'add_imported_opening_recipe';
      editedWidth: number;
      name: string;
      localId?: LocalBodyId;
      targetBodyId: BodyRef;
      sourceWidth: number;
      width: ParamValue;
      axis: 'x' | 'y' | 'z';
      regions: [{ min: Vector3; max: Vector3 }, { min: Vector3; max: Vector3 }];
    }
  | {
      kind: 'add_boolean';
      name: string;
      localId?: LocalBodyId;
      operation: BooleanOperation;
      targetBodyIds: BodyRef[];
    }
  | {
      kind: 'add_transform';
      name: string;
      targetBodyId: BodyRef;
      translation: { x: ParamValue; y: ParamValue; z: ParamValue };
      rotationDeg: { x: ParamValue; y: ParamValue; z: ParamValue };
    }
  | {
      kind: 'add_direct_edit';
      name: string;
      targetBodyId: BodyRef;
      operation: CadDirectEditOperation;
    }
  | {
      kind: 'add_face_sketch';
      name: string;
      /** \$alias other operations may use to reference this sketch. */
      localId?: LocalBodyId;
      planeRef: CadFaceSketchPlaneRef;
      objects: SketchObjectData[];
    }
  | {
      kind: 'add_multi_profile_extrude';
      name: string;
      localId?: LocalBodyId;
      sketchId: SketchId;
      distance: ParamValue;
      /** One sketch-local point inside each distinct closed region. */
      samplePoints: Array<{ x: number; y: number }>;
    }
  | {
      kind: 'add_mirror';
      name: string;
      localId?: LocalBodyId;
      targetBodyId: BodyRef;
      plane: ParametricPlane;
    }
  | {
      kind: 'add_shell';
      name: string;
      localId?: LocalBodyId;
      targetBodyId: BodyRef;
      openingFaceHashes: number[];
      openingFaceReferences: FaceTopologyReferenceV5[];
      thickness: ParamValue;
    }
  | {
      kind: 'add_solid_offset';
      name: string;
      localId?: LocalBodyId;
      targetBodyId: BodyRef;
      distance: ParamValue;
    }
  | {
      kind: 'add_datum_plane';
      name: string;
      /** \$alias later datum operations may use to reference this plane. */
      localId?: LocalBodyId;
      definition: CadDatumPlaneDefinition;
    }
  | {
      kind: 'add_datum_plane_v2';
      name: string;
      localId?: LocalBodyId;
      definition: CadDatumPlaneDefinitionV2;
    }
  | {
      kind: 'update_datum_plane';
      featureId: CadDatumRef;
      definition: CadDatumPlaneDefinitionV2;
    }
  | {
      kind: 'add_datum_axis';
      name: string;
      localId?: LocalBodyId;
      definition: CadDatumAxisDefinition;
    }
  | {
      kind: 'update_datum_axis';
      featureId: CadDatumAxisRef;
      definition: CadDatumAxisDefinition;
    }
  | {
      kind: 'add_datum_revolve';
      name: string;
      localId?: LocalBodyId;
      sketchId: string;
      datum: CadDatumAxisRef;
      angleDeg: ParamValue;
    }
  | {
      kind: 'add_datum_pattern';
      name: string;
      localId?: LocalBodyId;
      targetBodyId: BodyRef;
      datum: CadDatumAxisRef;
      count: ParamValue;
      angleDeg: ParamValue;
    }
  | {
      kind: 'add_datum_transform';
      name: string;
      targetBodyId: BodyRef;
      datum: CadDatumAxisRef;
      angleDeg: ParamValue;
      translation: ParametricVector3;
    }
  | {
      kind: 'add_datum_sketch';
      name: string;
      /** \$alias other operations may use to reference this sketch. */
      localId?: LocalBodyId;
      datum: CadDatumRef;
      objects: SketchObjectData[];
    }
  | {
      kind: 'add_datum_mirror';
      name: string;
      localId?: LocalBodyId;
      targetBodyId: BodyRef;
      datum: CadDatumRef;
    }
  | {
      /**
       * Cuts a body in two at a datum plane. `localId` names the half the
       * plane normal points toward, `secondLocalId` the other half.
       */
      kind: 'add_datum_split';
      name: string;
      localId?: LocalBodyId;
      secondLocalId?: LocalBodyId;
      targetBodyId: BodyRef;
      datum: CadDatumRef;
    }
  | {
      kind: 'add_edge_modifier';
      name: string;
      localId?: LocalBodyId;
      modifier: 'fillet' | 'chamfer';
      targetBodyId: BodyRef;
      /**
       * A semantic selector is resolved only after the proposal prefix has
       * produced exact topology. It is deliberately limited to deterministic
       * whole-body selections; arbitrary edge guesses still require hashes
       * from the submitted digest.
       */
      edgeSelector?: 'all-feature-edges' | 'circular-rims' | null;
      edgeHashes: number[];
      size: ParamValue;
    }
  | {
      kind: 'add_pattern';
      name: string;
      localId?: LocalBodyId;
      targetBodyId: BodyRef;
      patternKind: PatternKind;
      count: ParamValue;
      axis: AxisId;
      spacing: ParamValue;
      angleDeg: ParamValue;
    }
  | CadDrawingOperation;

export interface CadPatchProposal {
  proposalId: string;
  summary: string;
  assumptions: string[];
  operations: CadPatchOperation[];
  /** Requires exact preflight to prove that the current bodies did not move. */
  preserveGeometry?: boolean;
}

/**
 * The viewport and feature tree selection captured when an assistant request
 * starts. Arrays preserve pick order, which is significant for booleans (the
 * first body is the base) and makes plural references such as "these edges"
 * deterministic.
 */
/** One measured through bore on a growing holder's carved end body. */
export interface GrowingHolderHoleReference {
  bodyId: string;
  faceHash: number;
  faceReference: FaceTopologyReferenceV5;
  sourceDiameter: number;
  sourceAxisStart: Vector3;
  sourceAxisEnd: Vector3;
}

export interface CadSelectionContext {
  featureIds: readonly FeatureId[];
  bodyIds: readonly string[];
  topologies: readonly TopologySelection[];
}

export interface CadDigestSelection {
  featureIds: string[];
  bodyIds: string[];
  topologies: Array<{
    bodyId: string;
    kind: TopologySelection['kind'];
    topologyId: string;
    hash: number | null;
    /** Exact schema-v5 reference; absent for bodies and legacy topology. */
    reference?: TopologyReferenceV5;
  }>;
}

export interface CadDigestFaceSnapshot {
  surfaceType: string;
  area: number;
  center: Vector3;
  /** Area centroid of a planar face — where `attachmentFrame` is anchored. */
  centroid?: Vector3;
  normal?: Vector3;
  radius?: number;
  diameter?: number;
  axisStart?: Vector3;
  axisEnd?: Vector3;
  axialLength?: number;
  torusCenter?: Vector3;
  axis?: Vector3;
  blendRadius?: number;
  featureType?: FaceGeometry['featureType'];
}

export interface CadDigestBodyTopology {
  recognizedPlanarEmboss?: PlanarEmbossSelection;
  faceCount: number;
  edgeCount: number;
  /**
   * Included edges that represent a real modeling boundary rather than a
   * smooth seam. It is the total only when edgeInventoryComplete is true.
   */
  modifierEdgeCount: number;
  /**
   * False when the compact digest hit its global context budget. An assistant
   * must never interpret a partial inventory as "all" of a body's topology.
   */
  faceInventoryComplete: boolean;
  edgeInventoryComplete: boolean;
  /** Exact bounded proofs available for imported-feature direct edits. */
  recognizedImportedFeatures?: RecognizedImportedFeature[];
  /** Planar dimensions that already passed a changed-value exact rebuild. */
  opposingPlanarFacePairs?: OpposingPlanarFacePair[];
  /**
   * The measured straight-section opening of an imported body, or why there
   * is none. `add_growing_holder_recipe` copies a recognized value verbatim.
   */
  recognizedOpening?: OpeningRecognition;
  faces: Array<{
    topologyId: string;
    hash: number;
    /** Exact lineage reference that AI operations must copy verbatim. */
    reference?: FaceTopologyReferenceV5;
    /** Unrounded command-validation snapshot; display fields below are compact. */
    snapshot?: CadDigestFaceSnapshot;
    /** Deterministic frame available only for referenced planar faces. */
    attachmentFrame?: SketchPlaneFrame;
    surfaceType?: string;
    area?: number;
    center?: Vector3;
    normal?: Vector3;
    radius?: number;
    diameter?: number;
    axisStart?: Vector3;
    axisEnd?: Vector3;
    axialLength?: number;
    featureType?: FaceGeometry['featureType'];
  }>;
  edges: Array<{
    topologyId: string;
    hash: number;
    /** Exact current lineage identity; vertex/axis operations copy it verbatim. */
    reference?: EdgeTopologyReferenceV5;
    modelingRole: 'edge' | 'rim' | 'seam';
    modifierCandidate: boolean;
    /**
     * Compact spatial facts derived from the exact edge's display polyline.
     * They let the assistant distinguish, for example, the top and bottom
     * closed rims of a cylinder without sending viewport meshes.
     */
    closed?: boolean;
    length?: number;
    center?: Vector3;
    bbox?: {
      min: Vector3;
      max: Vector3;
    };
  }>;
}

export interface CadDocumentDigest {
  editCatalog?: EditCandidateCatalog;
  schemaVersion: number;
  projectId: string;
  name: string;
  units: string;
  version: number;
  parameters: Array<{ name: string; expression: string; value: number }>;
  features: Array<{
    featureId: string;
    name: string;
    featureKind: string;
    bodyId: string | null;
    suppressed: boolean;
    data: unknown;
    /** Optional for older clients; resolved output from this exact projection. */
    datum?: {
      kind: 'plane' | 'axis';
      status: 'resolved' | 'unresolved' | 'suppressed';
      frame?: DatumFrame;
      axis?: DatumAxisLine;
    };
  }>;
  /**
   * The bodies that have been built, with the two facts the feature list cannot
   * convey: whether a later boolean already consumed the body, and where it
   * actually sits after any transforms. Without these the model has to replay
   * the whole history in its head and routinely targets a dead body.
   *
   * Optional because a client older than this field still posts a valid digest.
   */
  bodies?: Array<{
    bodyId: string;
    name: string;
    /** True when a later feature consumed this body; do not target it. */
    consumed: boolean;
    sourceFeatureKind?: string;
    /** Null for a display-only mesh reference with no solid volume. */
    volume: number | null;
    bbox: {
      min: { x: number; y: number; z: number };
      max: { x: number; y: number; z: number };
    };
    /**
     * Exact, compact topology for current live bodies. Optional for backwards
     * compatibility with older clients and legacy mesh-only representations.
     */
    topology?: CadDigestBodyTopology;
  }>;
  selection?: CadDigestSelection;
  /**
   * The Draw sheet the user is on (D06 slice E), supplied by the app: the
   * only source of the edges a drawing operation may name.
   */
  drawing?: CadDigestDrawing;
  warnings: string[];
}

/**
 * Kernel measurements carry full float noise (59.99999999999999). Model context
 * reads better, and costs fewer tokens, at a precision far finer than any real
 * tolerance.
 */
function round(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
}

function roundVector(vector: Vector3): Vector3 {
  return {
    x: round(vector.x),
    y: round(vector.y),
    z: round(vector.z)
  };
}

const VECTOR_EPSILON = 1e-12;

function finiteVector(vector: Vector3): boolean {
  return [vector.x, vector.y, vector.z].every(Number.isFinite);
}

function normalized(vector: Vector3): Vector3 | null {
  if (!finiteVector(vector)) {
    return null;
  }
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length > VECTOR_EPSILON
    ? { x: vector.x / length, y: vector.y / length, z: vector.z / length }
    : null;
}

/**
 * Kernel-neutral copy of the face-attachment axis rule. The digest must carry
 * the same frame the command persists; asking a model to choose an in-plane
 * axis would make identical requests replay differently.
 */
function deterministicFaceFrame(
  center: Vector3,
  normal: Vector3
): SketchPlaneFrame | null {
  let zAxis = normalized(normal);
  if (!zAxis || !finiteVector(center)) {
    return null;
  }
  const sign = [zAxis.x, zAxis.y, zAxis.z].find(
    (component) => Math.abs(component) > VECTOR_EPSILON
  );
  if (sign === undefined) {
    return null;
  }
  if (sign < 0) {
    zAxis = { x: -zAxis.x, y: -zAxis.y, z: -zAxis.z };
  }
  const helpers: Vector3[] = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 }
  ];
  const dot = (left: Vector3, right: Vector3) =>
    left.x * right.x + left.y * right.y + left.z * right.z;
  const helper = helpers.reduce((best, candidate) =>
    Math.abs(dot(zAxis, candidate)) < Math.abs(dot(zAxis, best))
      ? candidate
      : best
  );
  const projection = dot(helper, zAxis);
  const xAxis = normalized({
    x: helper.x - zAxis.x * projection,
    y: helper.y - zAxis.y * projection,
    z: helper.z - zAxis.z * projection
  });
  if (!xAxis) {
    return null;
  }
  const yAxis = normalized({
    x: zAxis.y * xAxis.z - zAxis.z * xAxis.y,
    y: zAxis.z * xAxis.x - zAxis.x * xAxis.z,
    z: zAxis.x * xAxis.y - zAxis.y * xAxis.x
  });
  if (!yAxis) {
    return null;
  }
  const clean = (value: number) =>
    Math.abs(value) <= VECTOR_EPSILON ? 0 : value;
  const cleaned = (vector: Vector3): Vector3 => ({
    x: clean(vector.x),
    y: clean(vector.y),
    z: clean(vector.z)
  });
  return {
    origin: { ...center },
    xAxis: cleaned(xAxis),
    yAxis: cleaned(yAxis),
    zAxis: cleaned(zAxis)
  };
}

function compactEdge(
  edge: BodyTopology['edges'][number],
  primitiveKind?: PrimitiveKind
): CadDigestBodyTopology['edges'][number] {
  const points: Vector3[] = [];
  for (let index = 0; index + 2 < edge.points.length; index += 3) {
    const point = {
      x: edge.points[index]!,
      y: edge.points[index + 1]!,
      z: edge.points[index + 2]!
    };
    if (
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Number.isFinite(point.z)
    ) {
      points.push(point);
    }
  }
  const base = {
    topologyId: edge.topologyId,
    hash: edge.hash,
    ...(isEdgeReference(edge.reference) &&
    edge.reference.currentHash === edge.hash
      ? { reference: edge.reference }
      : {}),
    modelingRole: 'edge' as const,
    modifierCandidate: true
  };
  if (points.length < 2) {
    return base;
  }

  const bbox = points.reduce(
    (bounds, point) => ({
      min: {
        x: Math.min(bounds.min.x, point.x),
        y: Math.min(bounds.min.y, point.y),
        z: Math.min(bounds.min.z, point.z)
      },
      max: {
        x: Math.max(bounds.max.x, point.x),
        y: Math.max(bounds.max.y, point.y),
        z: Math.max(bounds.max.z, point.z)
      }
    }),
    {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    }
  );
  const distance = (left: Vector3, right: Vector3) =>
    Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += distance(points[index - 1]!, points[index]!);
  }
  const diagonal = distance(bbox.min, bbox.max);
  const closureTolerance = Math.max(diagonal, length, 1) * 1e-6;

  const closed =
    points.length > 2 &&
    distance(points[0]!, points[points.length - 1]!) <= closureTolerance;
  const smoothPrimitive =
    primitiveKind === 'sphere' || primitiveKind === 'torus';
  const seamOnAxialPrimitive =
    (primitiveKind === 'cylinder' || primitiveKind === 'cone') && !closed;
  const seam =
    edge.displayRole === 'seam' || smoothPrimitive || seamOnAxialPrimitive;

  return {
    ...base,
    modelingRole: seam
      ? 'seam'
      : primitiveKind === 'cylinder' || primitiveKind === 'cone'
        ? 'rim'
        : 'edge',
    modifierCandidate: !seam,
    closed,
    length: round(length),
    center: roundVector({
      x: (bbox.min.x + bbox.max.x) / 2,
      y: (bbox.min.y + bbox.max.y) / 2,
      z: (bbox.min.z + bbox.max.z) / 2
    }),
    bbox: {
      min: roundVector(bbox.min),
      max: roundVector(bbox.max)
    }
  };
}

function compactFace(
  face: BodyTopology['faces'][number]
): CadDigestBodyTopology['faces'][number] {
  const geometry = face.geometry;
  const reference =
    face.reference?.kind === 'face' && face.reference.currentHash === face.hash
      ? face.reference
      : undefined;
  const snapshot = geometry
    ? {
        surfaceType: geometry.surfaceType,
        area: geometry.area,
        center: { ...geometry.center },
        ...(geometry.centroid ? { centroid: { ...geometry.centroid } } : {}),
        ...(geometry.normal ? { normal: { ...geometry.normal } } : {}),
        ...(geometry.radius !== undefined ? { radius: geometry.radius } : {}),
        ...(geometry.diameter !== undefined
          ? { diameter: geometry.diameter }
          : {}),
        ...(geometry.axisStart ? { axisStart: { ...geometry.axisStart } } : {}),
        ...(geometry.axisEnd ? { axisEnd: { ...geometry.axisEnd } } : {}),
        ...(geometry.axialLength !== undefined
          ? { axialLength: geometry.axialLength }
          : {}),
        ...(geometry.torusCenter
          ? { torusCenter: { ...geometry.torusCenter } }
          : {}),
        ...(geometry.axis ? { axis: { ...geometry.axis } } : {}),
        ...(geometry.blendRadius !== undefined
          ? { blendRadius: geometry.blendRadius }
          : {}),
        ...(geometry.featureType ? { featureType: geometry.featureType } : {})
      }
    : undefined;
  // Anchored on the area centroid, matching what the app persists and what the
  // rebuild re-derives; `center` is the vertex mean and only stands in for a
  // face whose boundary the kernel could not walk.
  const attachmentFrame =
    reference && geometry?.surfaceType === 'plane' && geometry.normal
      ? deterministicFaceFrame(
          geometry.centroid ?? geometry.center,
          geometry.normal
        )
      : null;
  return {
    topologyId: face.topologyId,
    hash: face.hash,
    ...(reference ? { reference } : {}),
    ...(reference && snapshot ? { snapshot } : {}),
    ...(attachmentFrame ? { attachmentFrame } : {}),
    ...(geometry
      ? {
          surfaceType: geometry.surfaceType,
          area: round(geometry.area),
          center: roundVector(geometry.center),
          ...(geometry.normal ? { normal: roundVector(geometry.normal) } : {}),
          ...(geometry.radius !== undefined
            ? { radius: round(geometry.radius) }
            : {}),
          ...(geometry.diameter !== undefined
            ? { diameter: round(geometry.diameter) }
            : {}),
          ...(geometry.axisStart
            ? { axisStart: roundVector(geometry.axisStart) }
            : {}),
          ...(geometry.axisEnd
            ? { axisEnd: roundVector(geometry.axisEnd) }
            : {}),
          ...(geometry.axialLength !== undefined
            ? { axialLength: round(geometry.axialLength) }
            : {}),
          ...(geometry.featureType ? { featureType: geometry.featureType } : {})
        }
      : {})
  };
}

const MAX_DIGEST_EDGES = 128;
const MAX_DIGEST_FACES = 128;
const MAX_DIGEST_TOPOLOGY_PER_BODY = 64;

function compactFeatureData(document: ProjectDocument, data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  const feature = data as Record<string, unknown>;
  if (feature.featureKind === 'imported-step') {
    return {
      featureKind: feature.featureKind,
      artifactId: feature.artifactId,
      sourceName: feature.sourceName,
      sourceBytes:
        typeof feature.stepText === 'string'
          ? feature.stepText.length
          : isImportedSourceReference(feature.stepSourceRef)
            ? feature.stepSourceRef.logicalBytes
            : 0
    };
  }
  if (feature.featureKind === 'imported-mesh') {
    return {
      featureKind: feature.featureKind,
      artifactId: feature.artifactId,
      sourceName: feature.sourceName,
      triangleCount: feature.triangleCount
    };
  }
  if (feature.featureKind === 'sketch') {
    const sketch = findSketch(document, feature.sketchId as SketchId);
    if (!sketch) {
      return feature;
    }
    const sketchObjects = sketch.objectIds.flatMap((objectId) => {
      const object = resolvedSketchDocument(document).nodes[objectId];
      return object?.kind === 'sketch-object'
        ? [{ objectId, data: object.data }]
        : [];
    });
    return {
      featureKind: feature.featureKind,
      sketchId: sketch.sketchId,
      planeRef: sketch.planeRef,
      objectIds: sketchObjects.map(({ objectId }) => objectId),
      objects: sketchObjects.map(({ data: objectData }) => objectData)
    };
  }
  return feature;
}

export function createCadDocumentDigest(
  document: ProjectDocument,
  selection?: TopologySelection | CadSelectionContext | null
): CadDocumentDigest {
  const context: CadSelectionContext =
    selection && 'topologies' in selection
      ? selection
      : {
          featureIds: [],
          bodyIds: selection ? [selection.bodyId] : [],
          topologies: selection ? [selection] : []
        };
  const bodyIds = [...new Set(context.bodyIds.map(String))];
  for (const topology of context.topologies) {
    const bodyId = String(topology.bodyId);
    if (!bodyIds.includes(bodyId)) {
      bodyIds.push(bodyId);
    }
  }

  const orderedFeatures = listFeaturesInOrder(document);
  const primitiveKindByBodyId = new Map(
    orderedFeatures.flatMap((feature) =>
      feature.bodyId && feature.data.featureKind === 'primitive'
        ? [[String(feature.bodyId), feature.data.primitiveKind] as const]
        : []
    )
  );

  // Spend the bounded topology context on what the user selected first, then
  // on the remaining live bodies. The body list itself keeps document order.
  const topologyByBodyId = new Map<string, CadDigestBodyTopology>();
  const topologyPriority = [
    ...bodyIds,
    ...document.bodyOrder.map(String)
  ].filter((bodyId, index, values) => values.indexOf(bodyId) === index);
  let remainingEdges = MAX_DIGEST_EDGES;
  let remainingFaces = MAX_DIGEST_FACES;
  for (const bodyId of topologyPriority) {
    const body = document.derived.bodyRepresentations[bodyId as BodyId];
    if (!body?.topology || body.consumed) {
      continue;
    }
    const edgeLimit = Math.min(MAX_DIGEST_TOPOLOGY_PER_BODY, remainingEdges);
    const faceLimit = Math.min(MAX_DIGEST_TOPOLOGY_PER_BODY, remainingFaces);
    const primitiveKind = primitiveKindByBodyId.get(bodyId);
    const selectedEdges = (edge: BodyTopology['edges'][number]) =>
      context.topologies.some(
        (selected) =>
          selected.bodyId === bodyId &&
          selected.kind === 'edge' &&
          (selected.hash === edge.hash ||
            selected.topologyId === edge.topologyId)
      );
    const edges = [
      ...body.topology.edges.filter(selectedEdges),
      ...body.topology.edges.filter((edge) => !selectedEdges(edge))
    ]
      .slice(0, edgeLimit)
      .map((edge) => compactEdge(edge, primitiveKind));
    const provenPairHashes = new Set(
      (body.topology.opposingPlanarFacePairs ?? []).flatMap((pair) => [
        pair.faceAHash,
        pair.faceBHash
      ])
    );
    const prioritizedFaces = [
      ...body.topology.faces.filter((face) =>
        context.topologies.some(
          (selected) =>
            selected.bodyId === bodyId &&
            selected.kind === 'face' &&
            selected.hash === face.hash
        )
      ),
      ...body.topology.faces.filter(
        (face) =>
          provenPairHashes.has(face.hash) &&
          !context.topologies.some(
            (selected) =>
              selected.bodyId === bodyId &&
              selected.kind === 'face' &&
              selected.hash === face.hash
          )
      ),
      ...body.topology.faces.filter(
        (face) =>
          !provenPairHashes.has(face.hash) &&
          !context.topologies.some(
            (selected) =>
              selected.bodyId === bodyId &&
              selected.kind === 'face' &&
              selected.hash === face.hash
          )
      )
    ];
    const faces = prioritizedFaces.slice(0, faceLimit).map(compactFace);
    remainingEdges -= edges.length;
    remainingFaces -= faces.length;
    topologyByBodyId.set(bodyId, {
      ...(body.topology.recognizedPlanarEmboss
        ? { recognizedPlanarEmboss: body.topology.recognizedPlanarEmboss }
        : {}),
      faceCount: body.topology.faces.length,
      edgeCount: body.topology.edges.length,
      modifierEdgeCount: edges.filter((edge) => edge.modifierCandidate).length,
      faceInventoryComplete: faces.length === body.topology.faces.length,
      edgeInventoryComplete: edges.length === body.topology.edges.length,
      ...(body.topology.recognizedImportedFeatures
        ? {
            // Editable proofs first: a read-only kernel-recognized feature is
            // context, while an exactly proved one is what an operation binds
            // to, and the cap must never spend the budget on the former.
            recognizedImportedFeatures: [
              ...body.topology.recognizedImportedFeatures.filter(
                (feature) => !isReadOnlyRecognizedImportedFeature(feature)
              ),
              ...body.topology.recognizedImportedFeatures.filter(
                isReadOnlyRecognizedImportedFeature
              )
            ].slice(0, MAX_DIGEST_TOPOLOGY_PER_BODY)
          }
        : {}),
      ...(body.topology.opposingPlanarFacePairs
        ? {
            opposingPlanarFacePairs:
              body.topology.opposingPlanarFacePairs.slice(
                0,
                MAX_DIGEST_TOPOLOGY_PER_BODY
              )
          }
        : {}),
      ...(body.topology.recognizedOpening
        ? { recognizedOpening: body.topology.recognizedOpening }
        : {}),
      faces,
      edges
    });
  }

  return {
    schemaVersion: document.schemaVersion,
    editCatalog: createEditCandidateCatalog(document, context),
    projectId: document.projectId,
    name: document.name,
    units: document.units,
    version: document.version,
    parameters: listParameters(document).map((parameter) => ({
      name: parameter.name,
      expression: parameter.expression,
      value: parameter.value
    })),
    features: orderedFeatures.map((feature) => ({
      featureId: feature.featureId,
      name: feature.name,
      featureKind: feature.featureKind,
      bodyId: feature.bodyId ?? null,
      suppressed: isFeatureSuppressed(feature),
      data: compactFeatureData(document, feature.data),
      ...(feature.data.featureKind === 'datum-plane'
        ? {
            datum: {
              kind: 'plane' as const,
              status: isFeatureSuppressed(feature)
                ? ('suppressed' as const)
                : document.derived.datumFrames?.[feature.featureId]
                  ? ('resolved' as const)
                  : ('unresolved' as const),
              ...(!isFeatureSuppressed(feature) &&
              document.derived.datumFrames?.[feature.featureId]
                ? { frame: document.derived.datumFrames[feature.featureId] }
                : {})
            }
          }
        : feature.data.featureKind === 'datum-axis'
          ? {
              datum: {
                kind: 'axis' as const,
                status: isFeatureSuppressed(feature)
                  ? ('suppressed' as const)
                  : document.derived.datumAxes?.[feature.featureId]
                    ? ('resolved' as const)
                    : ('unresolved' as const),
                ...(!isFeatureSuppressed(feature) &&
                document.derived.datumAxes?.[feature.featureId]
                  ? { axis: document.derived.datumAxes[feature.featureId] }
                  : {})
              }
            }
          : {})
    })),
    // Meshes are deliberately dropped here: the model needs each body's
    // identity, liveness, and placement, never its triangles.
    bodies: document.bodyOrder.flatMap((bodyId) => {
      const body = document.derived.bodyRepresentations[bodyId];
      return body
        ? [
            {
              bodyId: String(bodyId),
              name: body.name,
              consumed: body.consumed,
              sourceFeatureKind: body.source,
              volume: body.meshReference ? null : round(body.volume),
              bbox: {
                min: {
                  x: round(body.bbox.min.x),
                  y: round(body.bbox.min.y),
                  z: round(body.bbox.min.z)
                },
                max: {
                  x: round(body.bbox.max.x),
                  y: round(body.bbox.max.y),
                  z: round(body.bbox.max.z)
                }
              },
              ...(topologyByBodyId.has(String(bodyId))
                ? { topology: topologyByBodyId.get(String(bodyId))! }
                : {})
            }
          ]
        : [];
    }),
    selection: {
      featureIds: [...new Set(context.featureIds.map(String))],
      bodyIds,
      topologies: context.topologies.map((topology) => ({
        bodyId: String(topology.bodyId),
        kind: topology.kind,
        topologyId: topology.topologyId ?? `body:${String(topology.bodyId)}`,
        hash: topology.hash ?? null,
        ...(topology.reference ? { reference: topology.reference } : {})
      }))
    },
    warnings: document.derived.warnings
  };
}

const SELECTED_EDGES_PATTERN =
  /\b(?:(?:selected|these|those)\s+edges?|edges?\s+(?:that|which)\s+(?:are\s+)?selected)\b/i;
const SELECTED_FEATURE_PATTERN =
  /\b(?:selected|this|that|these|those)\s+features?\b/i;
const SELECTED_BODY_PATTERN =
  /\b(?:selected|this|that|these|those)\s+(?:body|bodies|part|parts|solid|solids)\b/i;
const ALL_EDGES_PATTERN =
  /\b(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?(?:[\w'-]+\s+){0,3}edges?\b/i;
const NEGATED_ALL_EDGES_PATTERN =
  /\b(?:do\s+not|don't|not)\s+(?:[\w'-]+\s+){0,4}(?:all|every|each)\s+(?:of\s+)?(?:the\s+)?(?:[\w'-]+\s+){0,3}edges?\b/i;

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Grounds the model's proposed references back onto an explicitly named UI
 * selection. The model still decides the operation and dimensions; the client
 * owns which user-picked entities words such as "selected edges" refer to.
 * This prevents a proposal from dropping all but the last edge or inventing a
 * nearby topology id.
 */
export function groundCadPatchProposalToSelection(
  prompt: string,
  digest: CadDocumentDigest,
  proposal: CadPatchProposal
): CadPatchProposal {
  const selection = digest.selection;
  if (!selection) {
    return proposal;
  }

  const selectedEdges = selection.topologies.filter(
    (topology) => topology.kind === 'edge' && topology.hash !== null
  );
  const selectedEdgeBodyId = selectedEdges[0]?.bodyId;
  const selectedEdgeHashes = [
    ...new Set(selectedEdges.map((topology) => topology.hash as number))
  ];
  const edgesShareBody =
    selectedEdgeBodyId !== undefined &&
    selectedEdges.every((topology) => topology.bodyId === selectedEdgeBodyId);
  const selectedFeatureId =
    selection.featureIds.length === 1 ? selection.featureIds[0] : undefined;
  const selectedBodyId =
    selection.bodyIds.length === 1 ? selection.bodyIds[0] : undefined;
  const referencesSelectedEdges = SELECTED_EDGES_PATTERN.test(prompt);
  const referencesSelectedFeature = SELECTED_FEATURE_PATTERN.test(prompt);
  const referencesSelectedBody = SELECTED_BODY_PATTERN.test(prompt);
  const referencesAllEdges =
    ALL_EDGES_PATTERN.test(prompt) && !NEGATED_ALL_EDGES_PATTERN.test(prompt);
  const liveBodies = (digest.bodies ?? []).filter((body) => !body.consumed);
  const promptLower = prompt.toLowerCase();
  const namedBodies = liveBodies.filter(
    (body) =>
      body.name.trim().length > 0 &&
      promptLower.includes(body.name.trim().toLowerCase())
  );
  let changed = false;

  const operations = proposal.operations.map((operation): CadPatchOperation => {
    if (
      operation.kind === 'add_edge_modifier' &&
      referencesAllEdges &&
      !referencesSelectedEdges
    ) {
      const selectedBodyIds = [...new Set(selection.bodyIds)].filter((bodyId) =>
        liveBodies.some((body) => body.bodyId === bodyId)
      );
      const selectedBody =
        selectedBodyIds.length === 1
          ? liveBodies.find(
              (candidate) => candidate.bodyId === selectedBodyIds[0]
            )
          : undefined;
      const soleLiveBody = liveBodies.length === 1 ? liveBodies[0] : undefined;
      const namedBody = namedBodies.length === 1 ? namedBodies[0] : undefined;
      const body =
        referencesSelectedBody || referencesSelectedEdges
          ? selectedBody
          : (soleLiveBody ?? namedBody);
      if (!body) {
        throw new Error('AI "all edges" target is ambiguous.');
      }
      if (!body.topology?.edgeInventoryComplete) {
        throw new Error(
          `The complete edge inventory for ${body.name} is not available in the assistant context. Select the intended edges explicitly.`
        );
      }
      const edgeHashes = [
        ...new Set(
          body.topology.edges
            .filter((edge) => edge.modifierCandidate)
            .map((edge) => edge.hash)
        )
      ];
      if (edgeHashes.length === 0) {
        throw new Error(`${body.name} has no exact edges to modify.`);
      }
      if (
        operation.targetBodyId === body.bodyId &&
        sameStrings(operation.edgeHashes.map(String), edgeHashes.map(String))
      ) {
        return operation;
      }
      changed = true;
      return {
        ...operation,
        targetBodyId: body.bodyId,
        edgeHashes
      };
    }

    if (operation.kind === 'add_edge_modifier' && referencesSelectedEdges) {
      if (!edgesShareBody || selectedEdgeHashes.length === 0) {
        throw new Error('AI selected edge target is ambiguous.');
      }
      if (
        operation.targetBodyId === selectedEdgeBodyId &&
        sameStrings(
          operation.edgeHashes.map(String),
          selectedEdgeHashes.map(String)
        )
      ) {
        return operation;
      }
      changed = true;
      return {
        ...operation,
        targetBodyId: selectedEdgeBodyId,
        edgeHashes: selectedEdgeHashes
      };
    }

    if (
      referencesSelectedFeature &&
      selectedFeatureId &&
      (operation.kind === 'set_feature_dimension' ||
        operation.kind === 'delete_feature' ||
        operation.kind === 'rename_feature') &&
      operation.featureId !== selectedFeatureId
    ) {
      changed = true;
      return { ...operation, featureId: selectedFeatureId as FeatureId };
    }

    // A `$alias` names a body this same patch is creating, so it can never
    // equal a body id from the digest — comparing them rejected the shape the
    // system prompt asks for. "Add a lid to this part" answers with the lid
    // created and then parked beside the selection via `add_transform` on the
    // alias, and the whole reply was discarded before the user ever saw it.
    // `add_boolean` has no placement field, so a boolean-derived companion
    // part can only be positioned this way.
    //
    // The guard is worth keeping for real ids: it catches a model that says
    // "this body" and then targets a different existing one.
    if (
      referencesSelectedBody &&
      selectedBodyId &&
      (operation.kind === 'add_transform' ||
        operation.kind === 'add_imported_opening_recipe' ||
        operation.kind === 'add_growing_holder_recipe' ||
        operation.kind === 'add_pattern') &&
      !isLocalBodyRef(operation.targetBodyId) &&
      operation.targetBodyId !== selectedBodyId
    ) {
      throw new Error(
        `AI targeted ${operation.targetBodyId} while the prompt referred to the selected body.`
      );
    }

    if (
      referencesSelectedBody &&
      selection.bodyIds.length >= 2 &&
      operation.kind === 'add_boolean' &&
      !sameStrings(
        operation.targetBodyIds.filter((id) => !isLocalBodyRef(id)),
        selection.bodyIds
      )
    ) {
      throw new Error(
        'AI combined a different set of bodies than the prompt selected.'
      );
    }

    return operation;
  });

  return changed ? { ...proposal, operations } : proposal;
}

const scalarSchema = {
  anyOf: [{ type: 'number' }, { type: 'string' }]
} as const;
const nullableScalarSchema = {
  anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }]
} as const;
const vectorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { x: scalarSchema, y: scalarSchema, z: scalarSchema },
  required: ['x', 'y', 'z']
} as const;
// Strict structured output requires every property to appear in `required`, so
// an "omit this" field has to be expressed as an explicit null instead.
const sketchObjectSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectKind: { type: 'string', const: 'rectangle' },
        width: scalarSchema,
        height: scalarSchema,
        centerX: scalarSchema,
        centerY: scalarSchema
      },
      required: ['objectKind', 'width', 'height', 'centerX', 'centerY']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectKind: { type: 'string', const: 'circle' },
        radius: scalarSchema,
        centerX: scalarSchema,
        centerY: scalarSchema
      },
      required: ['objectKind', 'radius', 'centerX', 'centerY']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectKind: { type: 'string', const: 'polygon' },
        sides: { type: 'integer', minimum: 3, maximum: 64 },
        radius: scalarSchema,
        centerX: scalarSchema,
        centerY: scalarSchema
      },
      required: ['objectKind', 'sides', 'radius', 'centerX', 'centerY']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectKind: { type: 'string', const: 'line' },
        x1: scalarSchema,
        y1: scalarSchema,
        x2: scalarSchema,
        y2: scalarSchema
      },
      required: ['objectKind', 'x1', 'y1', 'x2', 'y2']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectKind: { type: 'string', const: 'arc' },
        centerX: scalarSchema,
        centerY: scalarSchema,
        radius: scalarSchema,
        startAngleDeg: scalarSchema,
        endAngleDeg: scalarSchema
      },
      required: [
        'objectKind',
        'centerX',
        'centerY',
        'radius',
        'startAngleDeg',
        'endAngleDeg'
      ]
    },
    {
      // `rotation` and `align` are deliberately absent: strict structured
      // output requires every declared property in `required`, so an optional
      // field has to be offered as an explicit null, and a null would land in
      // the document as a ParamValue that cannot resolve. They stay editor-only
      // until there is a reason to spend a nullable field on them.
      type: 'object',
      additionalProperties: false,
      properties: {
        objectKind: { type: 'string', const: 'text' },
        text: { type: 'string', description: 'The string to render.' },
        fontFamily: {
          type: 'string',
          enum: [
            'inter',
            'open-sans',
            'lora',
            'roboto-slab',
            'jetbrains-mono',
            'oswald',
            'pacifico'
          ],
          description:
            'Bundled font family id. Open Sans keeps its glyph curves exact through the kernel; Inter, JetBrains Mono and Pacifico have self-overlapping glyphs that arrive faceted.'
        },
        fontStyle: {
          type: 'string',
          enum: ['regular', 'bold', 'italic', 'boldItalic']
        },
        size: scalarSchema,
        x: scalarSchema,
        y: scalarSchema
      },
      required: [
        'objectKind',
        'text',
        'fontFamily',
        'fontStyle',
        'size',
        'x',
        'y'
      ]
    }
  ]
} as const;

const localIdSchema = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
  description:
    'Alias for the body this operation creates, e.g. "box_outer", or null when nothing needs to refer to it. Later operations in this same proposal reference it as "$box_outer".'
} as const;
const bodyRefSchema = {
  type: 'string',
  description:
    'An existing bodyId from the digest, or "$localId" naming a body created earlier in this proposal.'
} as const;

const existingBodyRefSchema = {
  type: 'string',
  pattern: '^(?!\\$).+',
  description:
    'An existing live bodyId from the current digest. Topology-dependent operations cannot target a same-proposal alias.'
} as const;

const numberVectorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' }
  },
  required: ['x', 'y', 'z']
} as const;

const sectionObjectSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectKind: { type: 'string', const: 'line' },
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' }
      },
      required: ['objectKind', 'x1', 'y1', 'x2', 'y2']
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectKind: { type: 'string', const: 'arc' },
        centerX: { type: 'number' },
        centerY: { type: 'number' },
        radius: { type: 'number' },
        startAngleDeg: { type: 'number' },
        endAngleDeg: { type: 'number' }
      },
      required: [
        'objectKind',
        'centerX',
        'centerY',
        'radius',
        'startAngleDeg',
        'endAngleDeg'
      ]
    }
  ]
} as const;

const recognizedOpeningSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    "A measured opening copied verbatim from the digest body's recognizedOpening.opening. Never invent or edit any field.",
  properties: {
    axis: { type: 'string', enum: ['x', 'y', 'z'] },
    envelope: {
      type: 'object',
      additionalProperties: false,
      properties: { min: numberVectorSchema, max: numberVectorSchema },
      required: ['min', 'max']
    },
    cuts: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'number' }
    },
    center: { type: 'number' },
    sourceOpening: { type: 'number' },
    minimumOpening: { type: 'number' },
    section: { type: 'array', minItems: 2, items: sectionObjectSchema },
    lettering: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            side: { type: 'string', enum: ['negative', 'positive'] },
            selection: {
              type: 'object',
              additionalProperties: false,
              properties: {
                supportFaceHash: { type: 'integer' },
                capFaceHashes: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 64,
                  items: { type: 'integer' }
                },
                normal: numberVectorSchema,
                depth: { type: 'number' },
                bounds: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    min: numberVectorSchema,
                    max: numberVectorSchema
                  },
                  required: ['min', 'max']
                }
              },
              required: [
                'supportFaceHash',
                'capFaceHashes',
                'normal',
                'depth',
                'bounds'
              ]
            }
          },
          required: ['side', 'selection']
        },
        { type: 'null' }
      ],
      description:
        'Copy measured lettering verbatim, or null when absent. The recipe separates it into one rigid Text body and creates show_text; never guess face hashes or depth.'
    },
    height: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            axis: { type: 'string', enum: ['x', 'y', 'z'] },
            cuts: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: { type: 'number' }
            },
            sourceHeight: { type: 'number' },
            minimumHeight: { type: 'number' },
            sections: {
              type: 'object',
              additionalProperties: false,
              properties: {
                negative: {
                  type: 'array',
                  minItems: 2,
                  items: sectionObjectSchema
                },
                positive: {
                  type: 'array',
                  minItems: 2,
                  items: sectionObjectSchema
                }
              },
              required: ['negative', 'positive']
            },
            straightRuns: {
              type: 'object',
              additionalProperties: false,
              properties: {
                negative: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 2,
                  items: { type: 'number' }
                },
                positive: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 2,
                  items: { type: 'number' }
                }
              },
              required: ['negative', 'positive']
            }
          },
          required: [
            'axis',
            'cuts',
            'sourceHeight',
            'minimumHeight',
            'sections',
            'straightRuns'
          ]
        },
        { type: 'null' }
      ],
      description:
        'The measured arm-height control, copied verbatim when the digest has one; null otherwise.'
    }
  },
  required: [
    'axis',
    'envelope',
    'cuts',
    'center',
    'sourceOpening',
    'minimumOpening',
    'section',
    'height',
    'lettering'
  ]
} as const;

const faceReferenceSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Schema-v5 face reference copied verbatim from the current digest. Never invent or edit any field.',
  properties: {
    kind: { type: 'string', const: 'face' },
    producingFeatureId: { type: 'string' },
    lineageName: { type: 'string' },
    currentHash: { type: 'integer', minimum: 1 },
    witnessVersion: { type: 'number', const: 1 },
    witness: {
      type: 'object',
      additionalProperties: false,
      properties: {
        surfaceType: { type: 'string' },
        perimeter: { type: 'integer', minimum: 0 },
        centroid: {
          anyOf: [
            {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: { type: 'integer' }
            },
            { type: 'null' }
          ]
        },
        analytic: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'plane' },
                normal: {
                  type: 'array',
                  minItems: 3,
                  maxItems: 3,
                  items: { type: 'integer' }
                },
                offset: { type: 'integer' }
              },
              required: ['kind', 'normal', 'offset']
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'cylinder' },
                axis: {
                  type: 'array',
                  minItems: 3,
                  maxItems: 3,
                  items: { type: 'integer' }
                },
                axisFoot: {
                  type: 'array',
                  minItems: 3,
                  maxItems: 3,
                  items: { type: 'integer' }
                },
                radius: { type: 'integer', minimum: 0 }
              },
              required: ['kind', 'axis', 'axisFoot', 'radius']
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: { kind: { type: 'string', const: 'none' } },
              required: ['kind']
            }
          ]
        },
        closure: {
          type: 'object',
          additionalProperties: false,
          properties: {
            u: { type: 'string', enum: ['open', 'closed', 'unknown'] },
            v: { type: 'string', enum: ['open', 'closed', 'unknown'] }
          },
          required: ['u', 'v']
        }
      },
      required: ['surfaceType', 'perimeter', 'centroid', 'analytic', 'closure']
    }
  },
  required: [
    'kind',
    'producingFeatureId',
    'lineageName',
    'currentHash',
    'witnessVersion',
    'witness'
  ]
} as const;

const sketchFrameSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    origin: numberVectorSchema,
    xAxis: numberVectorSchema,
    yAxis: numberVectorSchema,
    zAxis: numberVectorSchema
  },
  required: ['origin', 'xAxis', 'yAxis', 'zAxis']
} as const;

const facePlaneRefSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Copy bodyId, faceHash, faceReference, source geometry, and frame from one referenced planar face in the current digest.',
  properties: {
    type: { type: 'string', const: 'face' },
    bodyId: existingBodyRefSchema,
    faceHash: { type: 'integer', minimum: 1 },
    faceReference: faceReferenceSchema,
    sourceArea: { type: 'number', minimum: 0 },
    sourceCenter: numberVectorSchema,
    sourceCentroid: {
      anyOf: [numberVectorSchema, { type: 'null' }],
      description:
        'Copy the digest centroid exactly, or null when the referenced legacy snapshot has none.'
    },
    sourceNormal: numberVectorSchema,
    frame: sketchFrameSchema
  },
  required: [
    'type',
    'bodyId',
    'faceHash',
    'faceReference',
    'sourceArea',
    'sourceCenter',
    'sourceCentroid',
    'sourceNormal',
    'frame'
  ]
} as const;

const datumRefSchema = {
  type: 'string',
  description:
    'A datum plane: an existing datum-plane featureId from the digest, or "$localId" naming an add_datum_plane earlier in this proposal.'
} as const;

// Flat, every field required: strict structured output cannot express "one
// of these shapes" for a nested object without anyOf, and null is clearer.
const datumPlaneSourceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['canonical', 'datum'] },
    plane: {
      anyOf: [{ type: 'string', enum: ['XY', 'XZ', 'YZ'] }, { type: 'null' }],
      description: 'The principal plane when type is "canonical", else null.'
    },
    offset: {
      ...nullableScalarSchema,
      description:
        'Offset of the principal plane along its normal when type is "canonical", else null.'
    },
    datum: {
      anyOf: [datumRefSchema, { type: 'null' }],
      description: 'The source datum when type is "datum", else null.'
    }
  },
  required: ['type', 'plane', 'offset', 'datum']
} as const;

const datumPlaneDefinitionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['offset', 'midplane'] },
    source: {
      anyOf: [datumPlaneSourceSchema, { type: 'null' }],
      description:
        'The plane an offset plane is measured from; null for a midplane.'
    },
    sources: {
      anyOf: [
        {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: datumPlaneSourceSchema
        },
        { type: 'null' }
      ],
      description:
        'The two parallel planes a midplane lies halfway between; null for an offset plane.'
    },
    offset: {
      ...nullableScalarSchema,
      description:
        'Signed distance along the source normal for an offset plane; null for a midplane.'
    },
    reverseNormal: {
      anyOf: [{ type: 'boolean' }, { type: 'null' }],
      description:
        "Flip the new plane's normal without moving it; null for false."
    }
  },
  required: ['kind', 'source', 'sources', 'offset', 'reverseNormal']
} as const;

const edgeReferenceSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'Exact schema-v5 edge identity copied verbatim from one current digest edge.',
  properties: {
    kind: { type: 'string', const: 'edge' },
    producingFeatureId: { type: 'string' },
    lineageName: { type: 'string' },
    currentHash: { type: 'integer', minimum: 1 },
    witnessVersion: { type: 'number', const: 1 },
    witness: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            curveType: { type: 'string' },
            length: { type: 'integer', minimum: 0 },
            closed: { type: 'boolean', const: false },
            endpoints: {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: {
                type: 'array',
                minItems: 3,
                maxItems: 3,
                items: { type: 'integer' }
              }
            },
            midpoint: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: { type: 'integer' }
            }
          },
          required: ['curveType', 'length', 'closed', 'endpoints', 'midpoint']
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            curveType: { type: 'string' },
            length: { type: 'integer', minimum: 0 },
            closed: { type: 'boolean', const: true },
            center: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: { type: 'integer' }
            },
            axis: {
              anyOf: [
                {
                  type: 'array',
                  minItems: 3,
                  maxItems: 3,
                  items: { type: 'integer' }
                },
                { type: 'null' }
              ]
            }
          },
          required: ['curveType', 'length', 'closed', 'center', 'axis']
        }
      ]
    }
  },
  required: [
    'kind',
    'producingFeatureId',
    'lineageName',
    'currentHash',
    'witnessVersion',
    'witness'
  ]
} as const;

function strictDatumObject<const T extends Record<string, unknown>>(
  properties: T
) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties)
  } as const;
}

const datumGeometryPlaneSourceSchema = {
  anyOf: [
    datumPlaneSourceSchema,
    {
      ...facePlaneRefSchema,
      properties: {
        ...facePlaneRefSchema.properties,
        sourceCentroid: numberVectorSchema
      }
    }
  ]
} as const;
const datumPointSourceSchema = {
  anyOf: [
    strictDatumObject({
      type: { type: 'string', const: 'point' },
      point: vectorSchema
    }),
    strictDatumObject({
      type: { type: 'string', const: 'edge-vertex' },
      bodyId: existingBodyRefSchema,
      edgeReference: edgeReferenceSchema,
      end: {
        type: 'integer',
        enum: [0, 1],
        description:
          'End 0 sorts before end 1 by the exact witness integer coordinates: x, then y, then z.'
      }
    })
  ]
} as const;
const nullableDatumReverseSchema = {
  anyOf: [{ type: 'boolean' }, { type: 'null' }]
} as const;
const datumGeometryPlaneDefinitionSchema = {
  anyOf: [
    strictDatumObject({
      kind: { type: 'string', const: 'offset' },
      source: datumGeometryPlaneSourceSchema,
      offset: scalarSchema,
      reverseNormal: nullableDatumReverseSchema
    }),
    strictDatumObject({
      kind: { type: 'string', const: 'midplane' },
      sources: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: datumGeometryPlaneSourceSchema
      },
      reverseNormal: nullableDatumReverseSchema
    }),
    strictDatumObject({
      kind: { type: 'string', const: 'three-point' },
      points: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: datumPointSourceSchema
      },
      reverseNormal: nullableDatumReverseSchema
    }),
    strictDatumObject({
      kind: { type: 'string', const: 'parallel-point' },
      source: datumGeometryPlaneSourceSchema,
      point: datumPointSourceSchema,
      reverseNormal: nullableDatumReverseSchema
    })
  ]
} as const;
const datumAxisRefSchema = {
  type: 'string',
  description:
    'An existing datum-axis featureId, or "$localId" naming an add_datum_axis earlier in this proposal.'
} as const;
const datumAxisDefinitionSchema = {
  anyOf: [
    strictDatumObject({
      kind: { type: 'string', const: 'two-point' },
      points: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: datumPointSourceSchema
      },
      reverseDirection: nullableDatumReverseSchema
    }),
    strictDatumObject({
      kind: { type: 'string', const: 'edge' },
      source: strictDatumObject({
        type: { type: 'string', const: 'edge' },
        bodyId: existingBodyRefSchema,
        edgeReference: edgeReferenceSchema
      }),
      reverseDirection: nullableDatumReverseSchema
    }),
    strictDatumObject({
      kind: { type: 'string', const: 'cylinder' },
      source: strictDatumObject({
        type: { type: 'string', const: 'face' },
        bodyId: existingBodyRefSchema,
        faceReference: faceReferenceSchema
      }),
      reverseDirection: nullableDatumReverseSchema
    }),
    strictDatumObject({
      kind: { type: 'string', const: 'plane-intersection' },
      sources: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: datumGeometryPlaneSourceSchema
      },
      reverseDirection: nullableDatumReverseSchema
    })
  ]
} as const;

const parametricPlaneSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { origin: vectorSchema, normal: vectorSchema },
  required: ['origin', 'normal']
} as const;

const directEditOperationSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'resize-through-hole' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        sourceDiameter: { type: 'number', exclusiveMinimum: 0 },
        sourceAxisStart: numberVectorSchema,
        sourceAxisEnd: numberVectorSchema,
        diameter: scalarSchema
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'sourceDiameter',
        'sourceAxisStart',
        'sourceAxisEnd',
        'diameter'
      ]
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'resize-imported-blind-hole' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        sourceOpeningPoint: numberVectorSchema,
        sourceAxisDirection: numberVectorSchema,
        sourceDiameter: { type: 'number', exclusiveMinimum: 0 },
        sourceDepth: { type: 'number', exclusiveMinimum: 0 },
        diameter: scalarSchema,
        depth: scalarSchema
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'sourceOpeningPoint',
        'sourceAxisDirection',
        'sourceDiameter',
        'sourceDepth',
        'diameter',
        'depth'
      ]
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'resize-imported-counterbore' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        sourceOpeningPoint: numberVectorSchema,
        sourceAxisDirection: numberVectorSchema,
        sourceBoreDiameter: { type: 'number', exclusiveMinimum: 0 },
        sourceCounterboreDiameter: { type: 'number', exclusiveMinimum: 0 },
        sourceCounterboreDepth: { type: 'number', exclusiveMinimum: 0 },
        sourceTotalDepth: { type: 'number', exclusiveMinimum: 0 },
        sourceEntryChamfered: { type: 'boolean' },
        boreDiameter: scalarSchema,
        counterboreDiameter: scalarSchema,
        counterboreDepth: scalarSchema
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'sourceOpeningPoint',
        'sourceAxisDirection',
        'sourceBoreDiameter',
        'sourceCounterboreDiameter',
        'sourceCounterboreDepth',
        'sourceTotalDepth',
        'sourceEntryChamfered',
        'boreDiameter',
        'counterboreDiameter',
        'counterboreDepth'
      ]
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'resize-imported-countersink' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        sourceOpeningPoint: numberVectorSchema,
        sourceAxisDirection: numberVectorSchema,
        sourceBoreDiameter: { type: 'number', exclusiveMinimum: 0 },
        sourceSinkDiameter: { type: 'number', exclusiveMinimum: 0 },
        sourceAngleRadians: {
          type: 'number',
          exclusiveMinimum: 0,
          exclusiveMaximum: Math.PI
        },
        sourceCountersinkDepth: { type: 'number', exclusiveMinimum: 0 },
        sourceTotalDepth: { type: 'number', exclusiveMinimum: 0 },
        boreDiameter: scalarSchema,
        sinkDiameter: scalarSchema,
        angleRadians: scalarSchema
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'sourceOpeningPoint',
        'sourceAxisDirection',
        'sourceBoreDiameter',
        'sourceSinkDiameter',
        'sourceAngleRadians',
        'sourceCountersinkDepth',
        'sourceTotalDepth',
        'boreDiameter',
        'sinkDiameter',
        'angleRadians'
      ]
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'remove-face-feature' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        sourceSurfaceType: { type: 'string' },
        sourceArea: { type: 'number', exclusiveMinimum: 0 },
        sourceCenter: numberVectorSchema,
        sourceDiameter: {
          anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'null' }]
        },
        sourceAxisStart: {
          anyOf: [numberVectorSchema, { type: 'null' }]
        },
        sourceAxisEnd: {
          anyOf: [numberVectorSchema, { type: 'null' }]
        }
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'sourceSurfaceType',
        'sourceArea',
        'sourceCenter',
        'sourceDiameter',
        'sourceAxisStart',
        'sourceAxisEnd'
      ]
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'offset-face' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        sourceSurfaceType: { type: 'string', const: 'plane' },
        sourceArea: { type: 'number', exclusiveMinimum: 0 },
        sourceCenter: numberVectorSchema,
        sourceNormal: numberVectorSchema,
        offset: scalarSchema
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'sourceSurfaceType',
        'sourceArea',
        'sourceCenter',
        'sourceNormal',
        'offset'
      ]
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'set-face-distance' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        oppositeFaceHash: { type: 'integer', minimum: 1 },
        oppositeFaceReference: faceReferenceSchema,
        sourceDistance: { type: 'number', exclusiveMinimum: 0 },
        moveMode: {
          type: 'string',
          enum: ['symmetric', 'one-sided-first', 'one-sided-second']
        },
        distance: scalarSchema
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'oppositeFaceHash',
        'oppositeFaceReference',
        'sourceDistance',
        'moveMode',
        'distance'
      ]
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'resize-cylindrical-face' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        sourceRadius: { type: 'number', exclusiveMinimum: 0 },
        sourceAxisStart: numberVectorSchema,
        sourceAxisEnd: numberVectorSchema,
        concavity: { type: 'string', enum: ['hole', 'boss'] },
        radius: scalarSchema
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'sourceRadius',
        'sourceAxisStart',
        'sourceAxisEnd',
        'concavity',
        'radius'
      ]
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', const: 'resize-blend' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        surfaceClass: { type: 'string', enum: ['torus', 'cylinder'] },
        recordedRadius: { type: 'number', exclusiveMinimum: 0 },
        recordedCenter: numberVectorSchema,
        recordedAxis: numberVectorSchema,
        newRadius: scalarSchema
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'surfaceClass',
        'recordedRadius',
        'recordedCenter',
        'recordedAxis',
        'newRadius'
      ]
    }
  ]
} as const;

export const AI_CAD_OPERATION_CAPABILITIES = {
  set_feature_dimension: { enabled: true, reason: null },
  set_sketch_dimension: { enabled: true, reason: null },
  add_transform: { enabled: true, reason: null },
  add_imported_opening_recipe: { enabled: true, reason: null },
  add_growing_holder_recipe: { enabled: true, reason: null },
  add_growing_holder_hole_control: { enabled: true, reason: null },
  add_direct_edit: { enabled: true, reason: null },
  add_face_sketch: { enabled: true, reason: null },
  add_multi_profile_extrude: { enabled: true, reason: null },
  add_mirror: { enabled: true, reason: null },
  add_shell: { enabled: true, reason: null },
  add_solid_offset: { enabled: true, reason: null },
  add_datum_plane: { enabled: true, reason: null },
  add_datum_plane_v2: { enabled: true, reason: null },
  update_datum_plane: { enabled: true, reason: null },
  add_datum_axis: { enabled: true, reason: null },
  update_datum_axis: { enabled: true, reason: null },
  add_datum_revolve: { enabled: true, reason: null },
  add_datum_pattern: { enabled: true, reason: null },
  add_datum_transform: { enabled: true, reason: null },
  add_datum_sketch: { enabled: true, reason: null },
  add_datum_mirror: { enabled: true, reason: null },
  add_datum_split: { enabled: true, reason: null },
  recognized_imported_feature: {
    enabled: true,
    reason: null
  }
} as const;

/**
 * Upper bound on operations in one proposal. A box with a lid runs to ~18
 * (parameters, two primitives and a boolean per part, plus placement), so this
 * leaves room for a several-part assembly while still bounding a runaway patch.
 */
export const MAX_PATCH_OPERATIONS = 60;

export const CAD_PATCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proposalId: { type: 'string' },
    summary: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    preserveGeometry: {
      type: 'boolean',
      description:
        'True only for a naming, binding, or parameter-structure refactor that must leave the current exact bodies unchanged; false when the requested result intentionally changes geometry.'
    },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PATCH_OPERATIONS,
      description:
        'Enabled deterministic operations only. Recognized imported-feature editing is intentionally omitted until recognition diagnostics expose an exact stable command contract.',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            description:
              'Select an app-measured editCatalog candidate. The browser builds its exact commands, just like the direct UI action. Use only a candidate listed in the current digest. This creates parameter bindings at their current values; request value changes in a later proposal. Do not mix with other operation kinds.',
            properties: {
              kind: { type: 'string', const: 'use_edit_candidate' },
              candidateId: { type: 'string' },
              targetBodyId: { type: 'string' },
              parameterNames: {
                type: 'array',
                maxItems: 30,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    key: { type: 'string' },
                    name: { type: 'string' }
                  },
                  required: ['key', 'name']
                }
              },
              analysis: {
                anyOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      bodyId: { type: 'string' },
                      faceHashes: {
                        type: 'array',
                        maxItems: 2,
                        items: { type: 'integer', minimum: 1 }
                      }
                    },
                    required: ['bodyId', 'faceHashes']
                  },
                  { type: 'null' }
                ]
              }
            },
            required: [
              'kind',
              'candidateId',
              'targetBodyId',
              'parameterNames',
              'analysis'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'set_parameter' },
              name: { type: 'string' },
              expression: { type: 'string' }
            },
            required: ['kind', 'name', 'expression']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'rename_parameter' },
              name: { type: 'string' },
              newName: { type: 'string' }
            },
            required: ['kind', 'name', 'newName']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'delete_parameter' },
              name: { type: 'string' }
            },
            required: ['kind', 'name']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'set_feature_dimension' },
              featureId: { type: 'string' },
              field: { type: 'string' },
              value: scalarSchema
            },
            required: ['kind', 'featureId', 'field', 'value']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'set_sketch_dimension' },
              sketchId: { type: 'string' },
              objectId: { type: 'string' },
              field: { type: 'string' },
              value: scalarSchema
            },
            required: ['kind', 'sketchId', 'objectId', 'field', 'value']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_primitive' },
              name: { type: 'string' },
              localId: localIdSchema,
              primitiveKind: {
                type: 'string',
                enum: ['box', 'cylinder', 'sphere', 'cone', 'torus']
              },
              dimensions: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: nullableScalarSchema,
                  height: nullableScalarSchema,
                  depth: nullableScalarSchema,
                  radius: nullableScalarSchema,
                  bottomRadius: nullableScalarSchema,
                  topRadius: nullableScalarSchema,
                  majorRadius: nullableScalarSchema,
                  minorRadius: nullableScalarSchema
                },
                required: [
                  'width',
                  'height',
                  'depth',
                  'radius',
                  'bottomRadius',
                  'topRadius',
                  'majorRadius',
                  'minorRadius'
                ]
              }
            },
            required: ['kind', 'name', 'localId', 'primitiveKind', 'dimensions']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'delete_feature' },
              featureId: { type: 'string' }
            },
            required: ['kind', 'featureId']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'rename_feature' },
              featureId: { type: 'string' },
              name: { type: 'string' }
            },
            required: ['kind', 'featureId', 'name']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_sketch' },
              name: { type: 'string' },
              localId: localIdSchema,
              plane: { type: 'string', enum: ['XY', 'XZ', 'YZ'] },
              offset: scalarSchema,
              objects: {
                type: 'array',
                minItems: 1,
                maxItems: 24,
                items: sketchObjectSchema
              }
            },
            required: ['kind', 'name', 'localId', 'plane', 'offset', 'objects']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_extrude' },
              name: { type: 'string' },
              localId: localIdSchema,
              sketchId: { type: 'string' },
              distance: scalarSchema,
              samplePoint: {
                anyOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      x: { type: 'number' },
                      y: { type: 'number' }
                    },
                    required: ['x', 'y']
                  },
                  { type: 'null' }
                ]
              }
            },
            required: [
              'kind',
              'name',
              'localId',
              'sketchId',
              'distance',
              'samplePoint'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_revolve' },
              name: { type: 'string' },
              localId: localIdSchema,
              sketchId: { type: 'string' },
              axis: { type: 'string', enum: ['horizontal', 'vertical'] },
              // Null is a full turn. Pruned from this schema entirely while
              // AI_PATCH_PARTIAL_REVOLVE_ENABLED is off.
              angleDeg: nullableScalarSchema
            },
            required: [
              'kind',
              'name',
              'localId',
              'sketchId',
              'axis',
              'angleDeg'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            description:
              'Grow the measured opening of an unmodified imported STEP body. Copy the body\'s digest `recognizedOpening.opening` verbatim into `opening` when its status is "recognized"; never author cuts, envelope or section values. The compiler carves both ends from the import, rebuilds the straight section at a length driven by `parameter`, and joins them; overall size follows the opening.',
            properties: {
              kind: { type: 'string', const: 'add_growing_holder_recipe' },
              name: { type: 'string' },
              localId: localIdSchema,
              targetBodyId: existingBodyRefSchema,
              parameter: {
                type: 'string',
                description:
                  'Parameter name that drives the opening, e.g. "opening_width".'
              },
              heightParameter: {
                anyOf: [{ type: 'string' }, { type: 'null' }],
                description:
                  'Parameter name for the arm height when the opening carries a measured height, e.g. "holder_height"; null otherwise.'
              },
              opening: recognizedOpeningSchema
            },
            required: [
              'kind',
              'name',
              'localId',
              'targetBodyId',
              'parameter',
              'heightParameter',
              'opening'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            description:
              "Drive the two mirrored mounting bores of a growing holder by one parameter. `holes` must be the app's own measurements copied verbatim; never author them.",
            properties: {
              kind: {
                type: 'string',
                const: 'add_growing_holder_hole_control'
              },
              name: { type: 'string' },
              targetBodyId: existingBodyRefSchema,
              parameter: { type: 'string' },
              holes: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    bodyId: { type: 'string' },
                    faceHash: { type: 'integer' },
                    faceReference: faceReferenceSchema,
                    sourceDiameter: { type: 'number' },
                    sourceAxisStart: numberVectorSchema,
                    sourceAxisEnd: numberVectorSchema
                  },
                  required: [
                    'bodyId',
                    'faceHash',
                    'faceReference',
                    'sourceDiameter',
                    'sourceAxisStart',
                    'sourceAxisEnd'
                  ]
                }
              }
            },
            required: ['kind', 'name', 'targetBodyId', 'parameter', 'holes']
          },
          {
            type: 'object',
            additionalProperties: false,
            description:
              'Explicit localized opening recipe for an unmodified imported STEP. Two nonoverlapping coordinate regions, negative then positive, retain their intersection with the original source translated by +/- (width-sourceWidth)/2 and reattach to the unchanged outside. Requires measured regions and exact preflight; not general face-distance recognition. Use a named parameter for width. Only sourceWidth and the explicitly tested editedWidth are supported, not the interval between them. Exact preflight must qualify the edited result.',
            properties: {
              kind: { type: 'string', const: 'add_imported_opening_recipe' },
              name: { type: 'string' },
              localId: localIdSchema,
              targetBodyId: bodyRefSchema,
              sourceWidth: { type: 'number', exclusiveMinimum: 0 },
              editedWidth: { type: 'number', exclusiveMinimum: 0 },
              width: scalarSchema,
              axis: { type: 'string', enum: ['x', 'y', 'z'] },
              regions: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    min: numberVectorSchema,
                    max: numberVectorSchema
                  },
                  required: ['min', 'max']
                }
              }
            },
            required: [
              'kind',
              'name',
              'localId',
              'targetBodyId',
              'sourceWidth',
              'editedWidth',
              'width',
              'axis',
              'regions'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_boolean' },
              name: { type: 'string' },
              localId: localIdSchema,
              operation: {
                type: 'string',
                enum: ['union', 'subtract', 'intersect']
              },
              targetBodyIds: {
                type: 'array',
                minItems: 2,
                maxItems: 12,
                items: bodyRefSchema
              }
            },
            required: ['kind', 'name', 'localId', 'operation', 'targetBodyIds']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_transform' },
              name: { type: 'string' },
              targetBodyId: bodyRefSchema,
              translation: vectorSchema,
              rotationDeg: vectorSchema
            },
            required: [
              'kind',
              'name',
              'targetBodyId',
              'translation',
              'rotationDeg'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_direct_edit' },
              name: { type: 'string' },
              targetBodyId: existingBodyRefSchema,
              operation: directEditOperationSchema
            },
            required: ['kind', 'name', 'targetBodyId', 'operation']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_face_sketch' },
              name: { type: 'string' },
              localId: localIdSchema,
              planeRef: facePlaneRefSchema,
              objects: {
                type: 'array',
                minItems: 1,
                maxItems: 24,
                items: sketchObjectSchema
              }
            },
            required: ['kind', 'name', 'localId', 'planeRef', 'objects']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: {
                type: 'string',
                const: 'add_multi_profile_extrude'
              },
              name: { type: 'string' },
              localId: localIdSchema,
              sketchId: { type: 'string' },
              distance: scalarSchema,
              samplePoints: {
                type: 'array',
                minItems: 2,
                maxItems: 24,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' }
                  },
                  required: ['x', 'y']
                }
              }
            },
            required: [
              'kind',
              'name',
              'localId',
              'sketchId',
              'distance',
              'samplePoints'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_mirror' },
              name: { type: 'string' },
              localId: localIdSchema,
              targetBodyId: bodyRefSchema,
              plane: parametricPlaneSchema
            },
            required: ['kind', 'name', 'localId', 'targetBodyId', 'plane']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_shell' },
              name: { type: 'string' },
              localId: localIdSchema,
              targetBodyId: existingBodyRefSchema,
              openingFaceHashes: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: { type: 'integer', minimum: 1 }
              },
              openingFaceReferences: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: faceReferenceSchema
              },
              thickness: scalarSchema
            },
            required: [
              'kind',
              'name',
              'localId',
              'targetBodyId',
              'openingFaceHashes',
              'openingFaceReferences',
              'thickness'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_solid_offset' },
              name: { type: 'string' },
              localId: localIdSchema,
              targetBodyId: bodyRefSchema,
              distance: scalarSchema
            },
            required: ['kind', 'name', 'localId', 'targetBodyId', 'distance']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_datum_plane' },
              name: { type: 'string' },
              localId: localIdSchema,
              definition: datumPlaneDefinitionSchema
            },
            required: ['kind', 'name', 'localId', 'definition']
          },
          strictDatumObject({
            kind: { type: 'string', const: 'add_datum_plane_v2' },
            name: { type: 'string' },
            localId: localIdSchema,
            definition: datumGeometryPlaneDefinitionSchema
          }),
          strictDatumObject({
            kind: { type: 'string', const: 'update_datum_plane' },
            featureId: datumRefSchema,
            definition: datumGeometryPlaneDefinitionSchema
          }),
          strictDatumObject({
            kind: { type: 'string', const: 'add_datum_axis' },
            name: { type: 'string' },
            localId: localIdSchema,
            definition: datumAxisDefinitionSchema
          }),
          strictDatumObject({
            kind: { type: 'string', const: 'update_datum_axis' },
            featureId: datumAxisRefSchema,
            definition: datumAxisDefinitionSchema
          }),
          strictDatumObject({
            kind: { type: 'string', const: 'add_datum_revolve' },
            name: { type: 'string' },
            localId: localIdSchema,
            sketchId: { type: 'string' },
            datum: datumAxisRefSchema,
            angleDeg: scalarSchema
          }),
          strictDatumObject({
            kind: { type: 'string', const: 'add_datum_pattern' },
            name: { type: 'string' },
            localId: localIdSchema,
            targetBodyId: bodyRefSchema,
            datum: datumAxisRefSchema,
            count: scalarSchema,
            angleDeg: scalarSchema
          }),
          strictDatumObject({
            kind: { type: 'string', const: 'add_datum_transform' },
            name: { type: 'string' },
            targetBodyId: bodyRefSchema,
            datum: datumAxisRefSchema,
            angleDeg: scalarSchema,
            translation: vectorSchema
          }),
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_datum_sketch' },
              name: { type: 'string' },
              localId: localIdSchema,
              datum: datumRefSchema,
              objects: {
                type: 'array',
                minItems: 1,
                maxItems: 24,
                items: sketchObjectSchema
              }
            },
            required: ['kind', 'name', 'localId', 'datum', 'objects']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_datum_mirror' },
              name: { type: 'string' },
              localId: localIdSchema,
              targetBodyId: bodyRefSchema,
              datum: datumRefSchema
            },
            required: ['kind', 'name', 'localId', 'targetBodyId', 'datum']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_datum_split' },
              name: { type: 'string' },
              localId: localIdSchema,
              secondLocalId: {
                ...localIdSchema,
                description:
                  'Alias for the half on the side opposite the datum normal, or null.'
              },
              targetBodyId: bodyRefSchema,
              datum: datumRefSchema
            },
            required: [
              'kind',
              'name',
              'localId',
              'secondLocalId',
              'targetBodyId',
              'datum'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_edge_modifier' },
              name: { type: 'string' },
              localId: localIdSchema,
              modifier: { type: 'string', enum: ['fillet', 'chamfer'] },
              targetBodyId: bodyRefSchema,
              edgeHashes: {
                type: 'array',
                minItems: 0,
                maxItems: 64,
                items: { type: 'integer', minimum: 1 }
              },
              edgeSelector: {
                anyOf: [
                  {
                    type: 'string',
                    enum: ['all-feature-edges', 'circular-rims']
                  },
                  { type: 'null' }
                ],
                description:
                  'Use a semantic selector only for a body created earlier in this proposal. Set null when edgeHashes come from the current digest.'
              },
              size: scalarSchema
            },
            required: [
              'kind',
              'name',
              'localId',
              'modifier',
              'targetBodyId',
              'edgeHashes',
              'edgeSelector',
              'size'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_pattern' },
              name: { type: 'string' },
              localId: localIdSchema,
              targetBodyId: bodyRefSchema,
              patternKind: { type: 'string', enum: ['linear', 'circular'] },
              count: scalarSchema,
              axis: { type: 'string', enum: ['x', 'y', 'z'] },
              spacing: scalarSchema,
              angleDeg: scalarSchema
            },
            required: [
              'kind',
              'name',
              'localId',
              'targetBodyId',
              'patternKind',
              'count',
              'axis',
              'spacing',
              'angleDeg'
            ]
          },
          ...DRAWING_OPERATION_SCHEMAS
        ]
      }
    }
  },
  required: [
    'proposalId',
    'summary',
    'assumptions',
    'preserveGeometry',
    'operations'
  ]
} as const;

/**
 * One earlier turn of the conversation, replayed so the model can see what it
 * already asked and what the user answered. Text only: the document state comes
 * from the single current digest, never from a per-turn snapshot.
 */
export interface AssistantHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
  /** Set on a user turn that answers a specific earlier question. */
  answeredQuestionId?: string;
}

export const ASSISTANT_ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp'
] as const;

export type AssistantAttachmentMediaType =
  (typeof ASSISTANT_ATTACHMENT_MEDIA_TYPES)[number];

/**
 * A page of a drawing the user attached, already rasterized to an image by the
 * client. PDFs are converted before upload so the server only ever handles this
 * short media-type allowlist, and the user sees the exact pixels the model does.
 */
export interface AssistantAttachment {
  id: string;
  mediaType: AssistantAttachmentMediaType;
  /** Base64 payload with no data-URL prefix. */
  dataBase64: string;
  /** Human label, e.g. "bracket.pdf page 2". */
  label: string;
}

export const MAX_ASSISTANT_HISTORY_TURNS = 12;
export const MAX_ASSISTANT_HISTORY_CHARS = 8_000;
export const MAX_ASSISTANT_ATTACHMENTS = 4;
/** Decoded bytes per attachment. A 2048px drawing scan lands well under this. */
export const MAX_ASSISTANT_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ASSISTANT_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;

/** A tappable suggested answer to an assistant question. */
export interface AssistantQuestionOption {
  /** Shown on the chip. */
  label: string;
  /** Sent back verbatim as the user's answer when the chip is tapped. */
  value: string;
}

export interface AssistantQuestion {
  /** Echoed back with the answer so a reply can be matched to its question. */
  id: string;
  prompt: string;
  options: AssistantQuestionOption[];
  /** True when a typed answer is acceptable in addition to the options. */
  allowFreeText: boolean;
  /** Unit the answer is expressed in, e.g. "mm", or null for a non-dimension. */
  unit: string | null;
}

/**
 * One dimension the model took off an attached drawing.
 *
 * Prose assumptions are not auditable: someone about to cut metal needs to see
 * that "⌀12" was read as 12 and not 1.2, and which view it came from.
 */
export interface AssistantDrawingReading {
  /** What the dimension is, e.g. "⌀12 H7 bore". */
  label: string;
  /** The value as used, in document units, or why it could not be used. */
  value: string;
  /** Where on the drawing it was read, e.g. "front view", "title block". */
  source: string;
  confidence: 'read' | 'inferred' | 'unreadable';
}

export const ASSISTANT_READING_CONFIDENCES = [
  'read',
  'inferred',
  'unreadable'
] as const;

export const MAX_ASSISTANT_READINGS = 40;

/**
 * What the assistant can return for one turn.
 *
 * Only `patch` changes the document. The other two exist because a strict
 * patch-only schema forces the model to invent numbers it should be asking
 * about, and to express "the vocabulary cannot do this" as a wrong patch.
 */
export type AssistantReply =
  | {
      kind: 'patch';
      proposal: CadPatchProposal;
      /** Populated when the turn carried a drawing; empty otherwise. */
      readings: AssistantDrawingReading[];
    }
  | {
      kind: 'questions';
      /** One or two sentences of context shown above the questions. */
      preamble: string;
      questions: AssistantQuestion[];
    }
  | { kind: 'message'; message: string };

export const MAX_ASSISTANT_QUESTIONS = 6;
export const MAX_ASSISTANT_QUESTION_OPTIONS = 6;

const questionOptionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string' },
    value: { type: 'string' }
  },
  required: ['label', 'value']
} as const;

/**
 * Strict structured output requires an object root, so the three reply shapes
 * are a `replyKind` discriminant plus one populated field and explicit nulls —
 * the same "omit this" idiom the patch schema already uses for absent numbers.
 * `message` carries the preamble on a questions reply and the whole text on a
 * message reply.
 */
/**
 * Every operation kind this build's proposal schema, and so its parser,
 * accepts. A client sends it with each request so the Worker never offers
 * the model an operation the requesting tab cannot parse — a tab loaded
 * before an operation shipped stays open across the deploy that adds it.
 */
export const CAD_PATCH_OPERATION_KINDS: readonly string[] =
  CAD_PATCH_JSON_SCHEMA.properties.operations.items.anyOf.map(
    (variant) => variant.properties.kind.const
  );

export const ASSISTANT_REPLY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    replyKind: { type: 'string', enum: ['patch', 'questions', 'message'] },
    proposal: {
      anyOf: [CAD_PATCH_JSON_SCHEMA, { type: 'null' }],
      description:
        'The model edit, when replyKind is "patch". Null for every other kind.'
    },
    questions: {
      anyOf: [
        {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ASSISTANT_QUESTIONS,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                pattern: SAFE_QUESTION_ID_PATTERN.source
              },
              prompt: { type: 'string' },
              options: {
                type: 'array',
                maxItems: MAX_ASSISTANT_QUESTION_OPTIONS,
                items: questionOptionSchema,
                description:
                  'Suggested answers offered as chips. Give at least one unless allowFreeText is true.'
              },
              allowFreeText: { type: 'boolean' },
              unit: { anyOf: [{ type: 'string' }, { type: 'null' }] }
            },
            required: ['id', 'prompt', 'options', 'allowFreeText', 'unit']
          }
        },
        { type: 'null' }
      ],
      description:
        'Questions to ask before modeling, when replyKind is "questions". Null otherwise.'
    },
    message: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description:
        'For "message", the whole reply. For "questions", a short preamble. Null for "patch".'
    },
    readings: {
      anyOf: [
        {
          type: 'array',
          maxItems: MAX_ASSISTANT_READINGS,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              source: { type: 'string' },
              confidence: {
                type: 'string',
                enum: [...ASSISTANT_READING_CONFIDENCES]
              }
            },
            required: ['label', 'value', 'source', 'confidence']
          }
        },
        { type: 'null' }
      ],
      description:
        'Every dimension taken off an attached drawing, with the view it came from. Null when no drawing was supplied.'
    }
  },
  required: ['replyKind', 'proposal', 'questions', 'message', 'readings']
} as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CAD patch proposal must be an object.');
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function parseAssistantQuestions(value: unknown): AssistantQuestion[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ASSISTANT_QUESTIONS
  ) {
    throw new Error(
      `A questions reply must carry 1 to ${MAX_ASSISTANT_QUESTIONS} questions.`
    );
  }
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    const question = record(candidate);
    const id = requireNonEmptyString(question.id, `questions[${index}].id`);
    if (!SAFE_QUESTION_ID_PATTERN.test(id)) {
      throw new Error('Unsafe question id.');
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate question id "${id}".`);
    }
    ids.add(id);
    const prompt = requireNonEmptyString(
      question.prompt,
      `questions[${index}].prompt`
    );
    if (typeof question.allowFreeText !== 'boolean') {
      throw new Error(`questions[${index}].allowFreeText must be a boolean.`);
    }
    if (!Array.isArray(question.options)) {
      throw new Error(`questions[${index}].options must be an array.`);
    }
    if (question.options.length > MAX_ASSISTANT_QUESTION_OPTIONS) {
      throw new Error(`questions[${index}].options has too many entries.`);
    }
    const options = question.options.map((rawOption, optionIndex) => {
      const option = record(rawOption);
      return {
        label: requireNonEmptyString(
          option.label,
          `questions[${index}].options[${optionIndex}].label`
        ),
        value: requireNonEmptyString(
          option.value,
          `questions[${index}].options[${optionIndex}].value`
        )
      };
    });
    // A question with neither chips nor a text field is unanswerable, which
    // would strand the conversation with no way forward.
    if (options.length === 0 && !question.allowFreeText) {
      throw new Error(
        `questions[${index}] offers no options and does not allow free text, so it cannot be answered.`
      );
    }
    return {
      id,
      prompt,
      options,
      allowFreeText: question.allowFreeText,
      unit:
        typeof question.unit === 'string' && question.unit.trim()
          ? question.unit.trim()
          : null
    };
  });
}

/**
 * Readings are advisory: they explain a patch rather than drive it, so an
 * unusable entry is dropped instead of failing an otherwise valid model.
 */
function parseAssistantReadings(value: unknown): AssistantDrawingReading[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_ASSISTANT_READINGS).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return [];
    }
    const reading = candidate as Record<string, unknown>;
    const confidence = ASSISTANT_READING_CONFIDENCES.includes(
      reading.confidence as AssistantDrawingReading['confidence']
    )
      ? (reading.confidence as AssistantDrawingReading['confidence'])
      : 'inferred';
    return typeof reading.label === 'string' &&
      reading.label.trim() &&
      typeof reading.value === 'string' &&
      reading.value.trim()
      ? [
          {
            label: reading.label.trim(),
            value: reading.value.trim(),
            source:
              typeof reading.source === 'string' && reading.source.trim()
                ? reading.source.trim()
                : 'unstated',
            confidence
          }
        ]
      : [];
  });
}

/**
 * Validates one assistant reply. The patch branch delegates to
 * `parseCadPatchProposal`, so a patch is held to exactly the same standard it
 * was before replies could be anything else.
 */
export function parseAssistantReply(
  value: unknown,
  digest?: CadDocumentDigest
): AssistantReply {
  const candidate = record(value);
  switch (candidate.replyKind) {
    case 'patch': {
      const proposal = record(candidate.proposal);
      if (Array.isArray(proposal.operations)) {
        for (const rawOperation of proposal.operations) {
          const operation = record(rawOperation);
          if (operation.kind !== 'add_direct_edit') {
            continue;
          }
          const edit = record(operation.operation);
          if (Object.hasOwn(edit, 'parameterBinding')) {
            throw new Error(
              'Assistant replies cannot create local parameter bindings.'
            );
          }
        }
      }
      return {
        kind: 'patch',
        proposal: parseCadPatchProposal(candidate.proposal, digest),
        readings: parseAssistantReadings(candidate.readings)
      };
    }
    case 'questions':
      return {
        kind: 'questions',
        preamble:
          typeof candidate.message === 'string' ? candidate.message.trim() : '',
        questions: parseAssistantQuestions(candidate.questions)
      };
    case 'message':
      return {
        kind: 'message',
        message: requireNonEmptyString(candidate.message, 'message')
      };
    default:
      throw new Error(
        `Unsupported assistant replyKind: ${String(candidate.replyKind)}.`
      );
  }
}

function isScalar(value: unknown): value is ParamValue {
  return typeof value === 'string' || typeof value === 'number';
}

function isVector(value: unknown): boolean {
  const vector = record(value);
  return isScalar(vector.x) && isScalar(vector.y) && isScalar(vector.z);
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Structural check of a measured opening; the digest binding proves provenance. */
function isRecognizedOpening(value: unknown): value is RecognizedOpening {
  if (!value || typeof value !== 'object') return false;
  const opening = value as Record<string, unknown>;
  const envelope = opening.envelope as Record<string, unknown> | undefined;
  return (
    ['x', 'y', 'z'].includes(String(opening.axis)) &&
    !!envelope &&
    isNumberVector(envelope.min) &&
    isNumberVector(envelope.max) &&
    Array.isArray(opening.cuts) &&
    opening.cuts.length === 2 &&
    opening.cuts.every(isFiniteNumber) &&
    isFiniteNumber(opening.center) &&
    isFiniteNumber(opening.sourceOpening) &&
    isFiniteNumber(opening.minimumOpening) &&
    isNumericSection(opening.section) &&
    (opening.height === undefined ||
      opening.height === null ||
      isRecognizedArmHeight(opening.height)) &&
    (opening.lettering === undefined ||
      opening.lettering === null ||
      isRecognizedLettering(opening.lettering))
  );
}

function isRecognizedLettering(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const lettering = value as Record<string, unknown>;
  const s = lettering.selection as Record<string, unknown> | undefined;
  const bounds = s?.bounds as Record<string, unknown> | undefined;
  return (
    ['negative', 'positive'].includes(String(lettering.side)) &&
    !!s &&
    Number.isSafeInteger(s.supportFaceHash) &&
    Array.isArray(s.capFaceHashes) &&
    s.capFaceHashes.length >= 2 &&
    s.capFaceHashes.length <= 64 &&
    s.capFaceHashes.every(Number.isSafeInteger) &&
    isNumberVector(s.normal) &&
    isFiniteNumber(s.depth) &&
    s.depth > 0 &&
    !!bounds &&
    isNumberVector(bounds.min) &&
    isNumberVector(bounds.max)
  );
}

function isNumericSection(value: unknown): value is SketchObjectData[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((object) => {
      if (!object || typeof object !== 'object') return false;
      const data = object as Record<string, unknown>;
      const fields =
        data.objectKind === 'line'
          ? ['x1', 'y1', 'x2', 'y2']
          : data.objectKind === 'arc'
            ? ['centerX', 'centerY', 'radius', 'startAngleDeg', 'endAngleDeg']
            : null;
      return (
        fields !== null &&
        Object.keys(data).length === fields.length + 1 &&
        fields.every((field) => isFiniteNumber(data[field]))
      );
    })
  );
}

const isPair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);

function isRecognizedArmHeight(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const height = value as Record<string, unknown>;
  const sections = height.sections as Record<string, unknown> | undefined;
  const runs = height.straightRuns as Record<string, unknown> | undefined;
  return (
    ['x', 'y', 'z'].includes(String(height.axis)) &&
    isPair(height.cuts) &&
    isFiniteNumber(height.sourceHeight) &&
    isFiniteNumber(height.minimumHeight) &&
    !!sections &&
    isNumericSection(sections.negative) &&
    isNumericSection(sections.positive) &&
    !!runs &&
    isPair(runs.negative) &&
    isPair(runs.positive)
  );
}

function isNumberVector(value: unknown): value is Vector3 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const vector = value as Record<string, unknown>;
  return [vector.x, vector.y, vector.z].every(
    (component) => typeof component === 'number' && Number.isFinite(component)
  );
}

function isQuantizedPoint(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => Number.isSafeInteger(component))
  );
}

function isEdgeReference(value: unknown): value is EdgeTopologyReferenceV5 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  if (
    reference.kind !== 'edge' ||
    typeof reference.producingFeatureId !== 'string' ||
    !reference.producingFeatureId.trim() ||
    typeof reference.lineageName !== 'string' ||
    !reference.lineageName.trim() ||
    !Number.isSafeInteger(reference.currentHash) ||
    Number(reference.currentHash) <= 0 ||
    reference.witnessVersion !== 1 ||
    !reference.witness ||
    typeof reference.witness !== 'object' ||
    Array.isArray(reference.witness)
  )
    return false;
  const witness = reference.witness as Record<string, unknown>;
  if (
    typeof witness.curveType !== 'string' ||
    !witness.curveType.trim() ||
    !Number.isSafeInteger(witness.length) ||
    Number(witness.length) < 0
  )
    return false;
  return witness.closed === false
    ? Array.isArray(witness.endpoints) &&
        witness.endpoints.length === 2 &&
        witness.endpoints.every(isQuantizedPoint) &&
        isQuantizedPoint(witness.midpoint)
    : witness.closed === true &&
        isQuantizedPoint(witness.center) &&
        (witness.axis === null || isQuantizedPoint(witness.axis));
}

function isFaceReference(value: unknown): value is FaceTopologyReferenceV5 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const reference = value as Record<string, unknown>;
  if (
    reference.kind !== 'face' ||
    typeof reference.producingFeatureId !== 'string' ||
    !reference.producingFeatureId.trim() ||
    typeof reference.lineageName !== 'string' ||
    !reference.lineageName.trim() ||
    !Number.isSafeInteger(reference.currentHash) ||
    Number(reference.currentHash) <= 0 ||
    reference.witnessVersion !== 1 ||
    !reference.witness ||
    typeof reference.witness !== 'object' ||
    Array.isArray(reference.witness)
  ) {
    return false;
  }
  const witness = reference.witness as Record<string, unknown>;
  if (
    typeof witness.surfaceType !== 'string' ||
    !Number.isSafeInteger(witness.perimeter) ||
    Number(witness.perimeter) < 0 ||
    (witness.centroid !== null && !isQuantizedPoint(witness.centroid)) ||
    !witness.closure ||
    typeof witness.closure !== 'object'
  ) {
    return false;
  }
  const closure = witness.closure as Record<string, unknown>;
  if (
    !['open', 'closed', 'unknown'].includes(String(closure.u)) ||
    !['open', 'closed', 'unknown'].includes(String(closure.v)) ||
    !witness.analytic ||
    typeof witness.analytic !== 'object' ||
    Array.isArray(witness.analytic)
  ) {
    return false;
  }
  const analytic = witness.analytic as Record<string, unknown>;
  switch (analytic.kind) {
    case 'plane':
      return (
        isQuantizedPoint(analytic.normal) &&
        Number.isSafeInteger(analytic.offset)
      );
    case 'cylinder':
      return (
        isQuantizedPoint(analytic.axis) &&
        isQuantizedPoint(analytic.axisFoot) &&
        Number.isSafeInteger(analytic.radius) &&
        Number(analytic.radius) >= 0
      );
    case 'none':
      return true;
    default:
      return false;
  }
}

function isSketchFrame(value: unknown): value is SketchPlaneFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const frame = value as Record<string, unknown>;
  return (
    isNumberVector(frame.origin) &&
    isNumberVector(frame.xAxis) &&
    isNumberVector(frame.yAxis) &&
    isNumberVector(frame.zAxis)
  );
}

function isSketchObjects(value: unknown): value is SketchObjectData[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((candidate: unknown) => {
      if (!candidate || typeof candidate !== 'object') {
        return false;
      }
      const object = candidate as Record<string, unknown> & {
        objectKind?: unknown;
      };
      const fields = Object.entries(object).filter(
        (entry) => entry[0] !== 'objectKind'
      );
      switch (object.objectKind) {
        case 'rectangle':
          return (
            fields.length === 4 &&
            ['width', 'height', 'centerX', 'centerY'].every((key) =>
              isScalar(object[key])
            )
          );
        case 'circle':
          return ['radius', 'centerX', 'centerY'].every((key) =>
            isScalar(object[key])
          );
        case 'polygon':
          return (
            Number.isSafeInteger(object.sides) &&
            (object.sides as number) >= 3 &&
            (object.sides as number) <= 64 &&
            ['radius', 'centerX', 'centerY'].every((key) =>
              isScalar(object[key])
            )
          );
        case 'line':
          return ['x1', 'y1', 'x2', 'y2'].every((key) => isScalar(object[key]));
        case 'arc':
          return [
            'centerX',
            'centerY',
            'radius',
            'startAngleDeg',
            'endAngleDeg'
          ].every((key) => isScalar(object[key]));
        case 'text':
          // The optional fields are checked when present rather than merely
          // tolerated: a null `rotation` would reach the document as a
          // ParamValue that cannot resolve and would fail at rebuild instead
          // of here.
          return (
            typeof object.text === 'string' &&
            object.text.length > 0 &&
            TEXT_FONT_FAMILY_IDS.includes(
              object.fontFamily as (typeof TEXT_FONT_FAMILY_IDS)[number]
            ) &&
            TEXT_FONT_STYLES.includes(object.fontStyle as TextFontStyle) &&
            ['size', 'x', 'y'].every((key) => isScalar(object[key])) &&
            (object.rotation === undefined || isScalar(object.rotation)) &&
            (object.align === undefined ||
              TEXT_ALIGNMENTS.includes(object.align as TextAlign))
          );
        default:
          return false;
      }
    })
  );
}

function assertExistingTopologyBody(
  reference: string,
  operation: string
): void {
  if (isLocalBodyRef(reference)) {
    throw new Error(
      `${operation} cannot target a body created in the same proposal, because its referenced topology does not exist yet.`
    );
  }
}

/**
 * Body-creating operations may publish a `localId`. Validation walks the
 * operations in order and tracks the aliases declared so far, so a reference to
 * an alias that is missing, duplicated, or declared later fails here rather
 * than resolving to the wrong body during apply.
 */
function isNullableLocalId(value: unknown): value is LocalBodyId {
  if (value === null || value === undefined) {
    return true;
  }
  return (
    typeof value === 'string' && LOCAL_ID_PATTERN.test(normalizeLocalId(value))
  );
}

function declareLocalId(
  operation: Record<string, unknown>,
  declared: Set<string>
): void {
  const raw = operation.localId;
  if (!isNullableLocalId(raw)) {
    throw new Error(
      `Invalid localId ${JSON.stringify(raw)}. Use a plain identifier such as "box_outer".`
    );
  }
  if (typeof raw !== 'string') {
    return;
  }
  const alias = normalizeLocalId(raw);
  if (declared.has(alias)) {
    throw new Error(`Duplicate localId "${alias}" in proposal.`);
  }
  declared.add(alias);
}

function declareBodyLocalId(
  operation: Record<string, unknown>,
  declared: Set<string>,
  declaredBodies: Set<string>
): void {
  declareLocalId(operation, declared);
  if (typeof operation.localId === 'string') {
    declaredBodies.add(normalizeLocalId(operation.localId));
  }
}

function requireBodyRef(
  value: unknown,
  declared: Set<string>,
  label: string
): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${label}.`);
  }
  if (!isLocalBodyRef(value)) {
    return;
  }
  const alias = normalizeLocalId(value);
  if (!declared.has(alias)) {
    throw new Error(
      `${label} references "${value}" before any operation declares that localId.`
    );
  }
}

/** A datum reference: a plain feature id, or a datum alias declared earlier. */
function requireDatumRef(
  value: unknown,
  declaredDatums: Set<string>,
  label: string
): asserts value is CadDatumRef {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${label} datum.`);
  }
  if (isLocalBodyRef(value) && !declaredDatums.has(normalizeLocalId(value))) {
    throw new Error(
      `${label} datum references "${value}" before an earlier add_datum_plane declares that localId.`
    );
  }
}

/** Strict-output datum source (every field present, nulls) to its typed form. */
function parseDatumPlaneSource(
  value: unknown,
  declaredDatums: Set<string>
): CadDatumPlaneSource {
  const source = record(value);
  if (source.type === 'canonical') {
    if (
      !['XY', 'XZ', 'YZ'].includes(String(source.plane)) ||
      (source.datum !== null && source.datum !== undefined)
    ) {
      throw new Error(
        'A canonical datum source names XY, XZ or YZ and no datum.'
      );
    }
    const offset = source.offset ?? 0;
    if (!isScalar(offset)) {
      throw new Error('A canonical datum source offset must be a value.');
    }
    return {
      type: 'canonical',
      plane: source.plane as 'XY' | 'XZ' | 'YZ',
      offset
    };
  }
  if (source.type === 'datum') {
    if (
      (source.plane !== null && source.plane !== undefined) ||
      (source.offset !== null && source.offset !== undefined)
    ) {
      throw new Error(
        'A datum source names only its datum; put any distance in the offset plane.'
      );
    }
    requireDatumRef(source.datum, declaredDatums, 'add_datum_plane source');
    return { type: 'datum', datum: source.datum };
  }
  throw new Error('A datum plane source is "canonical" or "datum".');
}

function parseDatumPlaneDefinition(
  value: unknown,
  declaredDatums: Set<string>
): CadDatumPlaneDefinition {
  const definition = record(value);
  const reverseNormal = definition.reverseNormal ?? false;
  if (typeof reverseNormal !== 'boolean') {
    throw new Error(
      'add_datum_plane reverseNormal must be true, false or null.'
    );
  }
  const flip = reverseNormal ? { reverseNormal: true } : {};
  if (definition.kind === 'offset') {
    if (
      (definition.sources !== null && definition.sources !== undefined) ||
      !isScalar(definition.offset)
    ) {
      throw new Error(
        'An offset plane has one source and an offset, and no sources pair.'
      );
    }
    return {
      kind: 'offset',
      source: parseDatumPlaneSource(definition.source, declaredDatums),
      offset: definition.offset,
      ...flip
    };
  }
  if (definition.kind === 'midplane') {
    if (
      !Array.isArray(definition.sources) ||
      definition.sources.length !== 2 ||
      (definition.source !== null && definition.source !== undefined) ||
      (definition.offset !== null && definition.offset !== undefined)
    ) {
      throw new Error(
        'A midplane has exactly two sources, and no single source or offset.'
      );
    }
    return {
      kind: 'midplane',
      sources: [
        parseDatumPlaneSource(definition.sources[0], declaredDatums),
        parseDatumPlaneSource(definition.sources[1], declaredDatums)
      ],
      ...flip
    };
  }
  throw new Error('add_datum_plane definition kind is "offset" or "midplane".');
}

function datumFields(
  value: Record<string, unknown>,
  allowed: string[],
  label: string
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(
      `${label} contains fields that do not belong to this construction.`
    );
}

function isDatumScalar(value: unknown): value is ParamValue {
  return typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' && value.trim().length > 0;
}

function requireDatumAxisRef(
  value: unknown,
  declaredAxes: Set<string>,
  label: string
): asserts value is CadDatumAxisRef {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Invalid ${label} datum axis.`);
  if (isLocalBodyRef(value) && !declaredAxes.has(normalizeLocalId(value)))
    throw new Error(
      `${label} datum axis references "${value}" before an earlier add_datum_axis declares that localId.`
    );
}

function parseDatumPlaneSourceV2(
  value: unknown,
  declaredPlanes: Set<string>
): CadDatumPlaneSourceV2 {
  const source = record(value);
  if (source.type === 'canonical' || source.type === 'datum') {
    datumFields(
      source,
      ['type', 'plane', 'offset', 'datum'],
      'Datum plane source'
    );
    const parsed = parseDatumPlaneSource(source, declaredPlanes);
    if (parsed.type === 'canonical' && !isDatumScalar(parsed.offset))
      throw new Error(
        'A canonical datum source offset must be a finite value or expression.'
      );
    return parsed;
  }
  datumFields(
    source,
    [
      'type',
      'bodyId',
      'faceHash',
      'faceReference',
      'sourceArea',
      'sourceCenter',
      'sourceCentroid',
      'sourceNormal',
      'frame'
    ],
    'Datum face source'
  );
  if (
    source.type !== 'face' ||
    typeof source.bodyId !== 'string' ||
    !source.bodyId.trim() ||
    !Number.isSafeInteger(source.faceHash) ||
    Number(source.faceHash) <= 0 ||
    !isFaceReference(source.faceReference) ||
    source.faceReference.currentHash !== source.faceHash ||
    typeof source.sourceArea !== 'number' ||
    !Number.isFinite(source.sourceArea) ||
    source.sourceArea <= 0 ||
    !isNumberVector(source.sourceCenter) ||
    !isNumberVector(source.sourceCentroid) ||
    !isNumberVector(source.sourceNormal) ||
    !isSketchFrame(source.frame)
  )
    throw new Error(
      'A datum face source requires a qualified planar face, centroid and frame copied from the digest.'
    );
  assertExistingTopologyBody(source.bodyId, 'Datum face source');
  return source as unknown as Extract<CadDatumPlaneSourceV2, { type: 'face' }>;
}

function parseDatumPointSource(value: unknown): CadDatumPointSource {
  const source = record(value);
  if (source.type === 'point') {
    datumFields(source, ['type', 'point'], 'Datum point');
    const point = record(source.point);
    datumFields(point, ['x', 'y', 'z'], 'Datum point coordinates');
    if (
      !isDatumScalar(point.x) ||
      !isDatumScalar(point.y) ||
      !isDatumScalar(point.z)
    )
      throw new Error(
        'A datum point requires finite coordinates or expressions for X, Y and Z.'
      );
    return { type: 'point', point: { x: point.x, y: point.y, z: point.z } };
  }
  datumFields(
    source,
    ['type', 'bodyId', 'edgeReference', 'end'],
    'Datum vertex source'
  );
  if (
    source.type !== 'edge-vertex' ||
    typeof source.bodyId !== 'string' ||
    !source.bodyId.trim() ||
    !isEdgeReference(source.edgeReference) ||
    source.edgeReference.witness.closed ||
    (source.end !== 0 && source.end !== 1)
  )
    throw new Error(
      'A datum vertex source requires an open edge with exact lineage and an explicit end 0 or 1.'
    );
  assertExistingTopologyBody(source.bodyId, 'Datum vertex source');
  return {
    type: 'edge-vertex',
    bodyId: source.bodyId,
    edgeReference: source.edgeReference,
    end: source.end
  };
}

function datumReverse(value: unknown, label: string): boolean {
  if (value !== undefined && value !== null && typeof value !== 'boolean')
    throw new Error(`${label} must be true, false or null.`);
  return value === true;
}

function parseDatumPlaneDefinitionV2(
  value: unknown,
  declaredPlanes: Set<string>
): CadDatumPlaneDefinitionV2 {
  const definition = record(value);
  const flip = datumReverse(definition.reverseNormal, 'reverseNormal')
    ? { reverseNormal: true }
    : {};
  switch (definition.kind) {
    case 'offset':
      datumFields(
        definition,
        ['kind', 'source', 'offset', 'reverseNormal'],
        'Offset plane'
      );
      if (!isDatumScalar(definition.offset))
        throw new Error(
          'An offset plane requires a finite offset or expression.'
        );
      return {
        kind: 'offset',
        source: parseDatumPlaneSourceV2(definition.source, declaredPlanes),
        offset: definition.offset,
        ...flip
      };
    case 'midplane':
      datumFields(definition, ['kind', 'sources', 'reverseNormal'], 'Midplane');
      if (!Array.isArray(definition.sources) || definition.sources.length !== 2)
        throw new Error('A midplane requires exactly two plane sources.');
      return {
        kind: 'midplane',
        sources: [
          parseDatumPlaneSourceV2(definition.sources[0], declaredPlanes),
          parseDatumPlaneSourceV2(definition.sources[1], declaredPlanes)
        ],
        ...flip
      };
    case 'three-point':
      datumFields(
        definition,
        ['kind', 'points', 'reverseNormal'],
        'Three-point plane'
      );
      if (!Array.isArray(definition.points) || definition.points.length !== 3)
        throw new Error('A three-point plane requires exactly three points.');
      return {
        kind: 'three-point',
        points: [
          parseDatumPointSource(definition.points[0]),
          parseDatumPointSource(definition.points[1]),
          parseDatumPointSource(definition.points[2])
        ],
        ...flip
      };
    case 'parallel-point':
      datumFields(
        definition,
        ['kind', 'source', 'point', 'reverseNormal'],
        'Parallel-at-point plane'
      );
      return {
        kind: 'parallel-point',
        source: parseDatumPlaneSourceV2(definition.source, declaredPlanes),
        point: parseDatumPointSource(definition.point),
        ...flip
      };
    default:
      throw new Error(
        'A datum plane construction is offset, midplane, three-point or parallel-point.'
      );
  }
}

function parseDatumAxisDefinition(
  value: unknown,
  declaredPlanes: Set<string>
): CadDatumAxisDefinition {
  const definition = record(value);
  const flip = datumReverse(definition.reverseDirection, 'reverseDirection')
    ? { reverseDirection: true }
    : {};
  if (definition.kind === 'two-point') {
    datumFields(
      definition,
      ['kind', 'points', 'reverseDirection'],
      'Two-point axis'
    );
    if (!Array.isArray(definition.points) || definition.points.length !== 2)
      throw new Error('A two-point axis requires exactly two points.');
    return {
      kind: 'two-point',
      points: [
        parseDatumPointSource(definition.points[0]),
        parseDatumPointSource(definition.points[1])
      ],
      ...flip
    };
  }
  if (definition.kind === 'plane-intersection') {
    datumFields(
      definition,
      ['kind', 'sources', 'reverseDirection'],
      'Plane-intersection axis'
    );
    if (!Array.isArray(definition.sources) || definition.sources.length !== 2)
      throw new Error('A plane-intersection axis requires exactly two planes.');
    return {
      kind: 'plane-intersection',
      sources: [
        parseDatumPlaneSourceV2(definition.sources[0], declaredPlanes),
        parseDatumPlaneSourceV2(definition.sources[1], declaredPlanes)
      ],
      ...flip
    };
  }
  datumFields(definition, ['kind', 'source', 'reverseDirection'], 'Datum axis');
  const source = record(definition.source);
  if (definition.kind === 'edge') {
    datumFields(
      source,
      ['type', 'bodyId', 'edgeReference'],
      'Edge axis source'
    );
    if (
      source.type !== 'edge' ||
      typeof source.bodyId !== 'string' ||
      !source.bodyId.trim() ||
      !isEdgeReference(source.edgeReference) ||
      source.edgeReference.witness.closed ||
      source.edgeReference.witness.curveType.toLowerCase() !== 'line'
    )
      throw new Error(
        'An edge axis requires an exact open straight edge from the digest.'
      );
    assertExistingTopologyBody(source.bodyId, 'Edge axis source');
    return {
      kind: 'edge',
      source: {
        type: 'edge',
        bodyId: source.bodyId,
        edgeReference: source.edgeReference
      },
      ...flip
    };
  }
  if (definition.kind === 'cylinder') {
    datumFields(
      source,
      ['type', 'bodyId', 'faceReference'],
      'Cylinder axis source'
    );
    if (
      source.type !== 'face' ||
      typeof source.bodyId !== 'string' ||
      !source.bodyId.trim() ||
      !isFaceReference(source.faceReference)
    )
      throw new Error(
        'A cylinder axis requires an exact cylindrical or conical face from the digest.'
      );
    assertExistingTopologyBody(source.bodyId, 'Cylinder axis source');
    return {
      kind: 'cylinder',
      source: {
        type: 'face',
        bodyId: source.bodyId,
        faceReference: source.faceReference
      },
      ...flip
    };
  }
  throw new Error(
    'A datum axis construction is two-point, edge, cylinder or plane-intersection.'
  );
}

export function parseCadPatchProposal(
  value: unknown,
  digest?: CadDocumentDigest
): CadPatchProposal {
  const candidate = record(value);
  if (
    typeof candidate.proposalId !== 'string' ||
    typeof candidate.summary !== 'string' ||
    (candidate.preserveGeometry !== undefined &&
      typeof candidate.preserveGeometry !== 'boolean') ||
    !Array.isArray(candidate.assumptions) ||
    !candidate.assumptions.every((item) => typeof item === 'string') ||
    !Array.isArray(candidate.operations) ||
    candidate.operations.length === 0 ||
    candidate.operations.length > MAX_PATCH_OPERATIONS
  ) {
    throw new Error('CAD patch proposal is missing required fields.');
  }

  const declared = new Set<string>();
  const declaredBodies = new Set<string>();
  const declaredSketches = new Set<string>();
  const declaredDatums = new Set<string>();
  const declaredAxes = new Set<string>();

  for (const rawOperation of candidate.operations) {
    const operation = record(rawOperation);
    switch (operation.kind) {
      case 'add_raised_feature_control':
        if (
          typeof operation.targetBodyId !== 'string' ||
          typeof operation.parameter !== 'string' ||
          !isValidParameterName(operation.parameter) ||
          !isRecognizedLettering({
            side: 'negative',
            selection: operation.selection
          })
        )
          throw new Error('Invalid raised-feature control.');
        break;
      case 'use_edit_candidate':
        if (operation.analysis !== null) {
          const analysis = record(operation.analysis);
          if (
            analysis.bodyId !== operation.targetBodyId ||
            !Array.isArray(analysis.faceHashes) ||
            analysis.faceHashes.length > 2 ||
            analysis.faceHashes.some(
              (hash) => !Number.isSafeInteger(hash) || Number(hash) <= 0
            )
          )
            throw new Error('Invalid candidate analysis scope.');
        }
        if (
          typeof operation.candidateId !== 'string' ||
          operation.candidateId.length > 512 ||
          typeof operation.targetBodyId !== 'string' ||
          !Array.isArray(operation.parameterNames) ||
          operation.parameterNames.length > 30 ||
          operation.parameterNames.some((value) => {
            const rename = record(value);
            return (
              typeof rename.key !== 'string' ||
              typeof rename.name !== 'string' ||
              !isValidParameterName(rename.name)
            );
          })
        )
          throw new Error('Invalid use_edit_candidate operation.');
        break;
      case 'set_parameter':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.expression !== 'string'
        ) {
          throw new Error('Invalid set_parameter operation.');
        }
        break;
      case 'rename_parameter':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.newName !== 'string'
        ) {
          throw new Error('Invalid rename_parameter operation.');
        }
        break;
      case 'delete_parameter':
        if (typeof operation.name !== 'string') {
          throw new Error('Invalid delete_parameter operation.');
        }
        break;
      case 'set_feature_dimension':
        if (
          typeof operation.featureId !== 'string' ||
          typeof operation.field !== 'string' ||
          (typeof operation.value !== 'string' &&
            typeof operation.value !== 'number')
        ) {
          throw new Error('Invalid set_feature_dimension operation.');
        }
        break;
      case 'set_sketch_dimension':
        if (
          typeof operation.sketchId !== 'string' ||
          typeof operation.objectId !== 'string' ||
          typeof operation.field !== 'string' ||
          !isScalar(operation.value)
        ) {
          throw new Error('Invalid set_sketch_dimension operation.');
        }
        break;
      case 'add_primitive':
        if (
          typeof operation.name !== 'string' ||
          !['box', 'cylinder', 'sphere', 'cone', 'torus'].includes(
            String(operation.primitiveKind)
          ) ||
          !operation.dimensions ||
          typeof operation.dimensions !== 'object'
        ) {
          throw new Error('Invalid add_primitive operation.');
        }
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'delete_feature':
        if (typeof operation.featureId !== 'string') {
          throw new Error('Invalid delete_feature operation.');
        }
        break;
      case 'add_drawing_annotations':
      case 'remove_drawing_annotations':
        parseDrawingOperation(operation);
        break;
      case 'rename_feature':
        if (
          typeof operation.featureId !== 'string' ||
          typeof operation.name !== 'string'
        ) {
          throw new Error('Invalid rename_feature operation.');
        }
        break;
      case 'add_sketch': {
        if (
          typeof operation.name !== 'string' ||
          !['XY', 'XZ', 'YZ'].includes(String(operation.plane)) ||
          !isScalar(operation.offset) ||
          !isSketchObjects(operation.objects)
        ) {
          throw new Error('Invalid add_sketch operation.');
        }
        declareLocalId(operation, declared);
        if (typeof operation.localId === 'string') {
          declaredSketches.add(normalizeLocalId(operation.localId));
        }
        break;
      }
      case 'add_extrude':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.sketchId !== 'string' ||
          !isScalar(operation.distance) ||
          (operation.samplePoint !== null &&
            operation.samplePoint !== undefined &&
            (typeof operation.samplePoint !== 'object' ||
              typeof (operation.samplePoint as { x?: unknown }).x !==
                'number' ||
              typeof (operation.samplePoint as { y?: unknown }).y !== 'number'))
        ) {
          throw new Error('Invalid add_extrude operation.');
        }
        if (
          isLocalBodyRef(String(operation.sketchId)) &&
          !declaredSketches.has(normalizeLocalId(String(operation.sketchId)))
        ) {
          throw new Error(
            `add_extrude sketchId references "${String(operation.sketchId)}" before an earlier sketch declares that localId.`
          );
        }
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_revolve':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.sketchId !== 'string' ||
          !['horizontal', 'vertical'].includes(String(operation.axis)) ||
          (operation.angleDeg !== undefined &&
            operation.angleDeg !== null &&
            !isScalar(operation.angleDeg))
        ) {
          throw new Error('Invalid add_revolve operation.');
        }
        // A literal out of `(0, 360]` is refused here rather than at rebuild:
        // an expression still resolves later against the parameter scope.
        if (
          typeof operation.angleDeg === 'number' &&
          !(operation.angleDeg > 0 && operation.angleDeg <= 360)
        ) {
          throw new Error(
            'add_revolve angleDeg must be greater than 0 and at most 360.'
          );
        }
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_growing_holder_recipe':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          isLocalBodyRef(operation.targetBodyId) ||
          typeof operation.parameter !== 'string' ||
          !isValidParameterName(operation.parameter) ||
          !(
            operation.heightParameter === undefined ||
            operation.heightParameter === null ||
            (typeof operation.heightParameter === 'string' &&
              isValidParameterName(operation.heightParameter) &&
              operation.heightParameter !== operation.parameter)
          ) ||
          !isRecognizedOpening(operation.opening)
        ) {
          throw new Error('Invalid add_growing_holder_recipe operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_growing_holder_recipe targetBodyId'
        );
        assertExistingTopologyBody(
          operation.targetBodyId,
          'add_growing_holder_recipe'
        );
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_growing_holder_hole_control':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          isLocalBodyRef(operation.targetBodyId) ||
          typeof operation.parameter !== 'string' ||
          !isValidParameterName(operation.parameter) ||
          !Array.isArray(operation.holes) ||
          operation.holes.length !== 2 ||
          !operation.holes.every(
            (hole: unknown) =>
              !!hole &&
              typeof hole === 'object' &&
              typeof (hole as { bodyId?: unknown }).bodyId === 'string' &&
              Number.isSafeInteger((hole as { faceHash?: unknown }).faceHash) &&
              isFaceReference(
                (hole as { faceReference?: unknown }).faceReference
              ) &&
              (hole as { faceReference: FaceTopologyReferenceV5 }).faceReference
                .currentHash === (hole as { faceHash: number }).faceHash &&
              isFiniteNumber(
                (hole as { sourceDiameter?: unknown }).sourceDiameter
              ) &&
              isNumberVector(
                (hole as { sourceAxisStart?: unknown }).sourceAxisStart
              ) &&
              isNumberVector(
                (hole as { sourceAxisEnd?: unknown }).sourceAxisEnd
              )
          )
        ) {
          throw new Error('Invalid add_growing_holder_hole_control operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_growing_holder_hole_control targetBodyId'
        );
        break;
      case 'add_imported_opening_recipe':
        if (
          candidate.operations.filter(
            (op: unknown) =>
              op &&
              typeof op === 'object' &&
              'kind' in op &&
              op.kind === 'add_imported_opening_recipe'
          ).length > 1
        )
          throw new Error(
            'Only one imported opening recipe is allowed per proposal.'
          );
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          typeof operation.sourceWidth !== 'number' ||
          !Number.isFinite(operation.sourceWidth) ||
          operation.sourceWidth <= 0 ||
          typeof operation.editedWidth !== 'number' ||
          !Number.isFinite(operation.editedWidth) ||
          operation.editedWidth <= operation.sourceWidth ||
          !['x', 'y', 'z'].includes(String(operation.axis)) ||
          !(
            typeof operation.width === 'string' ||
            (typeof operation.width === 'number' &&
              Number.isFinite(operation.width))
          ) ||
          !Array.isArray(operation.regions) ||
          operation.regions.length !== 2 ||
          !operation.regions.every((region: unknown) => {
            if (
              region === null ||
              typeof region !== 'object' ||
              !('min' in region) ||
              !('max' in region)
            )
              return false;
            const { min, max } = region;
            return (
              isNumberVector(min) &&
              isNumberVector(max) &&
              (['x', 'y', 'z'] as const).every((axis) => min[axis] < max[axis])
            );
          })
        ) {
          throw new Error('Invalid add_imported_opening_recipe operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_imported_opening_recipe targetBodyId'
        );
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_boolean':
        if (
          typeof operation.name !== 'string' ||
          !['union', 'subtract', 'intersect'].includes(
            String(operation.operation)
          ) ||
          !Array.isArray(operation.targetBodyIds) ||
          operation.targetBodyIds.length < 2 ||
          !operation.targetBodyIds.every((id) => typeof id === 'string')
        ) {
          throw new Error('Invalid add_boolean operation.');
        }
        // Operands resolve against aliases declared *before* this operation, so
        // a boolean can never reference its own result.
        operation.targetBodyIds.forEach((id, index) =>
          requireBodyRef(
            id,
            declaredBodies,
            `add_boolean targetBodyIds[${index}]`
          )
        );
        // A repeated operand is degenerate: subtracting a body from itself
        // leaves nothing, and the emptiness would persist silently.
        if (
          new Set(operation.targetBodyIds).size !==
          operation.targetBodyIds.length
        ) {
          throw new Error(
            'add_boolean lists the same body more than once in targetBodyIds.'
          );
        }
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_transform':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          !isVector(operation.translation) ||
          !isVector(operation.rotationDeg)
        ) {
          throw new Error('Invalid add_transform operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_transform targetBodyId'
        );
        break;
      case 'add_direct_edit': {
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          !operation.operation ||
          typeof operation.operation !== 'object' ||
          Array.isArray(operation.operation)
        ) {
          throw new Error('Invalid add_direct_edit operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_direct_edit targetBodyId'
        );
        assertExistingTopologyBody(operation.targetBodyId, 'add_direct_edit');
        const edit = operation.operation as Record<string, unknown>;
        if (edit.kind === 'remove-face-feature') {
          for (const field of [
            'sourceDiameter',
            'sourceAxisStart',
            'sourceAxisEnd'
          ]) {
            if (edit[field] === null) {
              delete edit[field];
            }
          }
        }
        if (
          !Number.isSafeInteger(edit.faceHash) ||
          Number(edit.faceHash) <= 0 ||
          !isFaceReference(edit.faceReference) ||
          edit.faceReference.currentHash !== edit.faceHash
        ) {
          throw new Error(
            'add_direct_edit requires a matching faceHash and exact schema-v5 faceReference from the digest.'
          );
        }
        if (
          edit.kind === 'set-face-distance' &&
          (!Number.isSafeInteger(edit.oppositeFaceHash) ||
            Number(edit.oppositeFaceHash) <= 0 ||
            edit.oppositeFaceHash === edit.faceHash ||
            !isFaceReference(edit.oppositeFaceReference) ||
            edit.oppositeFaceReference.currentHash !== edit.oppositeFaceHash)
        ) {
          throw new Error(
            'add_direct_edit face distance requires a distinct matching oppositeFaceHash and exact schema-v5 oppositeFaceReference from the digest.'
          );
        }
        const commonAxis =
          isNumberVector(edit.sourceAxisStart) &&
          isNumberVector(edit.sourceAxisEnd);
        const commonImportedHole =
          isNumberVector(edit.sourceOpeningPoint) &&
          isNumberVector(edit.sourceAxisDirection);
        const valid =
          (edit.kind === 'resize-through-hole' &&
            typeof edit.sourceDiameter === 'number' &&
            edit.sourceDiameter > 0 &&
            commonAxis &&
            isScalar(edit.diameter)) ||
          (edit.kind === 'resize-imported-blind-hole' &&
            commonImportedHole &&
            typeof edit.sourceDiameter === 'number' &&
            edit.sourceDiameter > 0 &&
            typeof edit.sourceDepth === 'number' &&
            edit.sourceDepth > 0 &&
            isScalar(edit.diameter) &&
            isScalar(edit.depth)) ||
          (edit.kind === 'resize-imported-counterbore' &&
            commonImportedHole &&
            typeof edit.sourceBoreDiameter === 'number' &&
            edit.sourceBoreDiameter > 0 &&
            typeof edit.sourceCounterboreDiameter === 'number' &&
            edit.sourceCounterboreDiameter > edit.sourceBoreDiameter &&
            typeof edit.sourceCounterboreDepth === 'number' &&
            edit.sourceCounterboreDepth > 0 &&
            typeof edit.sourceTotalDepth === 'number' &&
            edit.sourceTotalDepth > edit.sourceCounterboreDepth &&
            typeof edit.sourceEntryChamfered === 'boolean' &&
            isScalar(edit.boreDiameter) &&
            isScalar(edit.counterboreDiameter) &&
            isScalar(edit.counterboreDepth)) ||
          (edit.kind === 'resize-imported-countersink' &&
            commonImportedHole &&
            typeof edit.sourceBoreDiameter === 'number' &&
            edit.sourceBoreDiameter > 0 &&
            typeof edit.sourceSinkDiameter === 'number' &&
            edit.sourceSinkDiameter > edit.sourceBoreDiameter &&
            typeof edit.sourceAngleRadians === 'number' &&
            edit.sourceAngleRadians > 0 &&
            edit.sourceAngleRadians < Math.PI &&
            typeof edit.sourceCountersinkDepth === 'number' &&
            edit.sourceCountersinkDepth > 0 &&
            typeof edit.sourceTotalDepth === 'number' &&
            edit.sourceTotalDepth > edit.sourceCountersinkDepth &&
            isScalar(edit.boreDiameter) &&
            isScalar(edit.sinkDiameter) &&
            isScalar(edit.angleRadians)) ||
          (edit.kind === 'remove-face-feature' &&
            typeof edit.sourceSurfaceType === 'string' &&
            typeof edit.sourceArea === 'number' &&
            edit.sourceArea > 0 &&
            isNumberVector(edit.sourceCenter) &&
            (edit.sourceDiameter === undefined ||
              (typeof edit.sourceDiameter === 'number' &&
                edit.sourceDiameter > 0)) &&
            ((edit.sourceAxisStart === undefined &&
              edit.sourceAxisEnd === undefined) ||
              commonAxis)) ||
          (edit.kind === 'offset-face' &&
            edit.sourceSurfaceType === 'plane' &&
            typeof edit.sourceArea === 'number' &&
            edit.sourceArea > 0 &&
            isNumberVector(edit.sourceCenter) &&
            isNumberVector(edit.sourceNormal) &&
            isScalar(edit.offset)) ||
          (edit.kind === 'set-face-distance' &&
            typeof edit.sourceDistance === 'number' &&
            edit.sourceDistance > 0 &&
            ['symmetric', 'one-sided-first', 'one-sided-second'].includes(
              String(edit.moveMode)
            ) &&
            isScalar(edit.distance) &&
            (edit.parameterBinding === undefined ||
              edit.parameterBinding === true)) ||
          (edit.kind === 'resize-cylindrical-face' &&
            typeof edit.sourceRadius === 'number' &&
            edit.sourceRadius > 0 &&
            commonAxis &&
            ['hole', 'boss'].includes(String(edit.concavity)) &&
            isScalar(edit.radius)) ||
          (edit.kind === 'resize-blend' &&
            ['torus', 'cylinder'].includes(String(edit.surfaceClass)) &&
            typeof edit.recordedRadius === 'number' &&
            edit.recordedRadius > 0 &&
            isNumberVector(edit.recordedCenter) &&
            isNumberVector(edit.recordedAxis) &&
            isScalar(edit.newRadius) &&
            (edit.parameterBinding === undefined ||
              edit.parameterBinding === true));
        if (!valid) {
          throw new Error('Invalid add_direct_edit operation payload.');
        }
        break;
      }
      case 'add_face_sketch': {
        const planeRef = operation.planeRef as Record<string, unknown> | null;
        if (planeRef?.sourceCentroid === null) {
          delete planeRef.sourceCentroid;
        }
        if (
          typeof operation.name !== 'string' ||
          !planeRef ||
          planeRef.type !== 'face' ||
          typeof planeRef.bodyId !== 'string' ||
          !Number.isSafeInteger(planeRef.faceHash) ||
          Number(planeRef.faceHash) <= 0 ||
          !isFaceReference(planeRef.faceReference) ||
          planeRef.faceReference.currentHash !== planeRef.faceHash ||
          typeof planeRef.sourceArea !== 'number' ||
          planeRef.sourceArea <= 0 ||
          !isNumberVector(planeRef.sourceCenter) ||
          (planeRef.sourceCentroid !== undefined &&
            !isNumberVector(planeRef.sourceCentroid)) ||
          !isNumberVector(planeRef.sourceNormal) ||
          !isSketchFrame(planeRef.frame) ||
          !isSketchObjects(operation.objects)
        ) {
          throw new Error('Invalid add_face_sketch operation.');
        }
        assertExistingTopologyBody(planeRef.bodyId, 'add_face_sketch');
        declareLocalId(operation, declared);
        if (typeof operation.localId === 'string') {
          declaredSketches.add(normalizeLocalId(operation.localId));
        }
        break;
      }
      case 'add_multi_profile_extrude':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.sketchId !== 'string' ||
          !isScalar(operation.distance) ||
          !Array.isArray(operation.samplePoints) ||
          operation.samplePoints.length < 2 ||
          !operation.samplePoints.every(
            (point) =>
              point &&
              typeof point === 'object' &&
              Number.isFinite((point as { x?: unknown }).x) &&
              Number.isFinite((point as { y?: unknown }).y)
          )
        ) {
          throw new Error('Invalid add_multi_profile_extrude operation.');
        }
        if (
          isLocalBodyRef(operation.sketchId) &&
          !declaredSketches.has(normalizeLocalId(operation.sketchId))
        ) {
          throw new Error(
            `add_multi_profile_extrude sketchId references "${operation.sketchId}" before an earlier sketch declares that localId.`
          );
        }
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_mirror':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          !operation.plane ||
          typeof operation.plane !== 'object' ||
          !isVector((operation.plane as Record<string, unknown>).origin) ||
          !isVector((operation.plane as Record<string, unknown>).normal)
        ) {
          throw new Error('Invalid add_mirror operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_mirror targetBodyId'
        );
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_shell': {
        const openingFaceHashes = operation.openingFaceHashes;
        const openingFaceReferences = operation.openingFaceReferences;
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          !Array.isArray(openingFaceHashes) ||
          openingFaceHashes.length === 0 ||
          !openingFaceHashes.every(
            (hash) => Number.isSafeInteger(hash) && Number(hash) > 0
          ) ||
          new Set(openingFaceHashes).size !== openingFaceHashes.length ||
          !Array.isArray(openingFaceReferences) ||
          openingFaceReferences.length !== openingFaceHashes.length ||
          !openingFaceReferences.every(
            (reference, index) =>
              isFaceReference(reference) &&
              reference.currentHash === openingFaceHashes[index]
          ) ||
          !isScalar(operation.thickness)
        ) {
          throw new Error('Invalid add_shell operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_shell targetBodyId'
        );
        assertExistingTopologyBody(operation.targetBodyId, 'add_shell');
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      }
      case 'add_solid_offset':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          !isScalar(operation.distance)
        ) {
          throw new Error('Invalid add_solid_offset operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_solid_offset targetBodyId'
        );
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_datum_plane': {
        if (typeof operation.name !== 'string') {
          throw new Error('Invalid add_datum_plane operation.');
        }
        operation.definition = parseDatumPlaneDefinition(
          operation.definition,
          declaredDatums
        );
        declareLocalId(operation, declared);
        if (typeof operation.localId === 'string') {
          declaredDatums.add(normalizeLocalId(operation.localId));
        }
        break;
      }
      case 'add_datum_plane_v2': {
        datumFields(
          operation,
          ['kind', 'name', 'localId', 'definition'],
          operation.kind
        );
        if (typeof operation.name !== 'string' || !operation.name.trim())
          throw new Error('Invalid add_datum_plane_v2 name.');
        operation.definition = parseDatumPlaneDefinitionV2(
          operation.definition,
          declaredDatums
        );
        declareLocalId(operation, declared);
        if (typeof operation.localId === 'string')
          declaredDatums.add(normalizeLocalId(operation.localId));
        break;
      }
      case 'update_datum_plane':
        datumFields(
          operation,
          ['kind', 'featureId', 'definition'],
          operation.kind
        );
        requireDatumRef(operation.featureId, declaredDatums, operation.kind);
        operation.definition = parseDatumPlaneDefinitionV2(
          operation.definition,
          declaredDatums
        );
        break;
      case 'add_datum_axis': {
        datumFields(
          operation,
          ['kind', 'name', 'localId', 'definition'],
          operation.kind
        );
        if (typeof operation.name !== 'string' || !operation.name.trim())
          throw new Error('Invalid add_datum_axis name.');
        operation.definition = parseDatumAxisDefinition(
          operation.definition,
          declaredDatums
        );
        declareLocalId(operation, declared);
        if (typeof operation.localId === 'string')
          declaredAxes.add(normalizeLocalId(operation.localId));
        break;
      }
      case 'update_datum_axis':
        datumFields(
          operation,
          ['kind', 'featureId', 'definition'],
          operation.kind
        );
        requireDatumAxisRef(operation.featureId, declaredAxes, operation.kind);
        operation.definition = parseDatumAxisDefinition(
          operation.definition,
          declaredDatums
        );
        break;
      case 'add_datum_revolve':
        datumFields(
          operation,
          ['kind', 'name', 'localId', 'sketchId', 'datum', 'angleDeg'],
          operation.kind
        );
        if (
          typeof operation.name !== 'string' ||
          !operation.name.trim() ||
          !isDatumScalar(operation.angleDeg)
        )
          throw new Error('Invalid add_datum_revolve operation.');
        requireBodyRef(
          operation.sketchId,
          declaredSketches,
          'add_datum_revolve sketchId'
        );
        requireDatumAxisRef(operation.datum, declaredAxes, operation.kind);
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_datum_pattern':
        datumFields(
          operation,
          [
            'kind',
            'name',
            'localId',
            'targetBodyId',
            'datum',
            'count',
            'angleDeg'
          ],
          operation.kind
        );
        if (
          typeof operation.name !== 'string' ||
          !operation.name.trim() ||
          !isDatumScalar(operation.count) ||
          !isDatumScalar(operation.angleDeg)
        )
          throw new Error('Invalid add_datum_pattern operation.');
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_datum_pattern targetBodyId'
        );
        requireDatumAxisRef(operation.datum, declaredAxes, operation.kind);
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_datum_transform': {
        datumFields(
          operation,
          ['kind', 'name', 'targetBodyId', 'datum', 'angleDeg', 'translation'],
          operation.kind
        );
        if (
          typeof operation.name !== 'string' ||
          !operation.name.trim() ||
          !isDatumScalar(operation.angleDeg)
        )
          throw new Error('Invalid add_datum_transform operation.');
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_datum_transform targetBodyId'
        );
        requireDatumAxisRef(operation.datum, declaredAxes, operation.kind);
        const translation = parseDatumPointSource({
          type: 'point',
          point: operation.translation
        });
        if (translation.type === 'point')
          operation.translation = translation.point;
        break;
      }
      case 'add_datum_sketch':
        if (
          typeof operation.name !== 'string' ||
          !isSketchObjects(operation.objects)
        ) {
          throw new Error('Invalid add_datum_sketch operation.');
        }
        requireDatumRef(operation.datum, declaredDatums, 'add_datum_sketch');
        declareLocalId(operation, declared);
        if (typeof operation.localId === 'string') {
          declaredSketches.add(normalizeLocalId(operation.localId));
        }
        break;
      case 'add_datum_mirror':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string'
        ) {
          throw new Error('Invalid add_datum_mirror operation.');
        }
        requireDatumRef(operation.datum, declaredDatums, 'add_datum_mirror');
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_datum_mirror targetBodyId'
        );
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'add_datum_split':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          (operation.secondLocalId !== undefined &&
            operation.secondLocalId !== null &&
            typeof operation.secondLocalId !== 'string')
        ) {
          throw new Error('Invalid add_datum_split operation.');
        }
        requireDatumRef(operation.datum, declaredDatums, 'add_datum_split');
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_datum_split targetBodyId'
        );
        declareBodyLocalId(operation, declared, declaredBodies);
        declareBodyLocalId(
          { localId: operation.secondLocalId },
          declared,
          declaredBodies
        );
        break;
      case 'add_edge_modifier': {
        const edgeSelector = operation.edgeSelector;
        const stagedSelector =
          edgeSelector === 'all-feature-edges' ||
          edgeSelector === 'circular-rims';
        if (
          typeof operation.name !== 'string' ||
          !['fillet', 'chamfer'].includes(String(operation.modifier)) ||
          typeof operation.targetBodyId !== 'string' ||
          !Array.isArray(operation.edgeHashes) ||
          !operation.edgeHashes.every(
            (hash) => Number.isInteger(hash) && Number(hash) > 0
          ) ||
          (stagedSelector
            ? operation.edgeHashes.length !== 0 ||
              !isLocalBodyRef(operation.targetBodyId)
            : operation.edgeHashes.length === 0) ||
          (!stagedSelector &&
            edgeSelector !== null &&
            edgeSelector !== undefined) ||
          !isScalar(operation.size)
        ) {
          throw new Error('Invalid add_edge_modifier operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_edge_modifier targetBodyId'
        );
        // A local body has no topology until the exact prefix rebuild. It may
        // therefore be targeted only through a semantic selector that the
        // staged preflight resolves to persisted hashes and V5 references.
        if (isLocalBodyRef(String(operation.targetBodyId)) && !stagedSelector) {
          throw new Error(
            'add_edge_modifier cannot target a body created in the same proposal without an exact staged edge selector.'
          );
        }
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      }
      case 'add_pattern':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          !['linear', 'circular'].includes(String(operation.patternKind)) ||
          !['x', 'y', 'z'].includes(String(operation.axis)) ||
          !isScalar(operation.count) ||
          !isScalar(operation.spacing) ||
          !isScalar(operation.angleDeg)
        ) {
          throw new Error('Invalid add_pattern operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_pattern targetBodyId'
        );
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
      case 'recognized_imported_feature':
      case 'add_recognized_imported_feature':
        throw new Error(
          'Recognized imported features are expressed as exact add_direct_edit operations; this standalone operation kind is unsupported.'
        );
      default:
        throw new Error(
          `Unsupported CAD patch operation: ${String(operation.kind)}.`
        );
    }
  }

  const proposal = candidate as unknown as CadPatchProposal;
  // A sheet edit is a Draw-workspace change on the model as drawn; a model
  // edit in the same proposal would move the edges it names.
  const drawingOperations = proposal.operations.filter(isDrawingOperation);
  if (
    drawingOperations.length > 0 &&
    drawingOperations.length !== proposal.operations.length
  )
    throw new Error(
      'A proposal changes either the model or a drawing sheet, not both.'
    );
  if (new Set(drawingOperations.map((op) => op.sheetId)).size > 1)
    throw new Error('A drawing proposal edits one sheet.');
  return digest
    ? validateCadPatchProposalAgainstDigest(proposal, digest)
    : proposal;
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return candidate.map(normalize);
    }
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)])
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function exactDigestFace(
  digest: CadDocumentDigest,
  bodyId: string,
  faceHash: number,
  reference: FaceTopologyReferenceV5,
  operation: string
): CadDigestBodyTopology['faces'][number] {
  const body = digest.bodies?.find(
    (candidate) => candidate.bodyId === bodyId && !candidate.consumed
  );
  const face = body?.topology?.faces.find(
    (candidate) =>
      candidate.hash === faceHash &&
      candidate.reference !== undefined &&
      canonicalJson(candidate.reference) === canonicalJson(reference)
  );
  if (!face) {
    throw new Error(
      `${operation} contains a stale or unavailable face reference for body ${bodyId}. Refresh the proposal from the current document digest.`
    );
  }
  return face;
}

function exactDigestFaceDistancePair(
  digest: CadDocumentDigest,
  bodyId: string,
  operation: Extract<DirectEditOperation, { kind: 'set-face-distance' }>
): OpposingPlanarFacePair {
  const body = digest.bodies?.find(
    (candidate) => candidate.bodyId === bodyId && !candidate.consumed
  );
  const pair = body?.topology?.opposingPlanarFacePairs?.find(
    (candidate) =>
      candidate.faceAHash === operation.faceHash &&
      candidate.faceBHash === operation.oppositeFaceHash &&
      canonicalJson(candidate.faceAReference) ===
        canonicalJson(operation.faceReference) &&
      canonicalJson(candidate.faceBReference) ===
        canonicalJson(operation.oppositeFaceReference) &&
      candidate.distance === operation.sourceDistance &&
      candidate.moveMode === operation.moveMode &&
      Number.isFinite(candidate.provenChangedDistance) &&
      candidate.provenChangedDistance !== candidate.distance
  );
  if (!pair) {
    throw new Error(
      `add_direct_edit contains a stale or unavailable changed-value face-distance proof for body ${bodyId}. Refresh the proposal from the current document digest.`
    );
  }
  return pair;
}

function exactDigestImportedFeature(
  digest: CadDocumentDigest,
  bodyId: string,
  faceHash: number,
  reference: FaceTopologyReferenceV5,
  kind: RecognizedImportedFeature['kind']
): RecognizedImportedFeature {
  const body = digest.bodies?.find(
    (candidate) => candidate.bodyId === bodyId && !candidate.consumed
  );
  const matches = (body?.topology?.recognizedImportedFeatures ?? []).filter(
    (candidate) =>
      candidate.kind === kind &&
      candidate.seedFaceHash === faceHash &&
      candidate.seedFaceReference !== undefined &&
      canonicalJson(candidate.seedFaceReference) === canonicalJson(reference)
  );
  const feature = matches[0];
  if (!feature || matches.length > 1) {
    throw new Error(
      `add_direct_edit contains a stale or unavailable ${kind} proof for body ${bodyId}. Refresh the proposal from the current document digest.`
    );
  }
  // Read-only families are recognized by a second recognizer and carry no
  // proof an edit can replay; an operation may never bind to one.
  if (isReadOnlyRecognizedImportedFeature(feature)) {
    throw new Error(
      `add_direct_edit targets a read-only ${kind} on body ${bodyId}. Recognized ${kind} features are published for reading only.`
    );
  }
  return feature;
}

function exactDigestRecognizedOpening(
  digest: CadDocumentDigest,
  bodyId: string
): RecognizedOpening {
  const body = digest.bodies?.find(
    (candidate) => candidate.bodyId === bodyId && !candidate.consumed
  );
  const recognition = body?.topology?.recognizedOpening;
  if (!recognition) {
    throw new Error(
      `add_growing_holder_recipe targets body ${bodyId}, whose opening has not been measured. Refresh the proposal from the current document digest.`
    );
  }
  if (recognition.status !== 'recognized') {
    throw new Error(
      `add_growing_holder_recipe targets body ${bodyId}, whose opening is not a recognized measurement (${recognition.reason}).`
    );
  }
  return recognition.opening;
}

/**
 * Binds topology-dependent operations to the exact digest that prompted the
 * assistant. Structural parsing alone cannot distinguish a copied lineage
 * reference from a well-formed but stale or invented one.
 */
/** A plain datum id must name a live datum-plane feature in the digest. */
function requireDigestDatum(
  digest: CadDocumentDigest,
  datum: CadDatumRef,
  label: string
): void {
  if (isLocalBodyRef(datum)) return;
  const feature = digest.features.find(
    (candidate) => candidate.featureId === datum
  );
  if (!feature || feature.featureKind !== 'datum-plane') {
    throw new Error(
      `${label} datum ${datum} is not a datum plane in the current digest.`
    );
  }
  if (feature.suppressed) {
    throw new Error(`${label} datum ${datum} is suppressed.`);
  }
}

function geometryDatumKey(reference: string): string {
  return isLocalBodyRef(reference)
    ? `$${normalizeLocalId(reference)}`
    : reference;
}

function requireDigestGeometryDatum(
  digest: CadDocumentDigest,
  reference: string,
  kind: 'datum-plane' | 'datum-axis',
  label: string,
  updated: ReadonlySet<string>,
  target = false
): CadDocumentDigest['features'][number] | undefined {
  if (isLocalBodyRef(reference)) {
    if (!updated.has(geometryDatumKey(reference)))
      throw new Error(`${label} ${reference} is not an earlier ${kind} alias.`);
    return undefined;
  }
  const features = digest.features.filter(
    (feature) => feature.featureId === reference
  );
  const feature = features[0];
  if (features.length !== 1 || !feature || feature.featureKind !== kind)
    throw new Error(
      `${label} ${reference} is not a ${kind} in the current digest.`
    );
  if (feature.suppressed || feature.datum?.status === 'suppressed')
    throw new Error(`${label} ${reference} is suppressed.`);
  if (
    !target &&
    !updated.has(geometryDatumKey(reference)) &&
    feature.datum?.status === 'unresolved'
  )
    throw new Error(
      `${label} ${reference} is unresolved. Repair it before using it as a source.`
    );
  return feature;
}

/** Only unchanged, authored sources may stand in for omitted historical topology. */
function retainedDatumTopologySources(definition: unknown): Set<string> {
  if (
    !definition ||
    typeof definition !== 'object' ||
    Array.isArray(definition)
  )
    return new Set();
  const value = definition as Record<string, unknown>;
  const candidates = [
    value.source,
    value.point,
    ...(Array.isArray(value.sources) ? (value.sources as unknown[]) : []),
    ...(Array.isArray(value.points) ? (value.points as unknown[]) : [])
  ];
  return new Set(
    candidates
      .filter((source) => {
        if (!source || typeof source !== 'object' || Array.isArray(source))
          return false;
        return ['face', 'edge', 'edge-vertex'].includes(
          String((source as Record<string, unknown>).type)
        );
      })
      .map(canonicalJson)
  );
}

function exactDatumDigestFace(
  digest: CadDocumentDigest,
  bodyId: string,
  reference: FaceTopologyReferenceV5,
  label: string
): CadDigestBodyTopology['faces'][number] {
  const bodies =
    digest.bodies?.filter((body) => body.bodyId === bodyId && !body.consumed) ??
    [];
  const faces = bodies.length === 1 ? (bodies[0]!.topology?.faces ?? []) : [];
  const matches = faces.filter(
    (face) =>
      face.hash === reference.currentHash &&
      face.reference &&
      canonicalJson(face.reference) === canonicalJson(reference)
  );
  const sameHash = faces.filter((face) => face.hash === reference.currentHash);
  const sameLineage = faces.filter(
    (face) =>
      face.reference?.producingFeatureId === reference.producingFeatureId &&
      face.reference.lineageName === reference.lineageName
  );
  if (matches.length !== 1 || sameHash.length !== 1 || sameLineage.length !== 1)
    throw new Error(
      `${label} requires one current, unique face identity for body ${bodyId}; its reference is stale, unavailable or ambiguous.`
    );
  return matches[0]!;
}

function exactDatumDigestEdge(
  digest: CadDocumentDigest,
  bodyId: string,
  reference: EdgeTopologyReferenceV5,
  label: string
): void {
  const bodies =
    digest.bodies?.filter((body) => body.bodyId === bodyId && !body.consumed) ??
    [];
  const edges = bodies.length === 1 ? (bodies[0]!.topology?.edges ?? []) : [];
  const matches = edges.filter(
    (edge) =>
      edge.hash === reference.currentHash &&
      edge.reference &&
      canonicalJson(edge.reference) === canonicalJson(reference)
  );
  const sameHash = edges.filter((edge) => edge.hash === reference.currentHash);
  const sameLineage = edges.filter(
    (edge) =>
      edge.reference?.producingFeatureId === reference.producingFeatureId &&
      edge.reference.lineageName === reference.lineageName
  );
  if (matches.length !== 1 || sameHash.length !== 1 || sameLineage.length !== 1)
    throw new Error(
      `${label} requires one current, unique edge identity for body ${bodyId}; its reference is stale, unavailable or ambiguous.`
    );
}

function validateDatumPlaneSourceV2(
  digest: CadDocumentDigest,
  source: CadDatumPlaneSourceV2,
  label: string,
  retained: ReadonlySet<string>,
  updatedPlanes: ReadonlySet<string>
): void {
  if (source.type === 'canonical') return;
  if (source.type === 'datum') {
    requireDigestGeometryDatum(
      digest,
      source.datum,
      'datum-plane',
      label,
      updatedPlanes
    );
    return;
  }
  if (retained.has(canonicalJson(source))) return;
  const face = exactDatumDigestFace(
    digest,
    source.bodyId,
    source.faceReference,
    label
  );
  const snapshot = face.snapshot;
  if (
    snapshot?.surfaceType !== 'plane' ||
    !snapshot.normal ||
    !snapshot.centroid ||
    !face.attachmentFrame ||
    canonicalJson([
      source.faceHash,
      source.sourceArea,
      source.sourceCenter,
      source.sourceCentroid,
      source.sourceNormal,
      source.frame
    ]) !==
      canonicalJson([
        face.hash,
        snapshot.area,
        snapshot.center,
        snapshot.centroid,
        snapshot.normal,
        face.attachmentFrame
      ])
  )
    throw new Error(
      `${label} must copy the exact planar face snapshot, centroid and attachmentFrame from the current digest.`
    );
}

function validateDatumPointSource(
  digest: CadDocumentDigest,
  source: CadDatumPointSource,
  label: string,
  retained: ReadonlySet<string>
): void {
  if (source.type === 'point' || retained.has(canonicalJson(source))) return;
  exactDatumDigestEdge(digest, source.bodyId, source.edgeReference, label);
}

function validateDatumPlaneDefinitionV2(
  digest: CadDocumentDigest,
  definition: CadDatumPlaneDefinitionV2,
  label: string,
  retained: ReadonlySet<string>,
  updatedPlanes: ReadonlySet<string>
): void {
  if (definition.kind === 'three-point') {
    definition.points.forEach((point) =>
      validateDatumPointSource(digest, point, label, retained)
    );
  } else if (definition.kind === 'midplane') {
    definition.sources.forEach((source) =>
      validateDatumPlaneSourceV2(digest, source, label, retained, updatedPlanes)
    );
  } else {
    validateDatumPlaneSourceV2(
      digest,
      definition.source,
      label,
      retained,
      updatedPlanes
    );
    if (definition.kind === 'parallel-point')
      validateDatumPointSource(digest, definition.point, label, retained);
  }
}

function validateDatumAxisDefinition(
  digest: CadDocumentDigest,
  definition: CadDatumAxisDefinition,
  label: string,
  retained: ReadonlySet<string>,
  updatedPlanes: ReadonlySet<string>
): void {
  if (definition.kind === 'two-point') {
    definition.points.forEach((point) =>
      validateDatumPointSource(digest, point, label, retained)
    );
  } else if (definition.kind === 'plane-intersection') {
    definition.sources.forEach((source) =>
      validateDatumPlaneSourceV2(digest, source, label, retained, updatedPlanes)
    );
  } else if (!retained.has(canonicalJson(definition.source))) {
    const source = definition.source;
    if (source.type === 'edge')
      exactDatumDigestEdge(digest, source.bodyId, source.edgeReference, label);
    else {
      const face = exactDatumDigestFace(
        digest,
        source.bodyId,
        source.faceReference,
        label
      );
      if (!['cylinder', 'cone'].includes(face.snapshot?.surfaceType ?? ''))
        throw new Error(
          `${label} requires an exact cylindrical or conical digest face.`
        );
    }
  }
}

function requireDatumConsumerSketch(
  digest: CadDocumentDigest,
  sketchId: string,
  label: string
): void {
  if (isLocalBodyRef(sketchId)) return;
  const features = digest.features.filter(
    (feature) =>
      feature.featureKind === 'sketch' &&
      feature.data &&
      typeof feature.data === 'object' &&
      (feature.data as Record<string, unknown>).sketchId === sketchId &&
      !feature.suppressed
  );
  if (features.length !== 1)
    throw new Error(
      `${label} sketch ${sketchId} is not an active sketch in the current digest.`
    );
}

function requireDatumConsumerBody(
  digest: CadDocumentDigest,
  bodyId: string,
  label: string
): void {
  if (isLocalBodyRef(bodyId)) return;
  if (
    digest.bodies?.filter((body) => body.bodyId === bodyId && !body.consumed)
      .length !== 1
  )
    throw new Error(
      `${label} body ${bodyId} is not a unique live body in the current digest.`
    );
}

export function validateCadPatchProposalAgainstDigest(
  proposal: CadPatchProposal,
  digest: CadDocumentDigest
): CadPatchProposal {
  // Tracks the parameter set as the proposal would evolve it, so a rename or
  // delete may target a parameter an earlier operation in the same proposal
  // introduced or renamed.
  const parameterNames = new Set(
    digest.parameters.map((parameter) => parameter.name)
  );
  if (proposal.operations.some(isDrawingOperation))
    proposal = {
      ...proposal,
      operations: proposal.operations.map((operation) =>
        isDrawingOperation(operation)
          ? validateDrawingOperation(operation, digest.drawing)
          : operation
      )
    };
  const updatedPlanes = new Set<string>();
  const updatedAxes = new Set<string>();
  const datumDefinitions = new Map<string, unknown>();
  for (const feature of digest.features) {
    if (
      (feature.featureKind === 'datum-plane' ||
        feature.featureKind === 'datum-axis') &&
      feature.data &&
      typeof feature.data === 'object'
    )
      datumDefinitions.set(
        feature.featureId,
        (feature.data as Record<string, unknown>).definition
      );
  }
  for (const operation of proposal.operations) {
    switch (operation.kind) {
      case 'add_raised_feature_control': {
        const measured = digest.bodies?.find(
          (body) => body.bodyId === operation.targetBodyId && !body.consumed
        )?.topology?.recognizedPlanarEmboss;
        if (
          !measured ||
          canonicalJson(measured) !== canonicalJson(operation.selection)
        )
          throw new Error('Raised features do not match the measured group.');
        break;
      }
      case 'use_edit_candidate': {
        const candidate = digest.editCatalog?.candidates.find(
          (candidate) =>
            candidate.id === operation.candidateId &&
            candidate.bodyId === operation.targetBodyId
        );
        if (
          !candidate ||
          canonicalJson(candidate.analysis) !==
            canonicalJson(operation.analysis) ||
          operation.parameterNames.some(
            (rename) =>
              !candidate.parameters.some(
                (parameter) => parameter.key === rename.key
              )
          )
        ) {
          throw new Error(
            'The selected edit candidate is not in the current document analysis.'
          );
        }
        break;
      }
      case 'set_parameter':
        parameterNames.add(operation.name);
        break;
      case 'rename_parameter':
        if (!parameterNames.has(operation.name)) {
          throw new Error(
            `rename_parameter targets unknown parameter "${operation.name}". Refresh the proposal from the current document digest.`
          );
        }
        parameterNames.delete(operation.name);
        parameterNames.add(operation.newName);
        break;
      case 'delete_parameter':
        if (!parameterNames.has(operation.name)) {
          throw new Error(
            `delete_parameter targets unknown parameter "${operation.name}". Refresh the proposal from the current document digest.`
          );
        }
        parameterNames.delete(operation.name);
        break;
      case 'set_sketch_dimension': {
        const feature = digest.features.find((candidate) => {
          const data = candidate.data as Record<string, unknown> | null;
          return (
            data?.featureKind === 'sketch' &&
            data.sketchId === operation.sketchId
          );
        });
        const data = feature?.data as Record<string, unknown> | undefined;
        const objectIds = Array.isArray(data?.objectIds) ? data.objectIds : [];
        const objects = Array.isArray(data?.objects) ? data.objects : [];
        const index = objectIds.indexOf(operation.objectId);
        const object =
          index >= 0 && objects[index] && typeof objects[index] === 'object'
            ? (objects[index] as Record<string, unknown>)
            : null;
        if (
          !object ||
          ![
            'rectangle',
            'circle',
            'polygon',
            'line',
            'arc',
            'ellipse',
            'text'
          ].includes(String(object.objectKind)) ||
          !sketchObjectExposesDimension(object, operation.field)
        ) {
          throw new Error(
            `set_sketch_dimension contains a stale or unavailable field for object ${operation.objectId}. Refresh the proposal from the current document digest.`
          );
        }
        break;
      }
      case 'add_growing_holder_hole_control': {
        const body = digest.bodies?.find(
          (candidate) =>
            candidate.bodyId === operation.targetBodyId && !candidate.consumed
        );
        if (!body) {
          throw new Error(
            `add_growing_holder_hole_control targets body ${operation.targetBodyId}, which is not live in the current document digest.`
          );
        }
        break;
      }
      case 'add_growing_holder_recipe': {
        const measured = exactDigestRecognizedOpening(
          digest,
          operation.targetBodyId
        );
        const normalizeOptional = (opening: RecognizedOpening) => ({
          ...opening,
          height: opening.height ?? null,
          lettering: opening.lettering ?? null
        });
        if (
          canonicalJson(normalizeOptional(measured)) !==
          canonicalJson(normalizeOptional(operation.opening))
        ) {
          throw new Error(
            'add_growing_holder_recipe opening does not exactly match the current measured opening. Refresh the proposal from the current document digest.'
          );
        }
        break;
      }
      case 'add_direct_edit': {
        const edit = operation.operation;
        if (edit.kind === 'resize-imported-blind-hole') {
          const proof = exactDigestImportedFeature(
            digest,
            operation.targetBodyId,
            edit.faceHash,
            edit.faceReference,
            'blind-cylindrical-hole'
          );
          if (
            proof.kind !== 'blind-cylindrical-hole' ||
            canonicalJson([
              proof.openingPoint,
              proof.axisDirection,
              proof.diameter,
              proof.depth
            ]) !==
              canonicalJson([
                edit.sourceOpeningPoint,
                edit.sourceAxisDirection,
                edit.sourceDiameter,
                edit.sourceDepth
              ])
          ) {
            throw new Error(
              'add_direct_edit source geometry does not exactly match the current imported-feature proof.'
            );
          }
          break;
        }
        if (edit.kind === 'resize-imported-counterbore') {
          const proof = exactDigestImportedFeature(
            digest,
            operation.targetBodyId,
            edit.faceHash,
            edit.faceReference,
            'counterbore'
          );
          if (
            proof.kind !== 'counterbore' ||
            canonicalJson([
              proof.openingPoint,
              proof.axisDirection,
              proof.boreDiameter,
              proof.counterboreDiameter,
              proof.counterboreDepth,
              proof.totalDepth,
              proof.entryChamfered
            ]) !==
              canonicalJson([
                edit.sourceOpeningPoint,
                edit.sourceAxisDirection,
                edit.sourceBoreDiameter,
                edit.sourceCounterboreDiameter,
                edit.sourceCounterboreDepth,
                edit.sourceTotalDepth,
                edit.sourceEntryChamfered
              ])
          ) {
            throw new Error(
              'add_direct_edit source geometry does not exactly match the current imported-feature proof.'
            );
          }
          break;
        }
        if (edit.kind === 'resize-imported-countersink') {
          const proof = exactDigestImportedFeature(
            digest,
            operation.targetBodyId,
            edit.faceHash,
            edit.faceReference,
            'countersink'
          );
          if (
            proof.kind !== 'countersink' ||
            canonicalJson([
              proof.openingPoint,
              proof.axisDirection,
              proof.boreDiameter,
              proof.sinkDiameter,
              proof.angleRadians,
              proof.countersinkDepth,
              proof.totalDepth
            ]) !==
              canonicalJson([
                edit.sourceOpeningPoint,
                edit.sourceAxisDirection,
                edit.sourceBoreDiameter,
                edit.sourceSinkDiameter,
                edit.sourceAngleRadians,
                edit.sourceCountersinkDepth,
                edit.sourceTotalDepth
              ])
          ) {
            throw new Error(
              'add_direct_edit source geometry does not exactly match the current imported-feature proof.'
            );
          }
          break;
        }
        const face = exactDigestFace(
          digest,
          operation.targetBodyId,
          edit.faceHash,
          edit.faceReference,
          operation.kind
        );
        const snapshot = face.snapshot;
        if (!snapshot) {
          throw new Error(
            'add_direct_edit requires an exact, unrounded geometry snapshot from the current digest.'
          );
        }
        const expected: unknown[] = [];
        const received: unknown[] = [];
        switch (edit.kind) {
          case 'set-face-distance': {
            if (!edit.oppositeFaceReference) {
              throw new Error(
                'add_direct_edit face distance requires an exact opposite face reference.'
              );
            }
            const opposite = exactDigestFace(
              digest,
              operation.targetBodyId,
              edit.oppositeFaceHash,
              edit.oppositeFaceReference,
              operation.kind
            );
            if (
              snapshot.surfaceType !== 'plane' ||
              opposite.snapshot?.surfaceType !== 'plane' ||
              !snapshot.normal ||
              !opposite.snapshot.normal
            ) {
              throw new Error(
                'add_direct_edit face distance requires two exact planar face snapshots.'
              );
            }
            exactDigestFaceDistancePair(digest, operation.targetBodyId, edit);
            break;
          }
          case 'resize-through-hole':
            expected.push(
              snapshot.diameter,
              snapshot.axisStart,
              snapshot.axisEnd
            );
            received.push(
              edit.sourceDiameter,
              edit.sourceAxisStart,
              edit.sourceAxisEnd
            );
            break;
          case 'remove-face-feature':
            expected.push(
              snapshot.surfaceType,
              snapshot.area,
              snapshot.center,
              snapshot.diameter,
              snapshot.axisStart,
              snapshot.axisEnd
            );
            received.push(
              edit.sourceSurfaceType,
              edit.sourceArea,
              edit.sourceCenter,
              edit.sourceDiameter,
              edit.sourceAxisStart,
              edit.sourceAxisEnd
            );
            break;
          case 'offset-face':
            expected.push(
              snapshot.surfaceType,
              snapshot.area,
              snapshot.center,
              snapshot.normal
            );
            received.push(
              edit.sourceSurfaceType,
              edit.sourceArea,
              edit.sourceCenter,
              edit.sourceNormal
            );
            break;
          case 'resize-cylindrical-face':
            if (
              snapshot.featureType !== 'through-hole' ||
              edit.concavity !== 'hole'
            ) {
              throw new Error(
                'AI cylindrical resize is enabled only for kernel-recognized through-holes; boss concavity is not authoritative in the digest.'
              );
            }
            expected.push(
              snapshot.radius,
              snapshot.axisStart,
              snapshot.axisEnd
            );
            received.push(
              edit.sourceRadius,
              edit.sourceAxisStart,
              edit.sourceAxisEnd
            );
            break;
          case 'resize-blend': {
            if (
              snapshot.featureType !== 'blend' ||
              snapshot.surfaceType !== edit.surfaceClass ||
              snapshot.blendRadius === undefined
            ) {
              throw new Error(
                'AI blend resize requires a kernel-recognized analytic blend carrier.'
              );
            }
            let center: Vector3 | undefined;
            let axis: Vector3 | null | undefined;
            if (edit.surfaceClass === 'torus') {
              center = snapshot.torusCenter;
              axis = snapshot.axis;
            } else if (snapshot.axisStart && snapshot.axisEnd) {
              center = {
                x: (snapshot.axisStart.x + snapshot.axisEnd.x) / 2,
                y: (snapshot.axisStart.y + snapshot.axisEnd.y) / 2,
                z: (snapshot.axisStart.z + snapshot.axisEnd.z) / 2
              };
              axis = normalized({
                x: snapshot.axisEnd.x - snapshot.axisStart.x,
                y: snapshot.axisEnd.y - snapshot.axisStart.y,
                z: snapshot.axisEnd.z - snapshot.axisStart.z
              });
            }
            if (!center || !axis) {
              throw new Error(
                'AI blend resize requires the exact carrier center and axis.'
              );
            }
            expected.push(
              snapshot.surfaceType,
              snapshot.blendRadius,
              center,
              axis
            );
            received.push(
              edit.surfaceClass,
              edit.recordedRadius,
              edit.recordedCenter,
              edit.recordedAxis
            );
            break;
          }
        }
        if (canonicalJson(expected) !== canonicalJson(received)) {
          throw new Error(
            'add_direct_edit source geometry does not exactly match the current digest snapshot.'
          );
        }
        break;
      }
      case 'add_datum_plane': {
        const { definition } = operation;
        const sources =
          definition.kind === 'offset'
            ? [definition.source]
            : definition.sources;
        for (const source of sources)
          if (source.type === 'datum')
            requireDigestDatum(digest, source.datum, operation.kind);
        if (typeof operation.localId === 'string') {
          const key = geometryDatumKey(
            `$${normalizeLocalId(operation.localId)}`
          );
          updatedPlanes.add(key);
          datumDefinitions.set(key, definition);
        }
        break;
      }
      case 'add_datum_plane_v2': {
        validateDatumPlaneDefinitionV2(
          digest,
          operation.definition,
          operation.kind,
          new Set(),
          updatedPlanes
        );
        if (typeof operation.localId === 'string') {
          const key = geometryDatumKey(
            `$${normalizeLocalId(operation.localId)}`
          );
          updatedPlanes.add(key);
          datumDefinitions.set(key, operation.definition);
        }
        break;
      }
      case 'update_datum_plane': {
        requireDigestGeometryDatum(
          digest,
          operation.featureId,
          'datum-plane',
          operation.kind,
          updatedPlanes,
          true
        );
        const key = geometryDatumKey(operation.featureId);
        validateDatumPlaneDefinitionV2(
          digest,
          operation.definition,
          operation.kind,
          retainedDatumTopologySources(datumDefinitions.get(key)),
          updatedPlanes
        );
        updatedPlanes.add(key);
        datumDefinitions.set(key, operation.definition);
        break;
      }
      case 'add_datum_axis': {
        validateDatumAxisDefinition(
          digest,
          operation.definition,
          operation.kind,
          new Set(),
          updatedPlanes
        );
        if (typeof operation.localId === 'string') {
          const key = geometryDatumKey(
            `$${normalizeLocalId(operation.localId)}`
          );
          updatedAxes.add(key);
          datumDefinitions.set(key, operation.definition);
        }
        break;
      }
      case 'update_datum_axis': {
        requireDigestGeometryDatum(
          digest,
          operation.featureId,
          'datum-axis',
          operation.kind,
          updatedAxes,
          true
        );
        const key = geometryDatumKey(operation.featureId);
        validateDatumAxisDefinition(
          digest,
          operation.definition,
          operation.kind,
          retainedDatumTopologySources(datumDefinitions.get(key)),
          updatedPlanes
        );
        updatedAxes.add(key);
        datumDefinitions.set(key, operation.definition);
        break;
      }
      case 'add_datum_revolve':
        requireDigestGeometryDatum(
          digest,
          operation.datum,
          'datum-axis',
          operation.kind,
          updatedAxes
        );
        requireDatumConsumerSketch(digest, operation.sketchId, operation.kind);
        break;
      case 'add_datum_pattern':
      case 'add_datum_transform':
        requireDigestGeometryDatum(
          digest,
          operation.datum,
          'datum-axis',
          operation.kind,
          updatedAxes
        );
        requireDatumConsumerBody(
          digest,
          operation.targetBodyId,
          operation.kind
        );
        break;
      case 'add_datum_sketch':
      case 'add_datum_mirror':
      case 'add_datum_split':
        requireDigestDatum(digest, operation.datum, operation.kind);
        break;
      case 'add_face_sketch': {
        const plane = operation.planeRef;
        const face = exactDigestFace(
          digest,
          plane.bodyId,
          plane.faceHash,
          plane.faceReference,
          operation.kind
        );
        const snapshot = face.snapshot;
        if (
          !snapshot?.normal ||
          !face.attachmentFrame ||
          canonicalJson([
            plane.sourceArea,
            plane.sourceCenter,
            plane.sourceCentroid ?? null,
            plane.sourceNormal,
            plane.frame
          ]) !==
            canonicalJson([
              snapshot.area,
              snapshot.center,
              snapshot.centroid ?? null,
              snapshot.normal,
              face.attachmentFrame
            ])
        ) {
          throw new Error(
            'add_face_sketch must copy the exact source geometry and deterministic attachmentFrame from one current planar digest face.'
          );
        }
        break;
      }
      case 'add_shell':
        operation.openingFaceReferences.forEach((reference, index) =>
          exactDigestFace(
            digest,
            operation.targetBodyId,
            operation.openingFaceHashes[index]!,
            reference,
            operation.kind
          )
        );
        break;
      default:
        break;
    }
  }
  return proposal;
}

/** Human-readable, deterministic text for proposal review UI and audit logs. */
export function describeCadPatchOperation(
  operation: CadPatchOperation
): string {
  switch (operation.kind) {
    case 'add_raised_feature_control':
      return `Create ${operation.parameter} visibility control for the measured raised features`;
    case 'use_edit_candidate':
      return `Create measured parameter controls on ${operation.targetBodyId}`;
    case 'set_parameter':
      return `Set parameter ${operation.name} to ${operation.expression}`;
    case 'rename_parameter':
      return `Rename parameter ${operation.name} to ${operation.newName}`;
    case 'delete_parameter':
      return `Delete parameter ${operation.name}`;
    case 'set_feature_dimension':
      return `Set ${operation.field} on ${operation.featureId} to ${String(operation.value)}`;
    case 'set_sketch_dimension':
      return `Set ${operation.field} on sketch object ${operation.objectId} to ${String(operation.value)}`;
    case 'add_primitive':
      return `Create ${operation.primitiveKind} ${operation.name}`;
    case 'delete_feature':
      return `Delete feature ${operation.featureId}`;
    case 'rename_feature':
      return `Rename feature ${operation.featureId} to ${operation.name}`;
    case 'add_sketch':
      return `Create sketch ${operation.name} on ${operation.plane}`;
    case 'add_extrude':
      return `Extrude ${operation.sketchId} by ${String(operation.distance)}`;
    case 'add_revolve':
      return operation.angleDeg === undefined || operation.angleDeg === null
        ? `Revolve ${operation.sketchId} around its ${operation.axis} axis`
        : `Revolve ${operation.sketchId} ${String(operation.angleDeg)}° around its ${operation.axis} axis`;
    case 'add_growing_holder_hole_control':
      return `Drive the two measured ${operation.holes[0]?.sourceDiameter ?? '?'} bores of ${operation.targetBodyId} with parameter ${operation.parameter}`;
    case 'add_growing_holder_recipe':
      return `Grow the measured ${operation.opening.sourceOpening} opening of ${operation.targetBodyId} along ${operation.opening.axis} with parameter ${operation.parameter}`;
    case 'add_imported_opening_recipe':
      return `Create localized opening ${String(operation.width)} from ${operation.sourceWidth} on ${operation.targetBodyId}`;
    case 'add_boolean':
      return `${operation.operation} ${operation.targetBodyIds.length} bodies as ${operation.name}`;
    case 'add_transform':
      return `Transform body ${operation.targetBodyId} as ${operation.name}`;
    case 'add_direct_edit':
      return `${operation.name}: ${operation.operation.kind} on ${operation.operation.faceReference.lineageName}`;
    case 'add_face_sketch':
      return `Create sketch ${operation.name} on ${operation.planeRef.faceReference.lineageName}`;
    case 'add_multi_profile_extrude':
      return `Extrude ${operation.samplePoints.length} profiles from ${operation.sketchId} by ${String(operation.distance)}`;
    case 'add_mirror':
      return `Mirror body ${operation.targetBodyId} as ${operation.name}`;
    case 'add_shell':
      return `Shell body ${operation.targetBodyId} through ${operation.openingFaceHashes.length} face${operation.openingFaceHashes.length === 1 ? '' : 's'} at ${String(operation.thickness)}`;
    case 'add_solid_offset':
      return `Offset body ${operation.targetBodyId} outward by ${String(operation.distance)}`;
    case 'add_datum_plane':
      return operation.definition.kind === 'offset'
        ? `Create offset plane ${operation.name} at ${String(operation.definition.offset)}`
        : `Create midplane ${operation.name}`;
    case 'add_datum_plane_v2':
      return `Create ${operation.definition.kind} datum plane ${operation.name}`;
    case 'update_datum_plane':
      return `Update datum plane ${operation.featureId} as ${operation.definition.kind}`;
    case 'add_datum_axis':
      return `Create ${operation.definition.kind} datum axis ${operation.name}`;
    case 'update_datum_axis':
      return `Update datum axis ${operation.featureId} as ${operation.definition.kind}`;
    case 'add_datum_revolve':
      return `Revolve sketch ${operation.sketchId} about datum axis ${operation.datum} as ${operation.name}`;
    case 'add_datum_pattern':
      return `Pattern body ${operation.targetBodyId} about datum axis ${operation.datum} as ${operation.name}`;
    case 'add_datum_transform':
      return `Transform body ${operation.targetBodyId} about datum axis ${operation.datum} as ${operation.name}`;
    case 'add_datum_sketch':
      return `Create sketch ${operation.name} on datum ${operation.datum}`;
    case 'add_datum_mirror':
      return `Mirror body ${operation.targetBodyId} across datum ${operation.datum} as ${operation.name}`;
    case 'add_datum_split':
      return `Split body ${operation.targetBodyId} at datum ${operation.datum} as ${operation.name}`;
    case 'add_edge_modifier':
      return `${operation.modifier} ${
        operation.edgeSelector === 'all-feature-edges'
          ? 'all feature edges'
          : operation.edgeSelector === 'circular-rims'
            ? 'all circular rims'
            : `${operation.edgeHashes.length} edges`
      } on ${operation.targetBodyId}`;
    case 'add_pattern':
      return `Create ${operation.patternKind} pattern of ${operation.targetBodyId}`;
    case 'add_drawing_annotations':
    case 'remove_drawing_annotations':
      return describeDrawingOperation(operation);
  }
}
