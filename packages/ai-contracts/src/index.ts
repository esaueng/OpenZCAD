import {
  findSketch,
  listFeaturesInOrder,
  listParameters
} from '@openzcad/document-core';
import type {
  SketchObjectData,
  AxisId,
  BodyId,
  BodyTopology,
  BooleanOperation,
  DirectEditOperation,
  FaceTopologyReferenceV5,
  FeatureId,
  PatternKind,
  ParametricPlane,
  ParamValue,
  PrimitiveKind,
  ProjectDocument,
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

export type CadDirectEditOperation = DirectEditOperation extends infer Operation
  ? Operation extends DirectEditOperation
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

export type CadPatchOperation =
  | {
      kind: 'set_parameter';
      name: string;
      expression: string;
    }
  | {
      kind: 'set_feature_dimension';
      featureId: FeatureId;
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
      kind: 'add_edge_modifier';
      name: string;
      localId?: LocalBodyId;
      modifier: 'fillet' | 'chamfer';
      targetBodyId: BodyRef;
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
    };

export interface CadPatchProposal {
  proposalId: string;
  summary: string;
  assumptions: string[];
  operations: CadPatchOperation[];
}

/**
 * The viewport and feature tree selection captured when an assistant request
 * starts. Arrays preserve pick order, which is significant for booleans (the
 * first body is the base) and makes plural references such as "these edges"
 * deterministic.
 */
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
  normal?: Vector3;
  radius?: number;
  diameter?: number;
  axisStart?: Vector3;
  axisEnd?: Vector3;
  axialLength?: number;
  featureType?: 'through-hole';
}

export interface CadDigestBodyTopology {
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
    featureType?: 'through-hole';
  }>;
  edges: Array<{
    topologyId: string;
    hash: number;
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
    data: unknown;
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
    volume: number;
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
        ...(geometry.featureType ? { featureType: geometry.featureType } : {})
      }
    : undefined;
  const attachmentFrame =
    reference && geometry?.surfaceType === 'plane' && geometry.normal
      ? deterministicFaceFrame(geometry.center, geometry.normal)
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
        typeof feature.stepText === 'string' ? feature.stepText.length : 0
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
    return {
      featureKind: feature.featureKind,
      sketchId: sketch.sketchId,
      planeRef: sketch.planeRef,
      objects: sketch.objectIds.flatMap((objectId) => {
        const object = document.nodes[objectId];
        return object?.kind === 'sketch-object' ? [object.data] : [];
      })
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
    const edges = body.topology.edges
      .slice(0, edgeLimit)
      .map((edge) => compactEdge(edge, primitiveKind));
    const faces = body.topology.faces.slice(0, faceLimit).map(compactFace);
    remainingEdges -= edges.length;
    remainingFaces -= faces.length;
    topologyByBodyId.set(bodyId, {
      faceCount: body.topology.faces.length,
      edgeCount: body.topology.edges.length,
      modifierEdgeCount: edges.filter((edge) => edge.modifierCandidate).length,
      faceInventoryComplete: faces.length === body.topology.faces.length,
      edgeInventoryComplete: edges.length === body.topology.edges.length,
      faces,
      edges
    });
  }

  return {
    schemaVersion: document.schemaVersion,
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
      data: compactFeatureData(document, feature.data)
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
              volume: round(body.volume),
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
  /\b(?:selected|this|that|these|those)\s+(?:body|bodies|part|parts|solid|solids|feature|features)\b/i;
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
  let changed = false;

  const operations = proposal.operations.map((operation): CadPatchOperation => {
    if (operation.kind === 'add_edge_modifier' && referencesAllEdges) {
      const selectedBodyIds = [...new Set(selection.bodyIds)].filter((bodyId) =>
        liveBodies.some((body) => body.bodyId === bodyId)
      );
      const selectedBody =
        selectedBodyIds.length === 1
          ? liveBodies.find(
              (candidate) => candidate.bodyId === selectedBodyIds[0]
            )
          : undefined;
      const proposedBody = liveBodies.find(
        (candidate) => candidate.bodyId === operation.targetBodyId
      );
      const soleLiveBody = liveBodies.length === 1 ? liveBodies[0] : undefined;
      const body =
        (referencesSelectedBody || referencesSelectedEdges
          ? (selectedBody ?? proposedBody)
          : (proposedBody ?? selectedBody)) ?? soleLiveBody;
      if (!body) {
        throw new Error(
          'The assistant could not resolve which body "all edges" refers to.'
        );
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

    if (
      operation.kind === 'add_edge_modifier' &&
      referencesSelectedEdges &&
      edgesShareBody &&
      selectedEdgeHashes.length > 0
    ) {
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

    if (
      referencesSelectedBody &&
      selectedBodyId &&
      (operation.kind === 'add_transform' ||
        operation.kind === 'add_pattern') &&
      operation.targetBodyId !== selectedBodyId
    ) {
      changed = true;
      return { ...operation, targetBodyId: selectedBodyId };
    }

    if (
      referencesSelectedBody &&
      selection.bodyIds.length >= 2 &&
      operation.kind === 'add_boolean' &&
      !sameStrings(operation.targetBodyIds, selection.bodyIds)
    ) {
      changed = true;
      return { ...operation, targetBodyIds: [...selection.bodyIds] };
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
        sides: scalarSchema,
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
    'sourceNormal',
    'frame'
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
        kind: { type: 'string', const: 'remove-face-feature' },
        faceHash: { type: 'integer', minimum: 1 },
        faceReference: faceReferenceSchema,
        sourceSurfaceType: { type: 'string' },
        sourceArea: { type: 'number', exclusiveMinimum: 0 },
        sourceCenter: numberVectorSchema,
        sourceDiameter: { type: 'number', exclusiveMinimum: 0 },
        sourceAxisStart: numberVectorSchema,
        sourceAxisEnd: numberVectorSchema
      },
      required: [
        'kind',
        'faceHash',
        'faceReference',
        'sourceSurfaceType',
        'sourceArea',
        'sourceCenter'
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
    }
  ]
} as const;

export const AI_CAD_OPERATION_CAPABILITIES = {
  set_feature_dimension: { enabled: true, reason: null },
  add_transform: { enabled: true, reason: null },
  add_direct_edit: { enabled: true, reason: null },
  add_face_sketch: { enabled: true, reason: null },
  add_multi_profile_extrude: { enabled: true, reason: null },
  add_mirror: { enabled: true, reason: null },
  add_shell: { enabled: true, reason: null },
  add_solid_offset: { enabled: true, reason: null },
  recognized_imported_feature: {
    enabled: false,
    reason:
      'Recognition diagnostics do not yet expose a stable command contract and exact editable topology inventory.'
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
              kind: { type: 'string', const: 'add_edge_modifier' },
              name: { type: 'string' },
              localId: localIdSchema,
              modifier: { type: 'string', enum: ['fillet', 'chamfer'] },
              targetBodyId: bodyRefSchema,
              edgeHashes: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: { type: 'integer', minimum: 1 }
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
          }
        ]
      }
    }
  },
  required: ['proposalId', 'summary', 'assumptions', 'operations']
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
              id: { type: 'string' },
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
    case 'patch':
      return {
        kind: 'patch',
        proposal: parseCadPatchProposal(candidate.proposal, digest),
        readings: parseAssistantReadings(candidate.readings)
      };
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
          return ['sides', 'radius', 'centerX', 'centerY'].every((key) =>
            isScalar(object[key])
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

export function parseCadPatchProposal(
  value: unknown,
  digest?: CadDocumentDigest
): CadPatchProposal {
  const candidate = record(value);
  if (
    typeof candidate.proposalId !== 'string' ||
    typeof candidate.summary !== 'string' ||
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

  for (const rawOperation of candidate.operations) {
    const operation = record(rawOperation);
    switch (operation.kind) {
      case 'set_parameter':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.expression !== 'string'
        ) {
          throw new Error('Invalid set_parameter operation.');
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
        const commonAxis =
          isNumberVector(edit.sourceAxisStart) &&
          isNumberVector(edit.sourceAxisEnd);
        const valid =
          (edit.kind === 'resize-through-hole' &&
            typeof edit.sourceDiameter === 'number' &&
            edit.sourceDiameter > 0 &&
            commonAxis &&
            isScalar(edit.diameter)) ||
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
          (edit.kind === 'resize-cylindrical-face' &&
            typeof edit.sourceRadius === 'number' &&
            edit.sourceRadius > 0 &&
            commonAxis &&
            ['hole', 'boss'].includes(String(edit.concavity)) &&
            isScalar(edit.radius));
        if (!valid) {
          throw new Error('Invalid add_direct_edit operation payload.');
        }
        break;
      }
      case 'add_face_sketch': {
        const planeRef = operation.planeRef as Record<string, unknown> | null;
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
      case 'add_edge_modifier':
        if (
          typeof operation.name !== 'string' ||
          !['fillet', 'chamfer'].includes(String(operation.modifier)) ||
          typeof operation.targetBodyId !== 'string' ||
          !Array.isArray(operation.edgeHashes) ||
          operation.edgeHashes.length === 0 ||
          !operation.edgeHashes.every(
            (hash) => Number.isInteger(hash) && Number(hash) > 0
          ) ||
          !isScalar(operation.size)
        ) {
          throw new Error('Invalid add_edge_modifier operation.');
        }
        requireBodyRef(
          operation.targetBodyId,
          declaredBodies,
          'add_edge_modifier targetBodyId'
        );
        // Edge ordinals come from the derived topology of a body that already
        // exists. A body created earlier in this same patch has no derived
        // topology yet, so any ordinal against it would be invented — and it
        // would persist into the command log and replay wrong forever.
        if (isLocalBodyRef(String(operation.targetBodyId))) {
          throw new Error(
            'add_edge_modifier cannot target a body created in the same proposal, because its edges do not exist yet. Create the body first, then finish its edges in a later request.'
          );
        }
        declareBodyLocalId(operation, declared, declaredBodies);
        break;
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
          `Recognized imported-feature AI edits are disabled: ${AI_CAD_OPERATION_CAPABILITIES.recognized_imported_feature.reason}`
        );
      default:
        throw new Error(
          `Unsupported CAD patch operation: ${String(operation.kind)}.`
        );
    }
  }

  const proposal = candidate as unknown as CadPatchProposal;
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

/**
 * Binds topology-dependent operations to the exact digest that prompted the
 * assistant. Structural parsing alone cannot distinguish a copied lineage
 * reference from a well-formed but stale or invented one.
 */
export function validateCadPatchProposalAgainstDigest(
  proposal: CadPatchProposal,
  digest: CadDocumentDigest
): CadPatchProposal {
  for (const operation of proposal.operations) {
    switch (operation.kind) {
      case 'add_direct_edit': {
        const edit = operation.operation;
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
        }
        if (canonicalJson(expected) !== canonicalJson(received)) {
          throw new Error(
            'add_direct_edit source geometry does not exactly match the current digest snapshot.'
          );
        }
        break;
      }
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
            plane.sourceNormal,
            plane.frame
          ]) !==
            canonicalJson([
              snapshot.area,
              snapshot.center,
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
    case 'set_parameter':
      return `Set parameter ${operation.name} to ${operation.expression}`;
    case 'set_feature_dimension':
      return `Set ${operation.field} on ${operation.featureId} to ${String(operation.value)}`;
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
    case 'add_edge_modifier':
      return `${operation.modifier} ${operation.edgeHashes.length} edges on ${operation.targetBodyId}`;
    case 'add_pattern':
      return `Create ${operation.patternKind} pattern of ${operation.targetBodyId}`;
  }
}
