import { listFeaturesInOrder, listParameters } from '@openzcad/document-core';
import type {
  SketchObjectData,
  AxisId,
  BodyId,
  BodyTopology,
  BooleanOperation,
  FeatureId,
  PatternKind,
  ParamValue,
  PrimitiveKind,
  ProjectDocument,
  RevolveAxis,
  SketchId,
  TopologySelection,
  Vector3
} from '@openzcad/shared';

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
  }>;
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
  return {
    topologyId: face.topologyId,
    hash: face.hash,
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

function compactFeatureData(data: unknown): unknown {
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
      data: compactFeatureData(feature.data)
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
        topologyId:
          topology.topologyId ?? `body:${String(topology.bodyId)}`,
        hash: topology.hash ?? null
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
        sameStrings(operation.edgeHashes.map(String), selectedEdgeHashes.map(String))
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
      (operation.kind === 'add_transform' || operation.kind === 'add_pattern') &&
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
              axis: { type: 'string', enum: ['horizontal', 'vertical'] }
            },
            required: ['kind', 'name', 'localId', 'sketchId', 'axis']
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
export function parseAssistantReply(value: unknown): AssistantReply {
  const candidate = record(value);
  switch (candidate.replyKind) {
    case 'patch':
      return {
        kind: 'patch',
        proposal: parseCadPatchProposal(candidate.proposal),
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

export function parseCadPatchProposal(value: unknown): CadPatchProposal {
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
        declareLocalId(operation, declared);
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
        const validObjects =
          Array.isArray(operation.objects) &&
          operation.objects.length > 0 &&
          operation.objects.every((candidate: unknown) => {
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
                return ['x1', 'y1', 'x2', 'y2'].every((key) =>
                  isScalar(object[key])
                );
              case 'arc':
                return [
                  'centerX',
                  'centerY',
                  'radius',
                  'startAngleDeg',
                  'endAngleDeg'
                ].every((key) =>
                  isScalar(object[key])
                );
              default:
                return false;
            }
          });
        if (
          typeof operation.name !== 'string' ||
          !['XY', 'XZ', 'YZ'].includes(String(operation.plane)) ||
          !isScalar(operation.offset) ||
          !validObjects
        ) {
          throw new Error('Invalid add_sketch operation.');
        }
        declareLocalId(operation, declared);
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
              typeof (operation.samplePoint as { y?: unknown }).y !==
                'number'))
        ) {
          throw new Error('Invalid add_extrude operation.');
        }
        declareLocalId(operation, declared);
        break;
      case 'add_revolve':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.sketchId !== 'string' ||
          !['horizontal', 'vertical'].includes(String(operation.axis))
        ) {
          throw new Error('Invalid add_revolve operation.');
        }
        declareLocalId(operation, declared);
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
          requireBodyRef(id, declared, `add_boolean targetBodyIds[${index}]`)
        );
        // A repeated operand is degenerate: subtracting a body from itself
        // leaves nothing, and the emptiness would persist silently.
        if (
          new Set(operation.targetBodyIds).size !== operation.targetBodyIds.length
        ) {
          throw new Error(
            'add_boolean lists the same body more than once in targetBodyIds.'
          );
        }
        declareLocalId(operation, declared);
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
          declared,
          'add_transform targetBodyId'
        );
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
          declared,
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
        declareLocalId(operation, declared);
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
        requireBodyRef(operation.targetBodyId, declared, 'add_pattern targetBodyId');
        declareLocalId(operation, declared);
        break;
      default:
        throw new Error(
          `Unsupported CAD patch operation: ${String(operation.kind)}.`
        );
    }
  }

  return candidate as unknown as CadPatchProposal;
}
