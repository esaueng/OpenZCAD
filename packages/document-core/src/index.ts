import { listFeaturesInOrder } from './feature-order';
export { listFeaturesInOrder } from './feature-order';
export { withoutDerivedProjection } from './document-projection';
import { repairLegacyBracketModel } from './legacy-bracket';
export {
  repairLegacyBracketModel,
  repairLegacyBracketRecipe,
  BRACKET_BOSS_HEIGHT
} from './legacy-bracket';
import {
  rewriteNodeExpressions,
  type ExpressionFieldDimension
} from './parameter-expressions';
export type { ExpressionFieldDimension } from './parameter-expressions';
import { localizeImportedSourceArtifacts } from './imported-source-artifacts';
export { localizeImportedSourceArtifacts } from './imported-source-artifacts';
import {
  assertNoReferenceDimensionDependents,
  assertSketchReferenceDimensions
} from './sketch-reference-dimensions';
export * from './sketch-reference-dimensions';
export {
  constantRigidTransform,
  rigidImportedSource
} from './imported-source-placement';
export {
  archiveHistorySources,
  type ImportedSourceArchiveIdentity,
  applyDocumentChanges,
  recordDocumentEdit,
  normalizeDocumentHistory
} from './document-history';
import { isDocumentHistory } from '@openzcad/shared';
import {
  MAX_CHECKPOINT_REASON_LENGTH,
  UNIT_TO_MM,
  documentNodesWithHistory,
  type ProjectId,
  createId,
  deepClone,
  featureColor,
  isProjectCheckpoint,
  isRevisionRecord,
  MAX_PROJECT_CHECKPOINTS,
  MAX_PROJECT_REVISION_RECORDS,
  nowIso,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toArtifactId,
  toBodyId,
  toEntityId,
  toFeatureId,
  toParameterId,
  toProjectId,
  toRevisionId,
  toShaprImportId,
  toSketchId,
  isDatumPlaneRef,
  type BodyId,
  type BodyNode,
  type DatumPlaneDefinition,
  type DatumPlaneSource,
  type AxisId,
  type BooleanOperation,
  type DocumentNode,
  type DirectEditOperation,
  type EdgeTopologyReferenceV5,
  type FaceTopologyReferenceV5,
  type EntityId,
  type FeatureData,
  type ExtrudeEndCondition,
  type ExtrudeOperation,
  type ThroughAllSide,
  type FeatureId,
  type FeatureKind,
  type FeatureNode,
  type ImportedSourceReference,
  type ParameterId,
  type ParameterKind,
  type ParameterNode,
  type ParametricVector3,
  type ModelingPlaneReference,
  type ParamValue,
  type PatternKind,
  type PlaneId,
  type PrimitiveKind,
  type ProjectDocument,
  type ProjectBranchPoint,
  type ProjectCheckpoint,
  type RevisionRecord,
  type ShaprImportId,
  type ShaprMigrationRecord,
  type RevolveAxis,
  toSketchConstraintId,
  type SketchConstraint,
  type SketchConstraintData,
  type SketchConstraintId,
  type SketchDimensionLabelPosition,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type SketchObjectNode,
  type SketchPointRef,
  type SketchPlaneRef,
  type SketchProfileReference,
  type SketchSectionReference,
  type SketchPathReference,
  type UnitSystem,
  type UserId,
  type VariableFilletLaw
} from '@openzcad/shared';

// Documents are treated as immutable values: every mutating operation in this
// module deep-clones the incoming document before touching it and returns the
// clone. Callers (CommandManager, UI state) may therefore hold references to
// previous documents — including sharing untouched sub-objects produced by the
// shallow-copy helpers below — without risk of aliasing bugs.

/**
 * Pre-generated identifiers for operations that create a feature plus a body.
 * Command factories assign these when the command is created so that the
 * serialized payload replays to the exact same entity graph.
 */
export interface BodyFeatureIds {
  featureId: FeatureId;
  featureNodeId: EntityId;
  bodyId: BodyId;
  bodyNodeId: EntityId;
}

export interface SketchFeatureIds {
  featureId: FeatureId;
  featureNodeId: EntityId;
  sketchId: SketchId;
  sketchNodeId: EntityId;
  /** @deprecated Alias of `objectNodeIds[0]`, retained so v3 command logs replay. */
  objectNodeId: EntityId;
  objectNodeIds: EntityId[];
}

export interface FeatureOnlyIds {
  featureId: FeatureId;
  featureNodeId: EntityId;
}

export interface ParameterIds {
  parameterId: ParameterId;
  parameterNodeId: EntityId;
}

export function createBodyFeatureIds(): BodyFeatureIds {
  return {
    featureId: toFeatureId(createId('feat')),
    featureNodeId: toEntityId(createId('ent')),
    bodyId: toBodyId(createId('body')),
    bodyNodeId: toEntityId(createId('ent'))
  };
}

/**
 * A split replaces one body with two, so its command payload has to carry
 * both result bodies' identities for deterministic replay.
 */
export interface SplitFeatureIds extends BodyFeatureIds {
  secondBodyId: BodyId;
  secondBodyNodeId: EntityId;
}

export function createSplitFeatureIds(): SplitFeatureIds {
  return {
    ...createBodyFeatureIds(),
    secondBodyId: toBodyId(createId('body')),
    secondBodyNodeId: toEntityId(createId('ent'))
  };
}

export function createSketchFeatureIds(objectCount = 1): SketchFeatureIds {
  const objectNodeIds = Array.from({ length: Math.max(objectCount, 0) }, () =>
    toEntityId(createId('ent'))
  );
  return {
    featureId: toFeatureId(createId('feat')),
    featureNodeId: toEntityId(createId('ent')),
    sketchId: toSketchId(createId('sketch')),
    sketchNodeId: toEntityId(createId('ent')),
    objectNodeId: objectNodeIds[0] ?? toEntityId(createId('ent')),
    objectNodeIds
  };
}

/** Fills gaps in ids from v3 command payloads, which predate `objectNodeIds`. */
function normalizeSketchFeatureIds(ids: SketchFeatureIds): SketchFeatureIds {
  if (ids.objectNodeIds && ids.objectNodeIds.length > 0) {
    return { ...ids, objectNodeId: ids.objectNodeId ?? ids.objectNodeIds[0]! };
  }
  return { ...ids, objectNodeIds: ids.objectNodeId ? [ids.objectNodeId] : [] };
}

export function createFeatureOnlyIds(): FeatureOnlyIds {
  return {
    featureId: toFeatureId(createId('feat')),
    featureNodeId: toEntityId(createId('ent'))
  };
}

export function createParameterIds(): ParameterIds {
  return {
    parameterId: toParameterId(createId('param')),
    parameterNodeId: toEntityId(createId('ent'))
  };
}

export interface PrimitiveInput {
  name: string;
  /**
   * The new body's name, resolved by the caller from the document it is
   * created in (see `numberedBodyName`) and stored in the command so a replay
   * reproduces it. Absent is the legacy naming every command recorded before
   * numbering replays to.
   */
  bodyName?: string;
  primitiveKind: PrimitiveKind;
  dimensions: Record<string, ParamValue>;
  ids?: BodyFeatureIds;
}

export interface SketchInput {
  name: string;
  planeRef?: SketchPlaneRef;
  objects?: SketchObjectData[];
  /** @deprecated v3 payload field; still honored so old command logs replay. */
  plane?: PlaneId;
  /** @deprecated v3 payload field; still honored so old command logs replay. */
  offset?: ParamValue;
  /** @deprecated v3 payload field; still honored so old command logs replay. */
  object?: SketchObjectData;
  ids?: SketchFeatureIds;
}

/** Resolves the v4/v3 dual shape of a sketch payload to its v4 form. */
export function resolveSketchInput(input: SketchInput): {
  planeRef: SketchPlaneRef;
  objects: SketchObjectData[];
} {
  const planeRef: SketchPlaneRef = input.planeRef ?? {
    type: 'canonical',
    plane: input.plane ?? 'XY',
    offset: input.offset ?? 0
  };
  const objects = input.objects ?? (input.object ? [input.object] : []);
  return { planeRef, objects };
}

export interface SketchUpdateInput {
  sketchId: SketchId;
  planeRef?: SketchPlaneRef;
  /** @deprecated v3 payload field; rewrites the canonical planeRef on replay. */
  plane?: PlaneId;
  /** @deprecated v3 payload field; rewrites the canonical planeRef on replay. */
  offset?: ParamValue;
  /** @deprecated v3 payload field; replaces the first object, as v3 did. */
  object?: SketchObjectData;
}

export interface SketchObjectAddInput {
  sketchId: SketchId;
  objects: SketchObjectData[];
  ids?: { objectNodeIds: EntityId[] };
}

export interface SketchObjectUpdateInput {
  sketchId: SketchId;
  objectId: EntityId;
  data: SketchObjectData;
}

export interface SketchObjectDeleteInput {
  sketchId: SketchId;
  objectId: EntityId;
}

export interface SketchConstraintAddInput {
  sketchId: SketchId;
  constraint: SketchConstraintData;
  ids?: { constraintId: SketchConstraintId };
}

export interface SketchConstraintDeleteInput {
  sketchId: SketchId;
  constraintId: SketchConstraintId;
}

export interface SketchDimensionLabelPositionInput {
  sketchId: SketchId;
  constraintId: SketchConstraintId;
  position: SketchDimensionLabelPosition;
}

export interface ExtrudeInput {
  name: string;
  /**
   * The new body's name, resolved by the caller from the document it is
   * created in (see `numberedBodyName`) and stored in the command so a replay
   * reproduces it. Absent is the legacy naming every command recorded before
   * numbering replays to.
   */
  bodyName?: string;
  sketchId: SketchId;
  distance: ParamValue;
  /** Half the distance to each side of the sketch plane; absent = one-sided. */
  symmetric?: boolean;
  /**
   * Additional depth behind the sketch plane, opposite the `distance`
   * direction; absent = one-sided. Mutually exclusive with `symmetric`.
   */
  backDistance?: ParamValue;
  /** Explicitly stored by new clients; absent reads as the legacy new body. */
  operation?: ExtrudeOperation;
  /** Existing live body consumed by an add or cut extrusion. */
  targetBodyId?: BodyId;
  /** Extrude one detected region of the sketch instead of the whole profile. */
  profile?: SketchProfileReference;
  /** Extrude one or more explicitly selected bounded cells. */
  profiles?: SketchProfileReference[];
  /** F01: absent is blind; see the stored feature's `endCondition`. */
  endCondition?: ExtrudeEndCondition;
  throughAllSide?: ThroughAllSide;
  ids?: BodyFeatureIds;
}

export interface RevolveInput {
  name: string;
  /**
   * The new body's name, resolved by the caller from the document it is
   * created in (see `numberedBodyName`) and stored in the command so a replay
   * reproduces it. Absent is the legacy naming every command recorded before
   * numbering replays to.
   */
  bodyName?: string;
  sketchId: SketchId;
  axis: RevolveAxis;
  /** Sweep angle in degrees, `(0, 360]`. Omitted means a full turn. */
  angleDeg?: ParamValue;
  ids?: BodyFeatureIds;
}

export interface LoftInput {
  name: string;
  /**
   * The new body's name, resolved by the caller from the document it is
   * created in (see `numberedBodyName`) and stored in the command so a replay
   * reproduces it. Absent is the legacy naming every command recorded before
   * numbering replays to.
   */
  bodyName?: string;
  sections: SketchSectionReference[];
  mode: 'ruled' | 'smooth';
  /** Apex point closing the loft after its last section; omitted by default. */
  endPoint?: ParametricVector3;
  ids?: BodyFeatureIds;
}

export interface SweepInput {
  name: string;
  /**
   * The new body's name, resolved by the caller from the document it is
   * created in (see `numberedBodyName`) and stored in the command so a replay
   * reproduces it. Absent is the legacy naming every command recorded before
   * numbering replays to.
   */
  bodyName?: string;
  profile: SketchSectionReference;
  path: SketchPathReference;
  mode: 'standard' | 'smooth';
  /** Rail the profile's up-vector tracks along the path; omitted by default. */
  guide?: SketchPathReference;
  ids?: BodyFeatureIds;
}

export interface HelicalSweepInput {
  name: string;
  /**
   * The new body's name, resolved by the caller from the document it is
   * created in (see `numberedBodyName`) and stored in the command so a replay
   * reproduces it. Absent is the legacy naming every command recorded before
   * numbering replays to.
   */
  bodyName?: string;
  profile: SketchSectionReference;
  axisOrigin: ParametricVector3;
  axisDirection: ParametricVector3;
  radius: ParamValue;
  pitch: ParamValue;
  turns: ParamValue;
  ids?: BodyFeatureIds;
}

export interface BooleanInput {
  /** Zero passes through the first operand unchanged; omitted means active. */
  activeWhen?: ParamValue;
  name: string;
  /**
   * The result body's name for a union or an intersect, resolved by the
   * caller (see `numberedBodyName`) and stored in the command so a replay
   * reproduces it. Both treat their operands alike, so the merged bracket is
   * "Union 1", not still "Box 1". A subtract ignores it: the base body with
   * material cut away is still that body. Absent is the legacy naming, the
   * base body's name, that every command recorded before this replays to.
   */
  bodyName?: string;
  operation: BooleanOperation;
  targetBodyIds: BodyId[];
  ids?: BodyFeatureIds;
}

export interface TransformInput {
  name: string;
  targetBodyId: BodyId;
  translation: ParametricVector3;
  rotationDeg?: ParametricVector3;
  /** Uniform scale about the world origin; omitted means 1. */
  scale?: ParamValue;
  ids?: FeatureOnlyIds;
}

export interface MirrorInput {
  name: string;
  targetBodyId: BodyId;
  plane: ModelingPlaneReference;
  ids?: BodyFeatureIds;
}

export interface DatumPlaneInput {
  name: string;
  definition: DatumPlaneDefinition;
  ids?: FeatureOnlyIds;
}

export interface HoleInput {
  name: string;
  /** Consumed: the drilled body replaces it. */
  targetBodyId: BodyId;
  faceHash: number;
  faceReference?: FaceTopologyReferenceV5;
  style: 'simple' | 'counterbore' | 'countersink';
  diameter: ParamValue;
  depthMode: 'blind' | 'through';
  depth?: ParamValue;
  counterboreDiameter?: ParamValue;
  counterboreDepth?: ParamValue;
  countersinkDiameter?: ParamValue;
  countersinkAngleDeg?: ParamValue;
  position: { u: ParamValue; v: ParamValue };
  /** Anchor `position` is measured from; see the `hole` feature data. */
  positionAnchor?: 'centroid';
  ids?: BodyFeatureIds;
}

export interface SplitInput {
  name: string;
  /** Consumed: the two halves replace it. */
  targetBodyId: BodyId;
  plane: ModelingPlaneReference;
  ids?: SplitFeatureIds;
}

export interface ShellInput {
  name: string;
  targetBodyId: BodyId;
  openingFaceHashes: number[];
  openingFaceReferences?: FaceTopologyReferenceV5[];
  thickness: ParamValue;
  ids?: BodyFeatureIds;
}

export interface SolidOffsetInput {
  name: string;
  targetBodyId: BodyId;
  distance: ParamValue;
  ids?: BodyFeatureIds;
}

export interface DraftInput {
  name: string;
  targetBodyId: BodyId;
  faceHashes: number[];
  faceReferences?: FaceTopologyReferenceV5[];
  pullDirection: ParametricVector3;
  neutralPoint: ParametricVector3;
  angleDeg: ParamValue;
  ids?: BodyFeatureIds;
}

export interface ThickenInput {
  name: string;
  targetBodyId: BodyId;
  faceHash: number;
  faceReference?: FaceTopologyReferenceV5;
  thickness: ParamValue;
  ids?: BodyFeatureIds;
}

export interface DirectEditInput {
  name: string;
  targetBodyId: BodyId;
  operation: DirectEditOperation;
  ids?: FeatureOnlyIds;
}

export interface EdgeModifierInput {
  name: string;
  targetBodyId: BodyId;
  edgeHashes: number[];
  edgeReferences?: EdgeTopologyReferenceV5[];
  size: ParamValue;
  /** Chamfer only: bevel angle in degrees; absent means symmetric 45°. */
  angleDeg?: ParamValue;
  /**
   * Fillet only: the radius at the far end of each selected edge. Absent
   * means the constant-radius fillet.
   */
  endRadius?: ParamValue;
  /** Fillet only: read only with `endRadius`; absent reads as 'linear'. */
  radiusLaw?: VariableFilletLaw;
  /**
   * Chamfer only: the setback on the second face each selected edge borders,
   * `size` landing on the first. Absent means the symmetric chamfer.
   */
  distance2?: ParamValue;
  ids?: BodyFeatureIds;
}

export interface PatternInput {
  name: string;
  targetBodyId: BodyId;
  patternKind: PatternKind;
  count: ParamValue;
  axis: AxisId;
  spacing?: ParamValue;
  angleDeg?: ParamValue;
  /** Linear only: arbitrary repeat direction overriding `axis`. */
  direction?: ParametricVector3;
  /** Grid only: second repeat axis; absent reads as 'y'. */
  axis2?: AxisId;
  /** Grid only: spacing along `axis2`; absent reads as `spacing`. */
  spacing2?: ParamValue;
  /** Grid only: instance count along `axis2`; absent reads as `count`. */
  count2?: ParamValue;
  ids?: BodyFeatureIds;
}

export interface ImportedMeshInput {
  name: string;
  artifactId: string;
  sourceName: string;
  triangleCount: number;
  /**
   * Embedded form, still written when blob storage is unavailable rather than
   * only by old imports. Exactly one of `vertices`+`indices` and
   * `meshPayloadRef`.
   */
  vertices?: number[];
  indices?: number[];
  /**
   * Content-addressed form; the encoded triangles live in the source blob
   * store. This is also what the `import.mesh` command log entry carries.
   */
  meshPayloadRef?: ImportedSourceReference;
  ids?: BodyFeatureIds;
}

export interface ImportedStepInput {
  name: string;
  artifactId: string;
  sourceName: string;
  /**
   * Embedded form, still written when blob storage is unavailable rather than
   * only by old imports. Exactly one of `stepText`/`stepSourceRef`.
   */
  stepText?: string;
  /** Content-addressed form; the bytes live in the source blob store. */
  stepSourceRef?: ImportedSourceReference;
  /** Partial import: declared-order solid indices to keep; absent = all. */
  solidIndices?: number[];
  planarEmboss?: Extract<
    FeatureData,
    { featureKind: 'imported-step' }
  >['planarEmboss'];
  ids?: BodyFeatureIds;
}

export interface ShaprGuidedImportInput {
  importId?: ShaprImportId;
  step: ImportedStepInput;
  migration: Omit<ShaprMigrationRecord, 'importId' | 'exactGeometry'>;
}

export interface ParameterSetInput {
  name: string;
  expression: string;
  /**
   * F05: the parameter's quantity. Absent leaves it as it is (a new
   * parameter is unitless); `null` clears it. A change is refused when it
   * would break an expression that uses the parameter.
   */
  quantity?: ParameterKind | null;
  /** Inline definitions must refuse a name added while validation awaited. */
  addOnly?: boolean;
  ids?: ParameterIds;
}

export interface ParameterToggleInput {
  name: string;
  bodyIds: BodyId[];
  ids?: ParameterIds;
}

export interface ParameterDeleteInput {
  name: string;
}

export interface ParameterRenameInput {
  name: string;
  newName: string;
}

export interface ParameterExposeInput {
  name: string;
  exposed: boolean;
}

export interface ParameterDescribeInput {
  name: string;
  description: string;
}

export interface FeatureUpdateInput {
  featureId: FeatureId;
  name?: string;
  /**
   * Partial patch of the feature's data variant. `featureKind` cannot change;
   * `dimensions` patches merge key-by-key, every other field replaces.
   */
  data?: Partial<FeatureData> & { dimensions?: Record<string, ParamValue> };
  /**
   * Optional data keys to REMOVE, applied after `data`.
   *
   * A patch cannot express a removal: an `undefined` value is skipped, which
   * is what keeps a partial patch from wiping fields it does not mention. An
   * optional field whose absence is its own meaning — a fillet with no end
   * radius is the constant blend, not a variable one with the same radius
   * twice — therefore cannot be switched off through `data` at all.
   *
   * Only the keys in {@link FEATURE_DATA_CLEARABLE_KEYS} may be named, so a
   * removal can never leave a feature without a field its builder requires.
   */
  clearData?: readonly string[];
}

export interface FeatureDeleteInput {
  featureId: FeatureId;
}

export interface NodeRenameInput {
  nodeId: string;
  name: string;
}

export function createProjectDocument(
  name: string,
  ownerUserId: UserId,
  units: UnitSystem = 'mm'
): ProjectDocument {
  const projectId = toProjectId(createId('proj'));
  const rootNodeId = toEntityId(createId('ent'));
  const rootAssemblyId = toEntityId(createId('ent'));
  const activePartId = toEntityId(createId('ent'));
  const createdAt = nowIso();

  const nodes: Record<string, DocumentNode> = {
    [rootNodeId]: {
      id: rootNodeId,
      kind: 'project',
      name,
      parentId: null,
      revisionId: null,
      projectId,
      units,
      activePartId
    },
    [rootAssemblyId]: {
      id: rootAssemblyId,
      kind: 'assembly',
      name: 'Root Assembly',
      parentId: rootNodeId,
      revisionId: null,
      childIds: [activePartId]
    },
    [activePartId]: {
      id: activePartId,
      kind: 'part',
      name: 'Part 1',
      parentId: rootAssemblyId,
      revisionId: null,
      childIds: []
    }
  };

  const initialRevision: RevisionRecord = {
    revisionId: toRevisionId(createId('rev')),
    createdAt,
    reason: 'Initial document',
    commandCount: 0
  };
  const initialCheckpoint: ProjectCheckpoint = {
    checkpointId: createId('checkpoint'),
    revisionId: initialRevision.revisionId,
    documentVersion: 1,
    createdAt,
    reason: 'Initial document'
  };

  return {
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    projectId,
    ownerUserId,
    rootNodeId,
    rootAssemblyId,
    activePartId,
    name,
    units,
    version: 1,
    nodes,
    featureOrder: [],
    bodyOrder: [],
    sketchOrder: [],
    parameterOrder: [],
    revisions: [initialRevision],
    checkpoints: [initialCheckpoint],
    commandLog: [],
    assets: {},
    shaprImports: {},
    shaprImportOrder: [],
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      updatedAt: createdAt
    }
  };
}

/**
 * `document` without an undo history this code cannot read.
 *
 * The history is a convenience on top of the model, so an unreadable one costs
 * the undo stack, not the project. Refusing the whole document instead left a
 * model whose only fault was an entry an older writer recorded unopenable on
 * every device, with every account save refused as well. Nothing traverses a
 * dropped history, so dropping it is as safe as refusing it; the validators of
 * incoming writes (the Worker, the room, `CommandManager`) stay strict.
 */
function withReadableHistory(document: ProjectDocument): ProjectDocument {
  if (
    document.editHistory === undefined ||
    isDocumentHistory(document.editHistory, document.projectId)
  ) {
    return document;
  }
  const { editHistory: _unreadable, ...readable } = document;
  return readable;
}

const KNOWN_PARAMETER_KINDS: readonly ParameterKind[] = [
  'length',
  'angle',
  'number'
];

/**
 * F05: a stored `quantity` must be one this client knows. The type union is
 * no protection for a document from collaboration, a backup or the API, and
 * an unknown kind would otherwise reach the scope and the Parameters panel,
 * so it is refused like any other malformed field rather than guessed at.
 */
function assertParameterQuantity(node: ParameterNode): void {
  const quantity: unknown = node.quantity;
  if (
    quantity !== undefined &&
    !(KNOWN_PARAMETER_KINDS as readonly unknown[]).includes(quantity)
  ) {
    throw new Error(
      `Parameter "${node.name}" has an unknown type ${JSON.stringify(quantity)}.`
    );
  }
}

/**
 * Fills in collections that older saved documents may lack, so loading a
 * pre-parametric document does not crash newer code paths.
 *
 * Fails closed on documents from a newer client: stamping the current version
 * and silently skipping unknown feature kinds would show and export a quietly
 * incomplete model, so a newer schema is refused instead.
 */
export function normalizeDocument(input: ProjectDocument): ProjectDocument {
  if (input.schemaVersion > PROJECT_DOCUMENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported project schema (v${input.schemaVersion}). Update OpenZCAD to open it.`
    );
  }
  const document = withReadableHistory(input);
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind === 'sketch') assertSketchReferenceDimensions(node);
    if (node.kind === 'parameter') assertParameterQuantity(node);
  }
  const revisions = Array.isArray(document.revisions)
    ? document.revisions
        .filter(isRevisionRecord)
        .slice(-MAX_PROJECT_REVISION_RECORDS)
    : [];
  const fallbackRevision = revisions.at(-1);
  const checkpoints = Array.isArray(document.checkpoints)
    ? document.checkpoints
        .slice(-MAX_PROJECT_CHECKPOINTS)
        .filter(isProjectCheckpoint)
    : fallbackRevision
      ? [
          {
            checkpointId: createId('checkpoint'),
            revisionId: fallbackRevision.revisionId,
            documentVersion: document.version ?? 1,
            createdAt: fallbackRevision.createdAt,
            reason: 'Migrated save point'
          }
        ]
      : [];
  let nodes = document.nodes;
  // Schema v3 -> v4: sketches gain planeRef; the legacy plane/offset pair
  // becomes a canonical reference. Additive, so a missed migration degrades
  // (old fields linger) rather than corrupts.
  for (const [nodeId, node] of Object.entries(document.nodes)) {
    if (node.kind !== 'sketch' || node.planeRef !== undefined) {
      continue;
    }
    if (nodes === document.nodes) {
      nodes = { ...document.nodes };
    }
    nodes[nodeId] = {
      ...node,
      planeRef: {
        type: 'canonical',
        plane: node.plane ?? 'XY',
        offset: node.offset ?? 0
      }
    } satisfies SketchNode;
  }
  // Schema v4 -> v5 topology references, v5 -> v6 modeling feature kinds,
  // v6 -> v7 text sketch objects plus entity-wide profile references,
  // v7 -> v8 advanced modeling feature kinds, and v8 -> v9 sketch
  // constraints are all
  // additive. Existing hashes and exact source geometry remain the fail-closed
  // fallback until a feature writes a lineage reference; a v6 document has no
  // text objects and no `all: true` reference, and a v8 sketch simply has no
  // `constraints`, so nothing needs rewriting.
  // Schema v15 -> v16 adds the canonical-plane basis marker. Never synthesize
  // it while migrating: unmarked saved sketches must retain revision 1 geometry.
  // Schema v16 -> v17 allows reference-form mesh payloads. Keep existing
  // embedded triangles and pre-release references as written; the version
  // boundary prevents older clients from accepting meshes they cannot rebuild.
  return {
    ...document,
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    nodes,
    parameterOrder: document.parameterOrder ?? [],
    featureOrder: document.featureOrder ?? [],
    bodyOrder: document.bodyOrder ?? [],
    sketchOrder: document.sketchOrder ?? [],
    revisions,
    checkpoints,
    assets: document.assets ?? {},
    shaprImports: document.shaprImports ?? {},
    shaprImportOrder: document.shaprImportOrder ?? []
  };
}

export function cloneDocument(document: ProjectDocument): ProjectDocument {
  // Derived state is a disposable projection the geometry worker rebuilds,
  // and nothing mutates it in place — `attachDerivedState` replaces the whole
  // field. It also carries every body's mesh arrays, so deep-copying it here
  // was the single largest main-thread allocation per command and multiplied
  // through history. Derived state and immutable undo entries share references.
  const { derived, editHistory, ...content } = document;
  return {
    ...deepClone(content),
    derived,
    ...(editHistory ? { editHistory } : {})
  };
}

/**
 * An independent copy of `source` under a new project id. The feature tree,
 * parameters, and command log remain editable and replayable. A recognized
 * legacy bracket recipe receives its bounded placement repair before copying.
 * A duplicate is a branching-off point for a variant. Node ids are document-scoped
 * and are therefore kept, preserving every intra-document reference.
 */
export function duplicateProjectDocument(
  source: ProjectDocument,
  name: string,
  ownerUserId: UserId,
  branchedFrom?: ProjectBranchPoint
): ProjectDocument {
  const copy = cloneDocument(
    repairLegacyBracketModel(normalizeDocument(source))
  );
  delete copy.editHistory;
  const projectId = toProjectId(createId('proj'));
  const rootNode = copy.nodes[copy.rootNodeId];
  if (rootNode?.kind === 'project') {
    copy.nodes[copy.rootNodeId] = { ...rootNode, projectId, name };
  }
  // A branch says which save it started from, because that is the thing the
  // user picked; a plain duplicate has only the project to name.
  const reason = branchedFrom
    ? `Branched from ${branchedFrom.projectName} · ${branchedFrom.checkpointReason}`
    : `Duplicated from ${source.name}`;
  return localizeImportedSourceArtifacts(
    createCheckpoint(
      appendRevision(
        {
          ...copy,
          projectId,
          ownerUserId,
          name,
          // A branch of a branch records where it actually came from, not where
          // its parent did.
          ...(branchedFrom ? { branchedFrom } : {}),
          derived: { ...copy.derived, updatedAt: nowIso() }
        },
        reason
      ),
      reason
    )
  );
}

/**
 * `current` rewound to the model `snapshot` held, as a forward edit.
 *
 * Restoring an old save is not a rewind of the project's timeline, and this is
 * the whole subtlety of the operation. `version` is a monotonic clock that
 * collaboration and every fenced cloud write compare against, and the
 * revision/checkpoint lists are the record of moments the user marked. Moving
 * any of them backwards would make an old save look like an unsaved edit to
 * the account, invite a conflict against a room that has already moved on, and
 * quietly delete the save points made after the one being restored — including
 * the one this restore is about to create, which is what makes a restore
 * escapable. So the model content comes from the snapshot and the timeline
 * keeps running: exactly the rule `restoreHistorySnapshot` already applies to
 * undo, for the same reasons.
 *
 * `branchedFrom` follows the timeline rather than the content: this project's
 * origin is a fact about the project, not about which save is currently loaded.
 */
export function restoreFromSaveState(
  current: ProjectDocument,
  snapshot: ProjectDocument,
  reason: string
): ProjectDocument {
  // The snapshot's undo stack belongs to the moment it was saved. The undo
  // stack of this document is the caller's to record (`applyDocumentEdit`);
  // carrying the snapshot's would persist a history that matches neither.
  const { editHistory: _snapshotHistory, ...restored } = cloneDocument(
    normalizeDocument(snapshot)
  );
  return appendRevision(
    {
      ...restored,
      projectId: current.projectId,
      ownerUserId: current.ownerUserId,
      version: current.version,
      revisions: current.revisions,
      checkpoints: current.checkpoints,
      ...(current.branchedFrom ? { branchedFrom: current.branchedFrom } : {}),
      // The restored model is not the geometry currently on screen. Keep the
      // stored `warnings` and stamp the edit time; the rebuild attaches meshes.
      derived: { ...restored.derived, updatedAt: nowIso() }
    },
    reason
  );
}

/** Changes only the identity of this document and its undo/redo snapshots. */
export function reidentifyProjectDocument(
  source: ProjectDocument,
  projectId: ProjectId
): ProjectDocument {
  if (source.projectId === projectId) return source;
  const copy = cloneDocument(source);
  copy.projectId = projectId;
  if (copy.editHistory) {
    copy.editHistory = deepClone(copy.editHistory);
    copy.editHistory.projectId = projectId;
  }
  for (const node of documentNodesWithHistory(copy)) {
    if (node.kind === 'project') node.projectId = projectId;
  }
  return copy;
}

/** Prepares the existing model and history for its account owner. */
export function adoptProjectDocument(
  source: ProjectDocument,
  ownerUserId: UserId,
  name = source.name
): ProjectDocument {
  // An adopted project receives a new account home. Archived source IDs are
  // owned by its old project; keep their checksum bytes available for upload
  // rather than claiming those foreign IDs belong to the new account copy.
  const copy = localizeImportedSourceArtifacts(
    cloneDocument(normalizeDocument(source))
  );
  const rootNode = copy.nodes[copy.rootNodeId];
  if (rootNode?.kind === 'project') {
    copy.nodes[copy.rootNodeId] = { ...rootNode, name };
  }
  // Adoption is a change of home, not an edit: `updatedAt` stays the device's
  // last edit so the shelf keeps its order after a bulk save to the account.
  const adopted: ProjectDocument = {
    ...copy,
    ownerUserId,
    name,
    ...(copy.editHistory
      ? { editHistory: { ...copy.editHistory, actorUserId: ownerUserId } }
      : {})
  };
  // A document with no revision at all cannot carry a checkpoint. That should
  // not happen, but adoption is a rescue path for documents this code has never
  // seen, so it declines to be the thing that refuses them.
  return adopted.revisions.length === 0
    ? adopted
    : createCheckpoint(adopted, 'Saved to account');
}

export function getNode<TNode extends DocumentNode>(
  document: ProjectDocument,
  nodeId: string
): TNode | undefined {
  return document.nodes[nodeId] as TNode | undefined;
}

export function listNodesByKind<TNode extends DocumentNode['kind']>(
  document: ProjectDocument,
  kind: TNode
): Extract<DocumentNode, { kind: TNode }>[] {
  return Object.values(document.nodes).filter(
    (node): node is Extract<DocumentNode, { kind: TNode }> => node.kind === kind
  );
}

export function findFeature(
  document: ProjectDocument,
  featureId: FeatureId
): FeatureNode | undefined {
  return listNodesByKind(document, 'feature').find(
    (feature) => feature.featureId === featureId
  );
}

export function findSketch(
  document: ProjectDocument,
  sketchId: SketchId
): SketchNode | undefined {
  return listNodesByKind(document, 'sketch').find(
    (sketch) => sketch.sketchId === sketchId
  );
}

export function findBodyNode(
  document: ProjectDocument,
  bodyId: BodyId
): BodyNode | undefined {
  return listNodesByKind(document, 'body').find(
    (body) => body.bodyId === bodyId
  );
}

/**
 * The name a body keeps through the features that reshape it. A fillet, a
 * hole or a pattern does not turn "Box Body" into a body called "Hole": the
 * feature is named in History, the body stays the thing the user made. Only
 * a body with no single source (a primitive, an extrude, a loft) takes its
 * name from its feature.
 */
export function derivedBodyName(
  document: ProjectDocument,
  sourceBodyId: BodyId | undefined,
  fallback: string
): string {
  const source = sourceBodyId ? findBodyNode(document, sourceBodyId) : null;
  return source?.name ?? fallback;
}

/**
 * The name a newly made body takes: its feature's name and the next number
 * no body in the document carries — "Box 1", "Box 2", "Extrude 1". Two boxes
 * both called "Box Body" could not be told apart in the body list, the
 * Union card or a face name. Consumed bodies keep their numbers, so a number
 * is never handed out twice while its body is still in history.
 *
 * Only for bodies being made now: the caller stores the result in the
 * command (`bodyName`), and nothing renames a body already in a document.
 * A name that already ends in a free number ("Bracket 2") is used as is.
 */
export function numberedBodyName(
  document: ProjectDocument,
  featureName: string
): string {
  const stem = featureName.trim() || 'Body';
  const names = listNodesByKind(document, 'body').map((body) => body.name);
  if (/\s[1-9]\d*$/.test(stem) && !names.includes(stem)) {
    return stem;
  }
  const prefix = `${stem} `;
  let highest = 0;
  for (const name of names) {
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    if (/^[1-9]\d*$/.test(suffix)) {
      highest = Math.max(highest, Number(suffix));
    }
  }
  return `${stem} ${highest + 1}`;
}

/**
 * The name a feature made now takes in History: the name it was given, or,
 * when another feature already carries that name, the next free number —
 * "Hole", then "Hole 2", "Hole 3". Two rows both reading "Hole" could not be
 * told apart in History or in the delete dialog. The first of a kind stays
 * unnumbered, so a single Hole is still just "Hole".
 *
 * Only for features being made now: the caller puts the result in the
 * command, and nothing renames a feature already in a document.
 */
export function numberedFeatureName(
  document: ProjectDocument,
  name: string
): string {
  const trimmed = name.trim();
  const names = new Set(
    listNodesByKind(document, 'feature').map((feature) => feature.name.trim())
  );
  if (trimmed.length === 0 || !names.has(trimmed)) {
    return name;
  }
  // "Hole 2" taken again counts on from "Hole", not to "Hole 2 2".
  const stem = /^(.*\S)\s+[1-9]\d*$/.exec(trimmed)?.[1] ?? trimmed;
  const prefix = `${stem} `;
  let highest = names.has(stem) ? 1 : 0;
  for (const existing of names) {
    const suffix = existing.startsWith(prefix)
      ? existing.slice(prefix.length)
      : '';
    if (/^[1-9]\d*$/.test(suffix)) {
      highest = Math.max(highest, Number(suffix));
    }
  }
  return `${stem} ${Math.max(highest, 1) + 1}`;
}

/**
 * An extrude that joins or cuts a target is still that body, so with a
 * numbered command it keeps the target's name, as a boolean does; a new body
 * takes the command's numbered name. A command without one keeps the legacy
 * "<feature> Body" whatever its operation, so old logs replay unchanged.
 */
function extrudeBodyName(
  document: ProjectDocument,
  input: ExtrudeInput
): string {
  if (input.bodyName === undefined) {
    return `${input.name} Body`;
  }
  return input.targetBodyId !== undefined && input.operation !== 'new-body'
    ? derivedBodyName(document, input.targetBodyId, input.bodyName)
    : input.bodyName;
}

function attachToPart(document: ProjectDocument, ...nodeIds: EntityId[]): void {
  const part = getNode(document, document.activePartId);
  if (part && (part.kind === 'part' || part.kind === 'assembly')) {
    part.childIds.push(...nodeIds);
  }
}

export function addPrimitiveFeature(
  document: ProjectDocument,
  input: PrimitiveInput
): ProjectDocument {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  const feature: FeatureNode = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'primitive',
    data: {
      featureKind: 'primitive',
      primitiveKind: input.primitiveKind,
      dimensions: input.dimensions
    }
  };

  const body: BodyNode = {
    id: bodyNodeId,
    kind: 'body',
    name: input.bodyName ?? `${input.name} Body`,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor('primitive') }
  };

  next.nodes[feature.id] = feature;
  next.nodes[body.id] = body;
  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, feature.id, body.id);
  next.version += 1;
  return next;
}

export function addSketchFeature(
  document: ProjectDocument,
  input: SketchInput
): { document: ProjectDocument; sketchId: SketchId } {
  const next = cloneDocument(document);
  const { planeRef, objects } = resolveSketchInput(input);
  if (planeRef.type === 'datum') {
    // A new sketch lands last, so every datum already in history is earlier.
    requireEarlierDatum(document, planeRef.datumFeatureId, null);
  }
  const ids = normalizeSketchFeatureIds(
    input.ids ?? createSketchFeatureIds(objects.length)
  );
  const { featureId, featureNodeId, sketchId, sketchNodeId } = ids;
  const objectNodeIds = objects.map(
    (_, index) => ids.objectNodeIds[index] ?? toEntityId(createId('ent'))
  );

  const sketchNode: SketchNode = {
    id: sketchNodeId,
    kind: 'sketch',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    sketchId,
    planeRef,
    objectIds: objectNodeIds
  };

  objects.forEach((object, index) => {
    const objectNodeId = objectNodeIds[index]!;
    next.nodes[objectNodeId] = {
      id: objectNodeId,
      kind: 'sketch-object',
      name: `${object.objectKind} profile`,
      parentId: sketchNodeId,
      revisionId: null,
      objectKind: object.objectKind,
      data: object
    };
  });

  next.nodes[sketchNode.id] = sketchNode;
  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    featureKind: 'sketch',
    data: {
      featureKind: 'sketch',
      sketchId
    }
  };

  next.featureOrder.push(featureId);
  next.sketchOrder.push(sketchId);
  attachToPart(next, featureNodeId, sketchNodeId);
  next.version += 1;
  return { document: next, sketchId };
}

export function updateSketch(
  document: ProjectDocument,
  input: SketchUpdateInput
): ProjectDocument {
  const next = cloneDocument(document);
  const sketch = findSketch(next, input.sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }
  if (input.planeRef !== undefined) {
    if (input.planeRef.type === 'datum') {
      const owner = listFeaturesInOrder(document).find(
        (feature) =>
          feature.data.featureKind === 'sketch' &&
          feature.data.sketchId === input.sketchId
      );
      requireEarlierDatum(
        document,
        input.planeRef.datumFeatureId,
        owner?.featureId ?? null
      );
    }
    sketch.planeRef = input.planeRef;
  } else if (input.plane !== undefined || input.offset !== undefined) {
    // v3 payloads patch the canonical plane fields piecemeal.
    const previous =
      sketch.planeRef.type === 'canonical'
        ? sketch.planeRef
        : { type: 'canonical' as const, plane: 'XY' as const, offset: 0 };
    // Keep the basis revision: the sketch's stored coordinates were drawn
    // against it, and dropping it would mirror a Front (XZ) sketch in place.
    sketch.planeRef = {
      type: 'canonical',
      plane: input.plane ?? previous.plane,
      offset: input.offset ?? previous.offset,
      ...('basisRevision' in previous && previous.basisRevision !== undefined
        ? { basisRevision: previous.basisRevision }
        : {})
    };
  }
  if (input.object !== undefined) {
    const objectId = sketch.objectIds[0];
    const objectNode = objectId ? next.nodes[objectId] : undefined;
    if (!objectNode || objectNode.kind !== 'sketch-object') {
      throw new Error(`Sketch ${input.sketchId} has no profile object.`);
    }
    objectNode.objectKind = input.object.objectKind;
    objectNode.data = input.object;
    objectNode.name = `${input.object.objectKind} profile`;
  }
  next.version += 1;
  return next;
}

export interface SketchTranslateInput {
  sketchId: SketchId;
  /** In-plane translation along the sketch plane's U axis. */
  du: number;
  /** In-plane translation along the sketch plane's V axis. */
  dv: number;
  /**
   * Translation along the plane normal. Only a canonical-plane sketch can
   * carry it (as a plane offset change); a frame- or face-attached sketch is
   * bound to its surface, so a non-zero `dn` on one is an error rather than
   * a silently dropped component.
   */
  dn?: number;
}

/**
 * Translates every object of a sketch in plane coordinates, as one edit.
 *
 * This is the document half of dragging a sketch with the move gizmo. Object
 * coordinates may be parameter expressions; a translated axis bakes the
 * resolved number (the same contract as every other direct manipulation),
 * while a zero-delta axis leaves the stored value — expression or number —
 * untouched, so dragging along X does not destroy a `w / 2` on Y.
 *
 * Downstream extrudes survive because profile resolution falls back to
 * source-entity matching when fingerprints move, and text extrudes reference
 * their entity directly.
 */
export function translateSketch(
  document: ProjectDocument,
  input: SketchTranslateInput
): ProjectDocument {
  const { du, dv } = input;
  const dn = input.dn ?? 0;
  if (![du, dv, dn].every(Number.isFinite)) {
    throw new Error('Sketch translation must be finite.');
  }
  const next = cloneDocument(document);
  const sketch = findSketch(next, input.sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }
  if (dn !== 0) {
    if (sketch.planeRef.type !== 'canonical') {
      throw new Error(
        'A face-attached sketch cannot move along its normal; it is bound to its surface.'
      );
    }
    const { scope } = getParameterScope(next);
    sketch.planeRef = {
      ...sketch.planeRef,
      offset:
        resolveParamValue(
          sketch.planeRef.offset,
          scope,
          'sketch offset',
          next.units
        ) + dn
    };
  }
  if (du !== 0 || dv !== 0) {
    const { scope } = getParameterScope(next);
    const shift = (
      value: ParamValue,
      delta: number,
      label: string
    ): ParamValue =>
      delta === 0
        ? value
        : resolveParamValue(value, scope, label, next.units) + delta;
    for (const objectId of sketch.objectIds) {
      const node = next.nodes[objectId];
      if (node?.kind !== 'sketch-object') {
        continue;
      }
      const data = node.data;
      switch (data.objectKind) {
        case 'line':
          node.data = {
            ...data,
            x1: shift(data.x1, du, 'line x1'),
            y1: shift(data.y1, dv, 'line y1'),
            x2: shift(data.x2, du, 'line x2'),
            y2: shift(data.y2, dv, 'line y2')
          };
          break;
        case 'rectangle':
        case 'circle':
        case 'polygon':
        case 'arc':
          node.data = {
            ...data,
            centerX: shift(data.centerX, du, 'center X'),
            centerY: shift(data.centerY, dv, 'center Y')
          };
          break;
        case 'text':
          node.data = {
            ...data,
            x: shift(data.x, du, 'text X'),
            y: shift(data.y, dv, 'text Y')
          };
          break;
      }
    }
  }
  next.version += 1;
  return next;
}

export function addSketchObjects(
  document: ProjectDocument,
  input: SketchObjectAddInput
): { document: ProjectDocument; objectNodeIds: EntityId[] } {
  const next = cloneDocument(document);
  const sketch = findSketch(next, input.sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }
  const objectNodeIds = input.objects.map(
    (_, index) => input.ids?.objectNodeIds[index] ?? toEntityId(createId('ent'))
  );
  input.objects.forEach((object, index) => {
    const objectNodeId = objectNodeIds[index]!;
    next.nodes[objectNodeId] = {
      id: objectNodeId,
      kind: 'sketch-object',
      name: `${object.objectKind} profile`,
      parentId: sketch.id,
      revisionId: null,
      objectKind: object.objectKind,
      data: object
    };
    sketch.objectIds.push(objectNodeId);
  });
  next.version += 1;
  return { document: next, objectNodeIds };
}

function requireSketchObject(
  document: ProjectDocument,
  sketchId: SketchId,
  objectId: EntityId
): { sketch: SketchNode; objectNode: SketchObjectNode } {
  const sketch = findSketch(document, sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${sketchId} not found.`);
  }
  const objectNode = sketch.objectIds.includes(objectId)
    ? document.nodes[objectId]
    : undefined;
  if (!objectNode || objectNode.kind !== 'sketch-object') {
    throw new Error(`Sketch ${sketchId} has no object ${objectId}.`);
  }
  return { sketch, objectNode };
}

export function updateSketchObject(
  document: ProjectDocument,
  input: SketchObjectUpdateInput
): ProjectDocument {
  const next = cloneDocument(document);
  const { objectNode } = requireSketchObject(
    next,
    input.sketchId,
    input.objectId
  );
  objectNode.objectKind = input.data.objectKind;
  objectNode.data = input.data;
  objectNode.name = `${input.data.objectKind} profile`;
  next.version += 1;
  return next;
}

export function deleteSketchObject(
  document: ProjectDocument,
  input: SketchObjectDeleteInput
): ProjectDocument {
  const original = requireSketchObject(
    document,
    input.sketchId,
    input.objectId
  );
  assertNoReferenceDimensionDependents(original.sketch, input.objectId);
  const next = cloneDocument(document);
  const { sketch } = requireSketchObject(next, input.sketchId, input.objectId);
  sketch.objectIds = sketch.objectIds.filter((id) => id !== input.objectId);
  // Constraints referencing the deleted object go with it: a dangling
  // reference would fail every later solve rather than one delete.
  if (sketch.constraints && sketch.constraints.length > 0) {
    sketch.constraints = sketch.constraints.filter(
      (constraint) =>
        !constraintObjectIds(constraint.data).includes(input.objectId)
    );
  }
  delete next.nodes[input.objectId];
  next.version += 1;
  return next;
}

/** Every sketch object a constraint references, in declaration order. */
function constraintObjectIds(data: SketchConstraintData): EntityId[] {
  switch (data.constraintKind) {
    case 'coincident':
      return [data.a.objectId, data.b.objectId];
    case 'horizontal':
    case 'vertical':
    case 'radius':
      return [data.objectId];
    case 'parallel':
    case 'perpendicular':
    case 'equal':
    case 'tangent':
    case 'concentric':
    case 'angle':
      return [data.a, data.b];
    case 'midpoint':
      return [data.point.objectId, data.line];
    case 'distance':
      return [data.a.objectId, data.b.objectId];
    case 'symmetric':
      return [data.a.objectId, data.b.objectId, data.axis];
    case 'point-on-object':
      return [data.point.objectId, data.objectId];
    case 'lock':
      return [data.point.objectId];
  }
}

type ConstrainableKind = 'line' | 'arc' | 'circle';

function requireConstrainableObject(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: EntityId,
  allowed: readonly ConstrainableKind[]
): ConstrainableKind {
  const node = sketch.objectIds.includes(objectId)
    ? document.nodes[objectId]
    : undefined;
  if (!node || node.kind !== 'sketch-object') {
    throw new Error(`Sketch ${sketch.sketchId} has no object ${objectId}.`);
  }
  const kind = node.objectKind;
  if (!(allowed as readonly string[]).includes(kind)) {
    // v1 constraints attach to point-addressable objects only; rectangles,
    // polygons, and text have no point identity to constrain.
    throw new Error(
      `A ${kind} object cannot carry this constraint; expected ${allowed.join(' or ')}.`
    );
  }
  return kind as ConstrainableKind;
}

function requireConstraintPoint(
  document: ProjectDocument,
  sketch: SketchNode,
  ref: SketchPointRef
): void {
  const kind = requireConstrainableObject(document, sketch, ref.objectId, [
    'line',
    'arc',
    'circle'
  ]);
  const legal =
    kind === 'line'
      ? ref.point === 'start' || ref.point === 'end'
      : kind === 'circle'
        ? ref.point === 'center'
        : true; // arcs expose center, start, and end
  if (!legal) {
    throw new Error(`A ${kind} object has no '${ref.point}' point.`);
  }
}

function requireLiteralPositive(value: unknown, label: string): void {
  if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${label} must be a positive number.`);
  }
}

/**
 * Structural validation for a constraint against its sketch: every referenced
 * object exists, is a constrainable kind, and exposes the named points.
 * Expression values are validated at solve time, when parameters resolve.
 */
function validateSketchConstraint(
  document: ProjectDocument,
  sketch: SketchNode,
  data: SketchConstraintData
): void {
  switch (data.constraintKind) {
    case 'coincident':
      requireConstraintPoint(document, sketch, data.a);
      requireConstraintPoint(document, sketch, data.b);
      break;
    case 'horizontal':
    case 'vertical':
      requireConstrainableObject(document, sketch, data.objectId, ['line']);
      break;
    case 'parallel':
    case 'perpendicular':
      requireConstrainableObject(document, sketch, data.a, ['line']);
      requireConstrainableObject(document, sketch, data.b, ['line']);
      break;
    case 'equal': {
      const a = requireConstrainableObject(document, sketch, data.a, [
        'line',
        'arc',
        'circle'
      ]);
      const b = requireConstrainableObject(document, sketch, data.b, [
        'line',
        'arc',
        'circle'
      ]);
      // Equal length pairs lines; equal radius pairs curves. Mixing the two
      // has no meaning the solver could satisfy.
      if ((a === 'line') !== (b === 'line')) {
        throw new Error(
          'An equal constraint pairs two lines or two circles/arcs.'
        );
      }
      break;
    }
    case 'tangent': {
      // Two forms. Point-free line↔circle, which the kernel states as a
      // center-to-line distance; and line↔arc, which the kernel states at a
      // named contact point, so that form carries `at`.
      const a = requireConstrainableObject(document, sketch, data.a, [
        'line',
        'arc',
        'circle'
      ]);
      const b = requireConstrainableObject(document, sketch, data.b, [
        'line',
        'arc',
        'circle'
      ]);
      if ((a === 'line') === (b === 'line')) {
        throw new Error(
          'A tangent constraint pairs one line with one circle or arc.'
        );
      }
      const arcSide = a === 'arc' ? data.a : b === 'arc' ? data.b : null;
      if (arcSide === null) {
        if (data.at) {
          throw new Error(
            'A line-to-circle tangent constraint has no contact point.'
          );
        }
        break;
      }
      if (!data.at) {
        throw new Error(
          'A tangent constraint against an arc must name the arc point it touches.'
        );
      }
      if (data.at.objectId !== arcSide) {
        throw new Error(
          'A tangent contact point must belong to the arc it constrains.'
        );
      }
      if (data.at.point !== 'start' && data.at.point !== 'end') {
        throw new Error('A tangent contact point is an arc start or end.');
      }
      requireConstraintPoint(document, sketch, data.at);
      break;
    }
    case 'concentric':
      requireConstrainableObject(document, sketch, data.a, ['arc', 'circle']);
      requireConstrainableObject(document, sketch, data.b, ['arc', 'circle']);
      break;
    case 'midpoint':
      requireConstraintPoint(document, sketch, data.point);
      requireConstrainableObject(document, sketch, data.line, ['line']);
      break;
    case 'distance':
      requireConstraintPoint(document, sketch, data.a);
      requireConstraintPoint(document, sketch, data.b);
      requireLiteralPositive(data.value, 'Distance');
      break;
    case 'radius':
      requireConstrainableObject(document, sketch, data.objectId, [
        'arc',
        'circle'
      ]);
      requireLiteralPositive(data.value, 'Radius');
      break;
    case 'angle':
      requireConstrainableObject(document, sketch, data.a, ['line']);
      requireConstrainableObject(document, sketch, data.b, ['line']);
      if (
        typeof data.valueDeg === 'number' &&
        !Number.isFinite(data.valueDeg)
      ) {
        throw new Error('Angle must be a finite number of degrees.');
      }
      break;
    case 'symmetric':
      requireConstraintPoint(document, sketch, data.a);
      requireConstraintPoint(document, sketch, data.b);
      requireConstrainableObject(document, sketch, data.axis, ['line']);
      if (samePointRef(data.a, data.b)) {
        throw new Error('A symmetric constraint mirrors two different points.');
      }
      // A line's own endpoint cannot be mirrored about that line: the only
      // solution collapses the axis onto the point.
      if (data.a.objectId === data.axis || data.b.objectId === data.axis) {
        throw new Error(
          'A symmetry axis cannot be one of the lines it mirrors.'
        );
      }
      break;
    case 'point-on-object':
      requireConstraintPoint(document, sketch, data.point);
      requireConstrainableObject(document, sketch, data.objectId, [
        'line',
        'arc',
        'circle'
      ]);
      if (data.point.objectId === data.objectId) {
        throw new Error(
          'A point cannot be held on the object it already belongs to.'
        );
      }
      break;
    case 'lock':
      requireConstraintPoint(document, sketch, data.point);
      if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) {
        throw new Error('A locked point needs a finite position.');
      }
      if (
        (sketch.constraints ?? []).some(
          (existing) =>
            existing.data.constraintKind === 'lock' &&
            samePointRef(existing.data.point, data.point)
        )
      ) {
        throw new Error('That point is already locked.');
      }
      break;
  }
}

function samePointRef(a: SketchPointRef, b: SketchPointRef): boolean {
  return a.objectId === b.objectId && a.point === b.point;
}

export function addSketchConstraint(
  document: ProjectDocument,
  input: SketchConstraintAddInput
): { document: ProjectDocument; constraintId: SketchConstraintId } {
  const next = cloneDocument(document);
  const sketch = findSketch(next, input.sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }
  validateSketchConstraint(next, sketch, input.constraint);
  const constraintId =
    input.ids?.constraintId ?? toSketchConstraintId(createId('scon'));
  const constraint: SketchConstraint = {
    constraintId,
    data: input.constraint
  };
  sketch.constraints = [...(sketch.constraints ?? []), constraint];
  next.version += 1;
  return { document: next, constraintId };
}

export function deleteSketchConstraint(
  document: ProjectDocument,
  input: SketchConstraintDeleteInput
): ProjectDocument {
  const next = cloneDocument(document);
  const sketch = findSketch(next, input.sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }
  const remaining = (sketch.constraints ?? []).filter(
    (constraint) => constraint.constraintId !== input.constraintId
  );
  if (remaining.length === (sketch.constraints ?? []).length) {
    throw new Error(
      `Sketch ${input.sketchId} has no constraint ${input.constraintId}.`
    );
  }
  sketch.constraints = remaining;
  // Keep an orphaned position in the additive map. Replacing a driving
  // constraint during value editing deletes and re-adds the same identity in
  // one transaction; retaining it preserves the user's label placement.
  next.version += 1;
  return next;
}

/**
 * Stores a driving-dimension label's plane-local decluttering offset. This is
 * presentation state attached to the sketch, not a constraint value: it
 * cannot alter solved geometry and replays independently through history.
 */
export function setSketchDimensionLabelPosition(
  document: ProjectDocument,
  input: SketchDimensionLabelPositionInput
): ProjectDocument {
  const { x, y } = input.position;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('Dimension label position must be finite.');
  }
  if (Math.max(Math.abs(x), Math.abs(y)) > 1e6) {
    throw new Error('Dimension label position is outside the supported range.');
  }
  const next = cloneDocument(document);
  const sketch = findSketch(next, input.sketchId);
  if (!sketch) {
    throw new Error(`Sketch ${input.sketchId} not found.`);
  }
  const constraint = sketch.constraints?.find(
    (candidate) => candidate.constraintId === input.constraintId
  );
  if (!constraint) {
    throw new Error(
      `Sketch ${input.sketchId} has no constraint ${input.constraintId}.`
    );
  }
  const positions = { ...(sketch.dimensionLabelPositions ?? {}) };
  // Zero is the canonical default, so omit it and keep legacy documents as
  // compact as possible after a label is returned to its derived anchor.
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) {
    delete positions[String(input.constraintId)];
  } else {
    positions[String(input.constraintId)] = { x, y };
  }
  sketch.dimensionLabelPositions =
    Object.keys(positions).length > 0 ? positions : undefined;
  next.version += 1;
  return next;
}

/**
 * F01 through-all, first slice: a cut through exactly one explicit target,
 * with an explicit side. Everything else fails closed rather than guessing a
 * target, an operation, or which side was meant.
 */
export function validateExtrudeExtent(data: {
  endCondition?: unknown;
  throughAllSide?: unknown;
  operation?: unknown;
  targetBodyId?: unknown;
  symmetric?: unknown;
  backDistance?: unknown;
}): void {
  // Only an absent field is blind: a stored `null` is malformed, not legacy.
  const condition =
    data.endCondition === undefined ? 'blind' : data.endCondition;
  if (condition === 'blind') {
    if (data.throughAllSide !== undefined) {
      throw new Error('A blind extrude has no through-all side.');
    }
    return;
  }
  if (condition !== 'through-all') {
    throw new Error(
      `Unknown extrude end condition ${JSON.stringify(condition)}.`
    );
  }
  if (data.operation !== 'cut') {
    throw new Error('Through all is available for a cut extrusion only.');
  }
  if (typeof data.targetBodyId !== 'string' || !data.targetBodyId) {
    throw new Error('A through-all cut needs one explicit target body.');
  }
  if (
    typeof data.throughAllSide !== 'string' ||
    !['forward', 'backward', 'both'].includes(data.throughAllSide)
  ) {
    throw new Error(
      'A through-all cut needs a side: forward, backward or both.'
    );
  }
  if (data.symmetric === true) {
    throw new Error(
      'A through-all cut is not symmetric; choose the side "both" instead.'
    );
  }
  if (
    data.backDistance !== undefined &&
    data.backDistance !== 0 &&
    data.backDistance !== '0'
  ) {
    throw new Error(
      'A through-all cut has no back distance; choose the side "both" instead.'
    );
  }
}

export function extrudeSketch(
  document: ProjectDocument,
  input: ExtrudeInput
): { document: ProjectDocument; bodyId: BodyId } {
  if (input.symmetric && input.backDistance !== undefined) {
    throw new Error(
      'An extrude cannot be both symmetric and two-sided; set symmetric or backDistance, not both.'
    );
  }
  validateExtrudeExtent(input);
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'extrude',
    data: {
      featureKind: 'extrude',
      sketchId: input.sketchId,
      distance: input.distance,
      ...(input.symmetric ? { symmetric: true } : {}),
      ...(input.backDistance === undefined
        ? {}
        : { backDistance: input.backDistance }),
      ...(input.operation === undefined ? {} : { operation: input.operation }),
      ...(input.targetBodyId === undefined
        ? {}
        : { targetBodyId: input.targetBodyId }),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.profiles && input.profiles.length > 0
        ? { profiles: input.profiles }
        : {}),
      ...(input.endCondition === 'through-all'
        ? {
            endCondition: 'through-all' as const,
            throughAllSide: input.throughAllSide!
          }
        : {})
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name: extrudeBodyName(document, input),
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor('extrude') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

export function revolveSketch(
  document: ProjectDocument,
  input: RevolveInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'revolve',
    data: {
      featureKind: 'revolve',
      sketchId: input.sketchId,
      axis: input.axis,
      // Written only when asked for. An absent field is a full turn, so a
      // full revolve stays byte-identical to one authored before partial
      // revolve existed — including its ADR-013 semantic lineage.
      ...(input.angleDeg === undefined ? {} : { angleDeg: input.angleDeg })
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name: input.bodyName ?? `${input.name} Body`,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor('revolve') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

export function loftSections(
  document: ProjectDocument,
  input: LoftInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'loft',
    {
      featureKind: 'loft',
      sections: deepClone(input.sections),
      mode: input.mode,
      // Written only when asked for. An absent apex point is a flat cap, so a
      // loft stays byte-identical to one authored before apex points existed.
      ...(input.endPoint === undefined
        ? {}
        : { endPoint: deepClone(input.endPoint) })
    },
    input.ids,
    input.bodyName
  );
}

export function sweepProfile(
  document: ProjectDocument,
  input: SweepInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'sweep',
    {
      featureKind: 'sweep',
      profile: deepClone(input.profile),
      path: deepClone(input.path),
      mode: input.mode,
      // Written only when asked for; an absent rail is the rotation-minimizing
      // frame every sweep authored before guide rails existed swept with.
      ...(input.guide === undefined ? {} : { guide: deepClone(input.guide) })
    },
    input.ids,
    input.bodyName
  );
}

export function helicalSweepProfile(
  document: ProjectDocument,
  input: HelicalSweepInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'helical-sweep',
    {
      featureKind: 'helical-sweep',
      profile: deepClone(input.profile),
      axisOrigin: deepClone(input.axisOrigin),
      axisDirection: deepClone(input.axisDirection),
      radius: input.radius,
      pitch: input.pitch,
      turns: input.turns
    },
    input.ids,
    input.bodyName
  );
}

export function booleanBodies(
  document: ProjectDocument,
  input: BooleanInput
): { document: ProjectDocument; bodyId: BodyId } {
  if (input.targetBodyIds.length < 2) {
    throw new Error('Boolean operations need at least two target bodies.');
  }
  if (new Set(input.targetBodyIds).size !== input.targetBodyIds.length) {
    throw new Error('Boolean operations cannot target the same body twice.');
  }
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'boolean',
    data: {
      featureKind: 'boolean',
      ...(input.activeWhen !== undefined
        ? { activeWhen: input.activeWhen }
        : {}),
      operation: input.operation,
      targetBodyIds: input.targetBodyIds
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    // A subtract's result is still the base body with material cut away, so
    // it keeps the base body's name. A union or intersect made with a
    // numbered name is a body of its own; one recorded without one keeps the
    // base body's name, as it always did.
    name:
      input.bodyName !== undefined && input.operation !== 'subtract'
        ? input.bodyName
        : derivedBodyName(
            document,
            input.targetBodyIds[0],
            `${input.name} Body`
          ),
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor('boolean') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

/**
 * The datum features defined before `beforeFeatureId` (all of them when it is
 * null, which is where a new feature lands). A reference may only point
 * backward in history: the datum resolves at its own position, and nothing
 * after it can change what an earlier consumer saw.
 */
function datumFeaturesBefore(
  document: ProjectDocument,
  beforeFeatureId: FeatureId | null
): Set<FeatureId> {
  const datums = new Set<FeatureId>();
  for (const feature of listFeaturesInOrder(document)) {
    if (feature.featureId === beforeFeatureId) break;
    if (feature.data.featureKind === 'datum-plane')
      datums.add(feature.featureId);
  }
  return datums;
}

function requireEarlierDatum(
  document: ProjectDocument,
  datumFeatureId: FeatureId,
  beforeFeatureId: FeatureId | null
): void {
  const node = listFeaturesInOrder(document).find(
    (feature) => feature.featureId === datumFeatureId
  );
  if (!node || node.data.featureKind !== 'datum-plane') {
    throw new Error(`No datum plane ${datumFeatureId} exists.`);
  }
  if (!datumFeaturesBefore(document, beforeFeatureId).has(datumFeatureId)) {
    throw new Error(
      `Datum plane "${node.name}" comes later in history; a plane can only use an earlier one.`
    );
  }
}

/** A Split or Mirror plane: finite numbers, or an earlier datum. */
export function validateModelingPlane(
  document: ProjectDocument,
  plane: ModelingPlaneReference,
  ownFeatureId: FeatureId | null
): void {
  if (isDatumPlaneRef(plane)) {
    requireEarlierDatum(document, plane.datumFeatureId, ownFeatureId);
    if (
      Object.keys(plane).some(
        (key) => key !== 'type' && key !== 'datumFeatureId'
      )
    ) {
      throw new Error('A datum plane reference carries only the datum id.');
    }
  }
}

function sameSource(a: DatumPlaneSource, b: DatumPlaneSource): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'datum' && b.type === 'datum')
    return a.datumFeatureId === b.datumFeatureId;
  if (a.type === 'face' && b.type === 'face')
    return (
      a.bodyId === b.bodyId &&
      a.faceReference.lineageName === b.faceReference.lineageName &&
      a.faceReference.producingFeatureId === b.faceReference.producingFeatureId
    );
  return JSON.stringify(a) === JSON.stringify(b);
}

function requireFiniteLiteral(value: ParamValue, label: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite distance.`);
  }
}

/**
 * Structural checks on a datum definition at its history position. Geometric
 * ones (parallel, separated, a resolvable face) need the exact build and are
 * refused there, by name, with the datum's authored definition kept.
 */
export function validateDatumPlaneDefinition(
  document: ProjectDocument,
  definition: DatumPlaneDefinition,
  ownFeatureId: FeatureId | null
): void {
  const sources =
    definition.kind === 'offset' ? [definition.source] : definition.sources;
  if (definition.kind === 'offset') {
    requireFiniteLiteral(definition.offset, 'The plane offset');
  } else if (definition.kind !== 'midplane' || sources.length !== 2) {
    throw new Error('A datum plane is an offset plane or a midplane.');
  }
  for (const source of sources) {
    switch (source.type) {
      case 'canonical':
        if (!['XY', 'XZ', 'YZ'].includes(source.plane)) {
          throw new Error(`Unknown canonical plane "${String(source.plane)}".`);
        }
        requireFiniteLiteral(source.offset, 'The source plane offset');
        break;
      case 'datum':
        if (source.datumFeatureId === ownFeatureId) {
          throw new Error('A datum plane cannot be its own source.');
        }
        requireEarlierDatum(document, source.datumFeatureId, ownFeatureId);
        break;
      case 'face':
        if (!source.faceReference || !source.sourceCentroid) {
          throw new Error(
            'A face source needs a qualified lineage reference; pick an exact planar face.'
          );
        }
        if (!document.bodyOrder.includes(source.bodyId)) {
          throw new Error(
            `The source face's body ${source.bodyId} does not exist.`
          );
        }
        break;
      default:
        throw new Error('A datum plane source is a plane, a datum or a face.');
    }
  }
  if (definition.kind === 'midplane' && sameSource(sources[0]!, sources[1]!)) {
    throw new Error('A midplane needs two different source planes.');
  }
}

/**
 * The names of everything that resolves through datum `datumFeatureId`: later
 * datums built from it, Mirror and Split features cutting on it, and sketches
 * drawn on it. Suppressed entries count; their references are still live.
 */
export function datumPlaneDependents(
  document: ProjectDocument,
  datumFeatureId: FeatureId
): string[] {
  const names: string[] = [];
  const usesDatum = (source: DatumPlaneSource | ModelingPlaneReference) =>
    'type' in source &&
    source.type === 'datum' &&
    source.datumFeatureId === datumFeatureId;
  for (const feature of listFeaturesInOrder(document)) {
    const { data } = feature;
    let uses = false;
    if (data.featureKind === 'datum-plane') {
      const sources =
        data.definition.kind === 'offset'
          ? [data.definition.source]
          : data.definition.sources;
      uses = sources.some(usesDatum);
    } else if (data.featureKind === 'mirror' || data.featureKind === 'split') {
      uses = usesDatum(data.plane);
    } else if (data.featureKind === 'sketch') {
      const planeRef = findSketch(document, data.sketchId)?.planeRef;
      uses =
        planeRef?.type === 'datum' &&
        planeRef.datumFeatureId === datumFeatureId;
    }
    if (uses) names.push(feature.name);
  }
  return names;
}

/** Adds an R01 datum plane at the end of history; it owns no body. */
export function addDatumPlane(
  document: ProjectDocument,
  input: DatumPlaneInput
): { document: ProjectDocument; featureId: FeatureId } {
  validateDatumPlaneDefinition(document, input.definition, null);
  const next = cloneDocument(document);
  const { featureId, featureNodeId } = input.ids ?? createFeatureOnlyIds();
  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    featureKind: 'datum-plane',
    data: {
      featureKind: 'datum-plane',
      definition: deepClone(input.definition)
    }
  };
  next.featureOrder.push(featureId);
  attachToPart(next, featureNodeId);
  next.version += 1;
  return { document: next, featureId };
}

export function transformBody(
  document: ProjectDocument,
  input: TransformInput
): { document: ProjectDocument; bodyId: BodyId } {
  // Preserve expression-valued parameters while refusing numeric values that
  // would turn into null when the document or command log is serialized.
  const values = [
    input.translation.x,
    input.translation.y,
    input.translation.z,
    input.rotationDeg?.x,
    input.rotationDeg?.y,
    input.rotationDeg?.z,
    input.scale
  ];
  if (
    values.some((value) => typeof value === 'number' && !Number.isFinite(value))
  ) {
    throw new Error('Body transform values must be finite.');
  }
  const next = cloneDocument(document);
  const { featureId, featureNodeId } = input.ids ?? createFeatureOnlyIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    featureKind: 'transform',
    data: {
      featureKind: 'transform',
      targetBodyId: input.targetBodyId,
      transform: {
        translation: input.translation,
        rotationDeg: input.rotationDeg ?? { x: 0, y: 0, z: 0 },
        ...(input.scale !== undefined ? { scale: input.scale } : {})
      }
    }
  };

  next.featureOrder.push(featureId);
  attachToPart(next, featureNodeId);
  next.version += 1;
  return { document: next, bodyId: input.targetBodyId };
}

/**
 * Append an in-place exact-topology edit. Like a transform, this keeps the
 * target BodyId stable while preserving the imported STEP source earlier in
 * history for deterministic rebuild, undo, and collaboration replay.
 */
export function directEditBody(
  document: ProjectDocument,
  input: DirectEditInput
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId } = input.ids ?? createFeatureOnlyIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    featureKind: 'direct-edit',
    data: {
      featureKind: 'direct-edit',
      targetBodyId: input.targetBodyId,
      operation: input.operation
    }
  };

  next.featureOrder.push(featureId);
  attachToPart(next, featureNodeId);
  next.version += 1;
  return { document: next, bodyId: input.targetBodyId };
}

function addBodyResultFeature(
  document: ProjectDocument,
  name: string,
  featureKind:
    | 'fillet'
    | 'chamfer'
    | 'pattern'
    | 'mirror'
    | 'hole'
    | 'shell'
    | 'solid-offset'
    | 'loft'
    | 'sweep'
    | 'helical-sweep'
    | 'draft'
    | 'thicken',
  data: Extract<
    FeatureData,
    {
      featureKind:
        | 'fillet'
        | 'chamfer'
        | 'pattern'
        | 'mirror'
        | 'hole'
        | 'shell'
        | 'solid-offset'
        | 'loft'
        | 'sweep'
        | 'helical-sweep'
        | 'draft'
        | 'thicken';
    }
  >,
  ids?: BodyFeatureIds,
  bodyName?: string
): { document: ProjectDocument; bodyId: BodyId } {
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    ids ?? createBodyFeatureIds();
  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind,
    data
  };
  const sourceBodyId = 'targetBodyId' in data ? data.targetBodyId : undefined;
  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    // A mirror leaves its source in place, so the copy needs a name of its
    // own; every other kind replaces its source and keeps the source's name.
    // A body with no source (a loft, a sweep) takes the numbered name its
    // command carries, when it carries one.
    name:
      featureKind === 'mirror'
        ? `${derivedBodyName(document, sourceBodyId, name)} mirror`
        : derivedBodyName(document, sourceBodyId, bodyName ?? name),
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor(featureKind) }
  };
  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

/**
 * Splits one body by a plane into two: the feature's own `bodyId` is the
 * half on the side the plane normal points toward, `secondBodyId` the other.
 * Unlike every `addBodyResultFeature` kind this writes TWO body nodes, which
 * is why it is its own function rather than a wrapper.
 */
export function addSplitFeature(
  document: ProjectDocument,
  input: SplitInput
): { document: ProjectDocument; bodyId: BodyId; secondBodyId: BodyId } {
  validateModelingPlane(document, input.plane, null);
  const next = cloneDocument(document);
  const ids = input.ids ?? createSplitFeatureIds();
  const { featureId, featureNodeId, bodyId, bodyNodeId } = ids;
  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'split',
    data: {
      featureKind: 'split',
      targetBodyId: input.targetBodyId,
      plane: deepClone(input.plane),
      secondBodyId: ids.secondBodyId
    }
  };
  const bodyNode = (
    id: EntityId,
    ownBodyId: BodyId,
    name: string
  ): BodyNode => ({
    id,
    kind: 'body',
    name,
    parentId: next.activePartId,
    revisionId: null,
    bodyId: ownBodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'brep',
    exportableStep: true,
    metadata: { color: featureColor('split') }
  });
  const sourceName = derivedBodyName(document, input.targetBodyId, input.name);
  next.nodes[bodyNodeId] = bodyNode(bodyNodeId, bodyId, sourceName);
  next.nodes[ids.secondBodyNodeId] = bodyNode(
    ids.secondBodyNodeId,
    ids.secondBodyId,
    `${sourceName} (back)`
  );
  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId, ids.secondBodyId);
  attachToPart(next, featureNodeId, bodyNodeId, ids.secondBodyNodeId);
  next.version += 1;
  return { document: next, bodyId, secondBodyId: ids.secondBodyId };
}

/** Drills a hole feature; the target body is consumed by its drilled result. */
export function holeBody(
  document: ProjectDocument,
  input: HoleInput
): { document: ProjectDocument; bodyId: BodyId } {
  const { name, targetBodyId, ids: _ids, ...parameters } = input;
  return addBodyResultFeature(
    document,
    name,
    'hole',
    deepClone({ featureKind: 'hole', targetBodyId, ...parameters }),
    input.ids
  );
}

/** Adds an independent mirrored copy; the source body is not consumed. */
export function mirrorBody(
  document: ProjectDocument,
  input: MirrorInput
): { document: ProjectDocument; bodyId: BodyId } {
  validateModelingPlane(document, input.plane, null);
  return addBodyResultFeature(
    document,
    input.name,
    'mirror',
    {
      featureKind: 'mirror',
      targetBodyId: input.targetBodyId,
      plane: deepClone(input.plane)
    },
    input.ids
  );
}

export function shellBody(
  document: ProjectDocument,
  input: ShellInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'shell',
    {
      featureKind: 'shell',
      targetBodyId: input.targetBodyId,
      openingFaceHashes: [...new Set(input.openingFaceHashes)],
      ...(input.openingFaceReferences
        ? { openingFaceReferences: deepClone(input.openingFaceReferences) }
        : {}),
      thickness: input.thickness
    },
    input.ids
  );
}

export function offsetSolidBody(
  document: ProjectDocument,
  input: SolidOffsetInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'solid-offset',
    {
      featureKind: 'solid-offset',
      targetBodyId: input.targetBodyId,
      distance: input.distance
    },
    input.ids
  );
}

export function draftBody(
  document: ProjectDocument,
  input: DraftInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'draft',
    {
      featureKind: 'draft',
      targetBodyId: input.targetBodyId,
      faceHashes: [...new Set(input.faceHashes)],
      ...(input.faceReferences
        ? { faceReferences: deepClone(input.faceReferences) }
        : {}),
      pullDirection: deepClone(input.pullDirection),
      neutralPoint: deepClone(input.neutralPoint),
      angleDeg: input.angleDeg
    },
    input.ids
  );
}

export function thickenFace(
  document: ProjectDocument,
  input: ThickenInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'thicken',
    {
      featureKind: 'thicken',
      targetBodyId: input.targetBodyId,
      faceHash: input.faceHash,
      ...(input.faceReference
        ? { faceReference: deepClone(input.faceReference) }
        : {}),
      thickness: input.thickness
    },
    input.ids
  );
}

export function filletEdges(
  document: ProjectDocument,
  input: EdgeModifierInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'fillet',
    {
      featureKind: 'fillet',
      targetBodyId: input.targetBodyId,
      edgeHashes: [...new Set(input.edgeHashes)],
      ...(input.edgeReferences
        ? { edgeReferences: deepClone(input.edgeReferences) }
        : {}),
      radius: input.size,
      ...(input.endRadius !== undefined
        ? {
            endRadius: input.endRadius,
            ...(input.radiusLaw !== undefined
              ? { radiusLaw: input.radiusLaw }
              : {})
          }
        : {})
    },
    input.ids
  );
}

export function chamferEdges(
  document: ProjectDocument,
  input: EdgeModifierInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'chamfer',
    {
      featureKind: 'chamfer',
      targetBodyId: input.targetBodyId,
      edgeHashes: [...new Set(input.edgeHashes)],
      ...(input.edgeReferences
        ? { edgeReferences: deepClone(input.edgeReferences) }
        : {}),
      distance: input.size,
      ...(input.angleDeg !== undefined ? { angleDeg: input.angleDeg } : {}),
      ...(input.distance2 !== undefined ? { distance2: input.distance2 } : {})
    },
    input.ids
  );
}

export function patternBody(
  document: ProjectDocument,
  input: PatternInput
): { document: ProjectDocument; bodyId: BodyId } {
  return addBodyResultFeature(
    document,
    input.name,
    'pattern',
    {
      featureKind: 'pattern',
      targetBodyId: input.targetBodyId,
      patternKind: input.patternKind,
      count: input.count,
      axis: input.axis,
      spacing: input.spacing ?? 10,
      angleDeg: input.angleDeg ?? 360,
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.axis2 ? { axis2: input.axis2 } : {}),
      ...(input.spacing2 !== undefined ? { spacing2: input.spacing2 } : {}),
      ...(input.count2 !== undefined ? { count2: input.count2 } : {})
    },
    input.ids
  );
}

export function importMeshBody(
  document: ProjectDocument,
  input: ImportedMeshInput
): { document: ProjectDocument; bodyId: BodyId } {
  const embedded = input.vertices !== undefined && input.indices !== undefined;
  if (
    embedded === (input.meshPayloadRef !== undefined) ||
    (!embedded && (input.vertices ?? input.indices) !== undefined)
  ) {
    throw new Error(
      'A mesh import needs exactly one of vertices+indices and meshPayloadRef.'
    );
  }
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'imported-mesh',
    data: {
      featureKind: 'imported-mesh',
      artifactId: toArtifactId(input.artifactId),
      sourceName: input.sourceName,
      triangleCount: input.triangleCount,
      ...(input.meshPayloadRef
        ? { meshPayloadRef: { ...input.meshPayloadRef } }
        : { vertices: input.vertices!, indices: input.indices! })
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'mesh-reference',
    representationSource: 'mesh-import',
    exportableStep: true,
    metadata: { color: featureColor('imported-mesh') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

export function importStepBody(
  document: ProjectDocument,
  input: ImportedStepInput
): { document: ProjectDocument; bodyId: BodyId } {
  if ((input.stepText === undefined) === (input.stepSourceRef === undefined)) {
    throw new Error(
      'A STEP import needs exactly one of stepText and stepSourceRef.'
    );
  }
  const next = cloneDocument(document);
  const { featureId, featureNodeId, bodyId, bodyNodeId } =
    input.ids ?? createBodyFeatureIds();

  next.nodes[featureNodeId] = {
    id: featureNodeId,
    kind: 'feature',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    featureId,
    bodyId,
    featureKind: 'imported-step',
    data: {
      featureKind: 'imported-step',
      artifactId: toArtifactId(input.artifactId),
      sourceName: input.sourceName,
      ...(input.stepText !== undefined
        ? { stepText: input.stepText }
        : { stepSourceRef: input.stepSourceRef }),
      ...(input.solidIndices !== undefined
        ? { solidIndices: [...input.solidIndices] }
        : {}),
      ...(input.planarEmboss
        ? { planarEmboss: deepClone(input.planarEmboss) }
        : {})
    }
  };

  next.nodes[bodyNodeId] = {
    id: bodyNodeId,
    kind: 'body',
    name: input.name,
    parentId: next.activePartId,
    revisionId: null,
    bodyId,
    featureId,
    bodyType: 'solid',
    representationSource: 'step-import',
    exportableStep: true,
    metadata: { color: featureColor('imported-step') }
  };

  next.featureOrder.push(featureId);
  next.bodyOrder.push(bodyId);
  attachToPart(next, featureNodeId, bodyNodeId);
  next.version += 1;
  return { document: next, bodyId };
}

/**
 * Atomically imports the exact STEP witness and its sanitized Shapr migration
 * evidence. Candidate operations stay non-operative until a later adapter can
 * prove units, operands, coordinate frames, and topology correspondence.
 */
export function importShaprGuided(
  document: ProjectDocument,
  input: ShaprGuidedImportInput
): { document: ProjectDocument; bodyId: BodyId; importId: ShaprImportId } {
  if (!input.step.ids) {
    throw new Error('A guided SHAPR import requires deterministic STEP ids.');
  }
  const importId = input.importId ?? toShaprImportId(createId('shapr'));
  if (document.shaprImports[importId]) {
    throw new Error(`SHAPR import ${importId} already exists.`);
  }
  const imported = importStepBody(document, input.step);
  imported.document.shaprImports[importId] = {
    ...deepClone(input.migration),
    importId,
    exactGeometry: {
      featureId: input.step.ids.featureId,
      bodyId: input.step.ids.bodyId,
      stepChecksumSha256: input.migration.companionStepChecksumSha256,
      validation: 'exact-kernel-preflight'
    }
  };
  imported.document.shaprImportOrder.push(importId);
  return { document: imported.document, bodyId: imported.bodyId, importId };
}

// ---------------------------------------------------------------------------
// Parameters.
// ---------------------------------------------------------------------------

export const PARAMETER_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isValidParameterName(name: string): boolean {
  return PARAMETER_NAME_PATTERN.test(name) && !RESERVED_IDENTIFIERS.has(name);
}

export function listParameters(document: ProjectDocument): ParameterNode[] {
  const parameters = listNodesByKind(document, 'parameter');
  const byId = new Map(
    parameters.map((parameter) => [parameter.parameterId, parameter])
  );
  const ordered: ParameterNode[] = [];
  const seen = new Set<ParameterId>();
  for (const parameterId of document.parameterOrder) {
    const parameter = byId.get(parameterId);
    if (parameter && !seen.has(parameterId)) {
      ordered.push(parameter);
      seen.add(parameterId);
    }
  }
  for (const parameter of parameters) {
    if (!seen.has(parameter.parameterId)) {
      ordered.push(parameter);
    }
  }
  return ordered;
}

export function setParameter(
  document: ProjectDocument,
  input: ParameterSetInput
): ProjectDocument {
  const name = input.name.trim();
  if (!isValidParameterName(name)) {
    throw new Error(
      `"${name}" is not a valid parameter name (letters, digits, underscore; must not be a built-in).`
    );
  }
  if (input.expression.trim().length === 0) {
    throw new Error('Parameter expression must not be empty.');
  }
  const next = cloneDocument(document);
  const parameters = listParameters(next);
  const existing = parameters.find((parameter) => parameter.name === name);
  if (existing) {
    if (input.addOnly) {
      throw new Error(
        `${name} already exists. Change it in the Parameters panel.`
      );
    }
    if (existing.toggle && !['0', '1'].includes(input.expression.trim())) {
      throw new Error('An on/off parameter must be 0 (off) or 1 (on).');
    }
    existing.expression = input.expression;
    if (
      input.quantity !== undefined &&
      (input.quantity ?? undefined) !== existing.quantity
    ) {
      const refusal = parameterQuantityRefusal(next, name, input.quantity);
      if (refusal) throw new Error(refusal);
      if (input.quantity) existing.quantity = input.quantity;
      else delete existing.quantity;
    }
  } else {
    const { parameterId, parameterNodeId } = input.ids ?? createParameterIds();
    next.nodes[parameterNodeId] = {
      id: parameterNodeId,
      kind: 'parameter',
      name,
      parentId: next.rootNodeId,
      revisionId: null,
      parameterId,
      expression: input.expression,
      value: 0,
      ...(input.quantity ? { quantity: input.quantity } : {}),
      // Once the owner has curated Tweak, a newly-created parameter stays out
      // of that public surface until its own eye is explicitly enabled.
      ...(parameters.some((parameter) => parameter.exposed !== undefined)
        ? { exposed: false }
        : {})
    };
    next.parameterOrder.push(parameterId);
  }
  // A typed parameter's own expression must hold its quantity: a length
  // that evaluates to an angle is refused here rather than stored broken.
  const typed = listParameters(next).find((entry) => entry.name === name);
  if (typed?.quantity) {
    const mismatch = getParameterScope(next).errors.find((error) =>
      error.startsWith(`Parameter "${name}": Incompatible dimensions`)
    );
    if (mismatch) throw new Error(mismatch);
  }
  refreshParameterValues(next);
  next.version += 1;
  return next;
}

/** Configure an on/off control separately from scalar edits: Tweak may turn
 * an existing switch, but only Build may create it or change its body binding. */
export function configureParameterToggle(
  document: ProjectDocument,
  input: ParameterToggleInput
): ProjectDocument {
  const name = input.name.trim();
  const existing = listParameters(document).find((p) => p.name === name);
  if (existing && !existing.toggle) {
    throw new Error(`A numeric parameter named "${name}" already exists.`);
  }
  const bodyIds = [...new Set(input.bodyIds)];
  for (const bodyId of bodyIds) {
    if (!findBodyNode(document, bodyId)) {
      throw new Error(`Body "${bodyId}" does not exist.`);
    }
    if (document.derived.bodyRepresentations[bodyId]?.consumed) {
      throw new Error(
        'Choose a separate result body, not a consumed source body.'
      );
    }
    const owner = listParameters(document).find(
      (p) => p.name !== name && p.toggle?.bodyIds.includes(bodyId)
    );
    if (owner)
      throw new Error(`This body is already controlled by "${owner.name}".`);
  }
  const next = existing
    ? cloneDocument(document)
    : setParameter(document, { name, expression: '1', ids: input.ids });
  listParameters(next).find((p) => p.name === name)!.toggle = { bodyIds };
  if (existing) next.version += 1;
  return next;
}

/** Canonical visibility, independent of the local eye/isolate view settings.
 * Invalid imported toggle values fail closed rather than exporting a body
 * whose switch does not have a defined state. */
export function getParameterHiddenBodyIds(
  document: ProjectDocument
): Set<BodyId> {
  const hidden = new Set<BodyId>();
  for (const parameter of listParameters(document)) {
    if (parameter.toggle && parameter.expression.trim() !== '1') {
      for (const bodyId of parameter.toggle.bodyIds) hidden.add(bodyId);
    }
  }
  return hidden;
}

export function deleteParameter(
  document: ProjectDocument,
  input: ParameterDeleteInput
): ProjectDocument {
  const next = cloneDocument(document);
  const parameter = listParameters(next).find(
    (entry) => entry.name === input.name
  );
  if (!parameter) {
    throw new Error(`Parameter "${input.name}" not found.`);
  }
  delete next.nodes[parameter.id];
  next.parameterOrder = next.parameterOrder.filter(
    (id) => id !== parameter.parameterId
  );
  refreshParameterValues(next);
  next.version += 1;
  return next;
}

/**
 * Renames a parameter and rewrites every stored expression that reads it, in
 * one step, so no reader is ever stranded on the old name.
 *
 * Only authored expression fields are rewritten. Literal text, enums, ids
 * and topology witnesses never become readers just because they happen to
 * match a parameter name. A typo in another identifier does not prevent a
 * known expression field from retaining its reference through the rename.
 */
export function renameParameter(
  document: ProjectDocument,
  input: ParameterRenameInput
): ProjectDocument {
  const newName = input.newName.trim();
  if (!isValidParameterName(newName)) {
    throw new Error(
      `"${newName}" is not a valid parameter name (letters, digits, underscore; must not be a built-in).`
    );
  }
  const next = cloneDocument(document);
  const parameter = listParameters(next).find(
    (entry) => entry.name === input.name
  );
  if (!parameter) {
    throw new Error(`Parameter "${input.name}" not found.`);
  }
  if (newName !== input.name) {
    const collision = listParameters(next).find(
      (entry) => entry.name === newName
    );
    if (collision) {
      throw new Error(`A parameter named "${newName}" already exists.`);
    }
  }
  const rewrite = (candidate: string): string =>
    expressionIdentifiers(candidate).includes(input.name)
      ? renameIdentifierInExpression(candidate, input.name, newName)
      : candidate;
  for (const node of Object.values(next.nodes)) {
    if (node.kind !== 'parameter' || node.name !== input.name) {
      rewriteNodeExpressions(node, rewrite);
    }
  }
  parameter.name = newName;
  refreshParameterValues(next);
  next.version += 1;
  return next;
}

/**
 * Chooses whether a parameter is offered in Tweak mode and through a share
 * link. Deliberately its own command rather than a field on `setParameter`:
 * Tweak mode admits `parameter.set` so a visitor can turn the published
 * knobs, and folding curation into that command would let the same visitor
 * publish knobs the owner never offered.
 */
export function setParameterExposed(
  document: ProjectDocument,
  input: ParameterExposeInput
): ProjectDocument {
  const next = cloneDocument(document);
  const parameters = listParameters(next);
  const parameter = parameters.find(
    (candidate) => candidate.name === input.name
  );
  if (!parameter) {
    throw new Error(`Parameter "${input.name}" does not exist.`);
  }

  // Legacy and never-curated documents omit this field. Materialize their
  // current effective state before changing one row so toggling an eye never
  // changes the exposure of its neighbours as a side effect.
  if (parameters.some((candidate) => candidate.exposed === undefined)) {
    const currentlyExposed = new Set(
      listExposedParameters(next).map((candidate) => candidate.parameterId)
    );
    for (const candidate of parameters) {
      candidate.exposed = currentlyExposed.has(candidate.parameterId);
    }
  }
  parameter.exposed = input.exposed;
  next.version += 1;
  return next;
}

/**
 * Sets the gloss shown beside a parameter in Tweak mode and share links.
 *
 * Its own command for the same reason curation is: Tweak admits
 * `parameter.set` so a visitor can turn the published knobs, and a visitor
 * must not be able to rewrite what the owner said those knobs mean. Blank
 * clears it rather than storing an empty string, so "no description" has one
 * representation.
 */
export function setParameterDescription(
  document: ProjectDocument,
  input: ParameterDescribeInput
): ProjectDocument {
  const next = cloneDocument(document);
  const parameter = listParameters(next).find(
    (candidate) => candidate.name === input.name
  );
  if (!parameter) {
    throw new Error(`Parameter "${input.name}" does not exist.`);
  }
  const description = input.description.trim();
  if (description.length > 0) {
    parameter.description = description;
  } else {
    delete parameter.description;
  }
  next.version += 1;
  return next;
}

/**
 * The parameters a Tweak-mode workspace offers, in `parameterOrder`.
 *
 * An uncurated document offers every parameter for backwards compatibility.
 * Explicit `true` values are an older curated allow-list. A false-only legacy
 * state came from the previously inert eye toggle, so it hides those rows and
 * keeps still-absent neighbours visible. The next curation command normalizes
 * every row to an explicit boolean.
 */
export function listExposedParameters(
  document: ProjectDocument
): ParameterNode[] {
  const parameters = listParameters(document);
  const exposed = parameters.filter((parameter) => parameter.exposed === true);
  if (exposed.length > 0) return exposed;
  if (parameters.some((parameter) => parameter.exposed === false)) {
    return parameters.filter((parameter) => parameter.exposed !== false);
  }
  return parameters;
}

export interface ParameterScopeResult {
  /** Successfully evaluated parameter values by name. */
  scope: Record<string, number>;
  /** Human-readable evaluation failures, one per broken parameter. */
  errors: string[];
}

/**
 * Evaluates one parameter's expression against `scope`, checking a typed
 * parameter (F05) against its own quantity: a length parameter may not
 * evaluate to an angle or an area, a number may not carry units. A unitless
 * parameter evaluates exactly as before v21.
 */
function evaluateParameter(
  parameter: ParameterNode,
  scope: Record<string, number>,
  documentUnits: UnitSystem
): number {
  if (!parameter.quantity) {
    return evaluateExpression(parameter.expression, scope, { documentUnits });
  }
  const result = parseExpressionQuantity(
    parameter.expression,
    scope,
    documentUnits
  );
  if (!Number.isFinite(result.value)) {
    throw new Error('Expression did not evaluate to a finite number.');
  }
  requireFieldDimension(result, parameter.quantity);
  return result.value;
}

/**
 * The reference cycles among the still-unresolved parameters, found in one
 * iterative pass (Tarjan's strongly connected components), so a long chain of
 * broken parameters costs linear time and no recursion depth. Each parameter
 * on a cycle maps to a path that names it (`a → b → a`); a large component is
 * named by its members rather than walked parameter by parameter.
 */
function parameterCycles(
  pending: ReadonlyMap<string, ParameterNode>
): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const [name, parameter] of pending) {
    edges.set(
      name,
      expressionIdentifiers(parameter.expression).filter((next) =>
        pending.has(next)
      )
    );
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: number }> = [
      { node: root, next: 0 }
    ];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const out = edges.get(frame.node)!;
      if (frame.next < out.length) {
        const next = out[frame.next]!;
        frame.next += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, next: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(next)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(
          parent.node,
          Math.min(low.get(parent.node)!, low.get(frame.node)!)
        );
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }
  const cycles = new Map<string, string[]>();
  for (const component of components) {
    const members = new Set(component);
    const selfLoop =
      component.length === 1 &&
      edges.get(component[0]!)!.includes(component[0]!);
    if (component.length === 1 && !selfLoop) continue;
    for (const name of component) {
      cycles.set(
        name,
        component.length <= 32
          ? shortestCycle(name, edges, members)
          : [name, '…', name]
      );
    }
  }
  return cycles;
}

/** The shortest path from `name` back to itself inside one small component. */
function shortestCycle(
  name: string,
  edges: ReadonlyMap<string, readonly string[]>,
  members: ReadonlySet<string>
): string[] {
  const previous = new Map<string, string>();
  const queue = [name];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    for (const next of edges.get(current) ?? []) {
      if (!members.has(next)) continue;
      if (next === name) {
        const path = [name];
        for (let step = current; step !== name; step = previous.get(step)!) {
          path.push(step);
        }
        return [name, ...path.slice(1).reverse(), name];
      }
      if (!previous.has(next) && next !== name) {
        previous.set(next, current);
        queue.push(next);
      }
    }
  }
  return [name, name];
}

/**
 * Evaluates the whole parameter table. Parameters may reference each other in
 * any declaration order; evaluation iterates until a fixed point, so cycles
 * and unknown identifiers surface as per-parameter errors instead of crashes.
 * A cycle is named as one (`a → b → a`) rather than as the unknown
 * identifier it looks like from inside. The scope carries each typed
 * parameter's quantity (see {@link withParameterKinds}).
 */
export function getParameterScope(
  document: ProjectDocument
): ParameterScopeResult {
  const parameters = listParameters(document);
  const kinds: Record<string, ParameterKind> = {};
  for (const parameter of parameters) {
    if (parameter.quantity) kinds[parameter.name] = parameter.quantity;
  }
  const scope = withParameterKinds({}, kinds);
  const pending = new Map(
    parameters.map((parameter) => [parameter.name, parameter])
  );
  const errors: string[] = [];

  let progressed = true;
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const [name, parameter] of [...pending]) {
      try {
        scope[name] = evaluateParameter(parameter, scope, document.units);
        pending.delete(name);
        progressed = true;
      } catch {
        // Possibly depends on a parameter not yet evaluated; retry next pass.
      }
    }
  }

  const cycles = parameterCycles(pending);
  for (const [name, parameter] of pending) {
    const cycle = cycles.get(name);
    if (cycle) {
      errors.push(
        `Parameter "${name}": its expression refers back to itself (${cycle.join(' → ')}).`
      );
      continue;
    }
    try {
      evaluateParameter(parameter, scope, document.units);
    } catch (error) {
      errors.push(
        `Parameter "${name}": ${error instanceof Error ? error.message : 'evaluation failed.'}`
      );
    }
  }
  return { scope, errors };
}

/** Recomputes the cached `value` field of every parameter node. */
function refreshParameterValues(document: ProjectDocument): void {
  const { scope } = getParameterScope(document);
  for (const parameter of listParameters(document)) {
    const value = scope[parameter.name];
    if (value !== undefined) {
      parameter.value = value;
    }
  }
}

/**
 * Resolves a parametric scalar to a number: literals pass through, strings
 * are evaluated against the parameter scope. Throws with a labelled message
 * on failure so the kernel can attribute errors to a feature input.
 * Length-suffixed quantities convert into `documentUnits`; a caller that
 * does not pass them refuses a length suffix rather than guessing a unit,
 * so every legacy call keeps its meaning and no call site can silently
 * read `5 mm` in an inch document as millimetres.
 */
export function resolveParamValue(
  value: ParamValue,
  scope: Record<string, number>,
  label?: string,
  documentUnits?: UnitSystem
): number {
  try {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error('value is not finite.');
      }
      return value;
    }
    return evaluateExpression(value, scope, { documentUnits });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'evaluation failed.';
    throw new Error(label ? `${label}: ${reason}` : reason, { cause: error });
  }
}

/** Normalizes raw form input: plain numerics become numbers, otherwise the expression string is kept. */
export function coerceParamValue(raw: string): ParamValue {
  const trimmed = raw.trim();
  const numeric = Number(trimmed);
  return trimmed.length > 0 && Number.isFinite(numeric) ? numeric : trimmed;
}

// ---------------------------------------------------------------------------
// Feature editing.
// ---------------------------------------------------------------------------

/**
 * Keys a data patch may write, per feature kind — exactly the fields of the
 * corresponding `FeatureData` variant. `featureKind` itself is handled (and
 * rejected on change) separately. Anything else is a payload bug: an
 * unrecognized key written here would persist in the document and replay
 * forever, so it is rejected instead.
 */
const FEATURE_DATA_KEYS: Record<FeatureKind, readonly string[]> = {
  primitive: ['primitiveKind', 'dimensions'],
  sketch: ['sketchId'],
  extrude: [
    'sketchId',
    'distance',
    'symmetric',
    'backDistance',
    'operation',
    'targetBodyId',
    'profile',
    'profiles',
    'endCondition',
    'throughAllSide'
  ],
  revolve: ['sketchId', 'axis', 'angleDeg'],
  loft: ['sections', 'mode', 'endPoint'],
  sweep: ['profile', 'path', 'mode', 'guide'],
  'helical-sweep': [
    'profile',
    'axisOrigin',
    'axisDirection',
    'radius',
    'pitch',
    'turns'
  ],
  boolean: ['operation', 'targetBodyIds'],
  transform: ['targetBodyId', 'transform'],
  mirror: ['targetBodyId', 'plane'],
  'datum-plane': ['definition'],
  // `secondBodyId` is body wiring, not a parameter: never patchable.
  split: ['targetBodyId', 'plane'],
  hole: [
    'targetBodyId',
    'faceHash',
    'faceReference',
    'style',
    'diameter',
    'depthMode',
    'depth',
    'counterboreDiameter',
    'counterboreDepth',
    'countersinkDiameter',
    'countersinkAngleDeg',
    'position'
  ],
  shell: [
    'targetBodyId',
    'openingFaceHashes',
    'openingFaceReferences',
    'thickness'
  ],
  'solid-offset': ['targetBodyId', 'distance'],
  draft: [
    'targetBodyId',
    'faceHashes',
    'faceReferences',
    'pullDirection',
    'neutralPoint',
    'angleDeg'
  ],
  thicken: ['targetBodyId', 'faceHash', 'faceReference', 'thickness'],
  fillet: [
    'targetBodyId',
    'edgeHashes',
    'edgeReferences',
    'radius',
    'endRadius',
    'radiusLaw'
  ],
  chamfer: [
    'targetBodyId',
    'edgeHashes',
    'edgeReferences',
    'distance',
    'angleDeg',
    'distance2'
  ],
  pattern: [
    'targetBodyId',
    'patternKind',
    'count',
    'axis',
    'spacing',
    'angleDeg',
    'direction',
    'axis2',
    'spacing2',
    'count2'
  ],
  'direct-edit': ['targetBodyId', 'operation'],
  'imported-step': [
    'artifactId',
    'sourceName',
    'stepText',
    'stepSourceRef',
    'solidIndices',
    'planarEmboss'
  ],
  'imported-mesh': [
    'artifactId',
    'sourceName',
    'triangleCount',
    'vertices',
    'indices',
    'meshPayloadRef'
  ]
};

/**
 * Keys `FeatureUpdateInput.clearData` may remove, per feature kind.
 *
 * Every entry is an optional field whose absence is a distinct, buildable
 * state — a loft with no apex point, a sweep with no guide rail, a fillet
 * with no end radius — never one a builder reads unconditionally. Kinds with
 * no clearable field are simply absent, so naming a key on one of those is
 * rejected the same way an unknown key is.
 */
const FEATURE_DATA_CLEARABLE_KEYS: Partial<
  Record<FeatureKind, readonly string[]>
> = {
  extrude: ['endCondition', 'throughAllSide'],
  loft: ['endPoint'],
  sweep: ['guide'],
  fillet: ['endRadius', 'radiusLaw'],
  chamfer: ['angleDeg', 'distance2']
};

export function updateFeature(
  document: ProjectDocument,
  input: FeatureUpdateInput
): ProjectDocument {
  const next = cloneDocument(document);
  const feature = findFeature(next, input.featureId);
  if (!feature) {
    throw new Error(`Feature ${input.featureId} not found.`);
  }
  if (input.name !== undefined && input.name.trim().length > 0) {
    feature.name = input.name.trim();
  }
  if (input.data) {
    const patch = { ...input.data } as Record<string, unknown>;
    if (
      'featureKind' in patch &&
      patch.featureKind !== undefined &&
      patch.featureKind !== feature.featureKind
    ) {
      throw new Error(
        'A feature cannot change kind; delete and recreate it instead.'
      );
    }
    delete patch.featureKind;

    const allowedKeys = FEATURE_DATA_KEYS[feature.data.featureKind];
    const data = feature.data as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        continue;
      }
      if (!allowedKeys.includes(key)) {
        throw new Error(
          `Feature data key "${key}" is not valid for a ${feature.data.featureKind} feature.`
        );
      }
      if (key === 'dimensions' && feature.data.featureKind === 'primitive') {
        feature.data.dimensions = {
          ...feature.data.dimensions,
          ...(value as Record<string, ParamValue>)
        };
      } else {
        data[key] = value;
      }
    }
  }
  if (input.clearData?.length) {
    const clearableKeys =
      FEATURE_DATA_CLEARABLE_KEYS[feature.data.featureKind] ?? [];
    const data = feature.data as unknown as Record<string, unknown>;
    for (const key of input.clearData) {
      if (!clearableKeys.includes(key)) {
        throw new Error(
          `Feature data key "${key}" cannot be cleared on a ${feature.data.featureKind} feature.`
        );
      }
      delete data[key];
    }
  }
  if (feature.data.featureKind === 'extrude') {
    validateExtrudeExtent(feature.data);
  }
  // R01: a datum may only read earlier datums, and Mirror/Split only an
  // existing earlier one, whichever path edited them.
  if (feature.data.featureKind === 'datum-plane') {
    validateDatumPlaneDefinition(
      next,
      feature.data.definition,
      feature.featureId
    );
  } else if (
    feature.data.featureKind === 'mirror' ||
    feature.data.featureKind === 'split'
  ) {
    validateModelingPlane(next, feature.data.plane, feature.featureId);
  }
  // New Body has no dependency on the previous Add/Cut target. Undefined
  // patch values are normally ignored, so clear this semantic dependency here.
  if (
    feature.data.featureKind === 'extrude' &&
    input.data &&
    'operation' in input.data &&
    input.data.operation === 'new-body'
  ) {
    delete feature.data.targetBodyId;
  }
  // A fillet or chamfer whose edge set changes cannot keep references that
  // only covered the previous set: the commit refuses a partial list, and a
  // hash-only selection resolves by fingerprint until the lineage proves a
  // fresh list. Clear them unless the patch supplies the matching list.
  if (
    (feature.data.featureKind === 'fillet' ||
      feature.data.featureKind === 'chamfer') &&
    input.data &&
    'edgeHashes' in input.data &&
    input.data.edgeHashes !== undefined &&
    input.data.edgeReferences === undefined
  ) {
    delete feature.data.edgeReferences;
  }
  next.version += 1;
  return next;
}

/** Direct-edit kinds whose source pins a re-picked face can fully refresh. */
export type RepairableDirectEditKind =
  'offset-face' | 'resize-cylindrical-face' | 'resize-through-hole';

const REPAIRABLE_DIRECT_EDIT_KINDS: readonly RepairableDirectEditKind[] = [
  'offset-face',
  'resize-cylindrical-face',
  'resize-through-hole'
];

/** A broken direct edit the user can fix by picking its face again. */
export interface StaleDirectEditFaceRepair {
  featureId: FeatureId;
  featureName: string;
  targetBodyId: BodyId;
  operationKind: RepairableDirectEditKind;
}

/**
 * Adapter warnings that mean the stored face IDENTITY failed to resolve —
 * the class of failure a re-pick fixes. Post-resolution failures (an edit
 * whose boolean produced an invalid solid, say) are deliberately excluded:
 * those are about the edit's own geometry, not about which face it names.
 */
const STALE_FACE_WARNINGS: readonly RegExp[] = [
  /^Direct-edit face is stale/,
  /^A selected face no longer exists/,
  /^A selected face is geometrically ambiguous/,
  /^A selected face was saved by an older version of OpenZCAD/,
  /^The selected face no longer matches its recorded/
];

/**
 * Detects a direct-edit feature whose stored face selection went stale.
 *
 * A direct edit pins its face by geometric fingerprint (plus a v5 lineage
 * reference when the producer publishes one). An upstream parametric edit
 * changes the face's geometry, so a hash-only pin stops resolving and the
 * fail-soft replay skips the edit behind one warning — the model quietly
 * loses the feature and nothing in the document can bring it back short of
 * recreating it. This match is the entry to the repair path: the feature
 * must be a direct edit of a repairable kind AND carry a rebuild warning
 * that names a face-identity failure.
 *
 * `warnings` are the derived rebuild warnings, in the adapter's
 * `Feature "name": reason` convention.
 */
export function staleDirectEditFaceRepair(
  feature: FeatureNode,
  warnings: readonly string[]
): StaleDirectEditFaceRepair | null {
  if (feature.data.featureKind !== 'direct-edit') {
    return null;
  }
  const kind = feature.data.operation.kind;
  if (!(REPAIRABLE_DIRECT_EDIT_KINDS as readonly string[]).includes(kind)) {
    return null;
  }
  const prefix = `Feature "${feature.name}":`;
  const warning = warnings
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
  if (
    !warning ||
    !STALE_FACE_WARNINGS.some((pattern) => pattern.test(warning))
  ) {
    return null;
  }
  return {
    featureId: feature.featureId,
    featureName: feature.name,
    targetBodyId: feature.data.targetBodyId,
    operationKind: kind as RepairableDirectEditKind
  };
}

/** Minimal face-projection shape the repair reads; matches `FaceTopology`. */
export interface RepairFacePick {
  hash: number;
  reference?: FaceTopologyReferenceV5;
  geometry?: {
    surfaceType: string;
    area: number;
    center: { x: number; y: number; z: number };
    normal?: { x: number; y: number; z: number };
    radius?: number;
    diameter?: number;
    axisStart?: { x: number; y: number; z: number };
    axisEnd?: { x: number; y: number; z: number };
    featureType?: 'through-hole' | 'blend';
  };
}

/**
 * Rebuilds a stale direct-edit operation around a freshly picked face.
 *
 * The identity (hash + reference) and every source measurement pin are
 * refreshed from the picked face's CURRENT projection; only the edit's own
 * value fields (offset, radius, diameter) carry over. This is sound exactly
 * because repair runs while the feature is broken: the broken edit
 * contributed nothing to the rendered body, so what the user picks is a face
 * of the same state the feature will see at its replay position. (When a
 * downstream feature has since reshaped that face, the refreshed pins won't
 * match at replay either — the validated commit rebuild refuses the repair
 * instead of storing it, so the failure mode is a refusal, never a wrong
 * edit.)
 *
 * Throws with a user-facing reason when the picked face cannot carry the
 * operation, so callers can keep the pick armed and let the user try again.
 */
export function repairedDirectEditOperation(
  operation: DirectEditOperation,
  face: RepairFacePick
): DirectEditOperation {
  const geometry = face.geometry;
  const vec = (value: { x: number; y: number; z: number }) => ({
    x: value.x,
    y: value.y,
    z: value.z
  });
  const identity = {
    faceHash: face.hash,
    ...(face.reference ? { faceReference: deepClone(face.reference) } : {})
  };
  switch (operation.kind) {
    case 'offset-face': {
      if (
        geometry?.surfaceType !== 'plane' ||
        !geometry.normal ||
        !Number.isFinite(geometry.area) ||
        geometry.area <= 0
      ) {
        throw new Error(
          'Pick a planar face with exact measurements to repair this offset.'
        );
      }
      return {
        kind: 'offset-face',
        ...identity,
        sourceSurfaceType: 'plane',
        sourceArea: geometry.area,
        sourceCenter: vec(geometry.center),
        sourceNormal: vec(geometry.normal),
        offset: deepClone(operation.offset)
      };
    }
    case 'resize-cylindrical-face': {
      if (
        geometry?.surfaceType !== 'cylinder' ||
        geometry.radius === undefined ||
        !geometry.axisStart ||
        !geometry.axisEnd
      ) {
        throw new Error(
          'Pick a cylindrical face with exact measurements to repair this resize.'
        );
      }
      return {
        kind: 'resize-cylindrical-face',
        ...identity,
        sourceRadius: geometry.radius,
        sourceAxisStart: vec(geometry.axisStart),
        sourceAxisEnd: vec(geometry.axisEnd),
        concavity: operation.concavity,
        radius: deepClone(operation.radius)
      };
    }
    case 'resize-through-hole': {
      if (
        geometry?.surfaceType !== 'cylinder' ||
        geometry.featureType !== 'through-hole' ||
        geometry.diameter === undefined ||
        !geometry.axisStart ||
        !geometry.axisEnd
      ) {
        throw new Error('Pick a through-hole wall to repair this hole resize.');
      }
      return {
        kind: 'resize-through-hole',
        ...identity,
        sourceDiameter: geometry.diameter,
        sourceAxisStart: vec(geometry.axisStart),
        sourceAxisEnd: vec(geometry.axisEnd),
        diameter: deepClone(operation.diameter),
        ...(operation.parameterBinding ? { parameterBinding: true } : {})
      };
    }
    default:
      throw new Error(
        `A ${operation.kind} edit cannot be repaired by re-picking; delete and recreate it instead.`
      );
  }
}

export interface FeatureMoveInput {
  featureId: FeatureId;
  /** Target position in the RESOLVED feature order (0-based). */
  toIndex: number;
}

/**
 * Move a feature to a new position in the replay timeline.
 *
 * Operates on the resolved order (`listFeaturesInOrder`), so features a
 * partial `featureOrder` merely implies are materialized into an explicit
 * order by the move. Returns the document unchanged — same reference, no
 * version bump — when the move is a no-op: unknown feature, out-of-range
 * index, or the feature's current position.
 *
 * Order LEGALITY (a feature landing before a body it consumes exists) is
 * deliberately not checked here: document-core mutations are pure shape
 * edits, and the command layer validates dependencies before applying,
 * exactly as feature updates do.
 */
export function moveFeature(
  document: ProjectDocument,
  input: FeatureMoveInput
): ProjectDocument {
  const ordered = listFeaturesInOrder(document).map(
    (feature) => feature.featureId
  );
  const from = ordered.indexOf(input.featureId);
  if (
    from === -1 ||
    !Number.isInteger(input.toIndex) ||
    input.toIndex < 0 ||
    input.toIndex >= ordered.length ||
    input.toIndex === from
  ) {
    return document;
  }
  const next = cloneDocument(document);
  const reordered = [...ordered];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(input.toIndex, 0, moved!);
  next.featureOrder = reordered;
  next.version += 1;
  return next;
}

export function deleteFeature(
  document: ProjectDocument,
  input: FeatureDeleteInput
): ProjectDocument {
  const next = cloneDocument(document);
  const feature = findFeature(next, input.featureId);
  if (!feature) {
    throw new Error(`Feature ${input.featureId} not found.`);
  }
  if (feature.data.featureKind === 'datum-plane') {
    // No implicit cascade or detachment: a dependent keeps reading this id.
    const dependents = datumPlaneDependents(next, feature.featureId);
    if (dependents.length > 0) {
      throw new Error(
        `Cannot delete datum plane "${feature.name}": ${dependents.join(', ')} ${
          dependents.length === 1 ? 'uses' : 'use'
        } it. Delete those or move them to another plane first.`
      );
    }
  }

  const removedNodeIds = new Set<string>([feature.id]);

  for (const body of listNodesByKind(next, 'body')) {
    if (body.featureId === feature.featureId) {
      removedNodeIds.add(body.id);
      next.bodyOrder = next.bodyOrder.filter(
        (bodyId) => bodyId !== body.bodyId
      );
    }
  }

  if (feature.data.featureKind === 'sketch') {
    const sketchId = feature.data.sketchId;
    const sketch = findSketch(next, sketchId);
    if (sketch) {
      removedNodeIds.add(sketch.id);
      for (const objectId of sketch.objectIds) {
        removedNodeIds.add(objectId);
      }
    }
    next.sketchOrder = next.sketchOrder.filter((id) => id !== sketchId);
  }

  next.featureOrder = next.featureOrder.filter(
    (id) => id !== feature.featureId
  );
  const removedShaprImports = next.shaprImportOrder.filter(
    (importId) =>
      next.shaprImports[importId]?.exactGeometry.featureId === feature.featureId
  );
  for (const importId of removedShaprImports) {
    delete next.shaprImports[importId];
  }
  if (removedShaprImports.length > 0) {
    const removed = new Set(removedShaprImports);
    next.shaprImportOrder = next.shaprImportOrder.filter(
      (importId) => !removed.has(importId)
    );
  }
  for (const nodeId of removedNodeIds) {
    delete next.nodes[nodeId];
  }
  for (const node of Object.values(next.nodes)) {
    if (node.kind === 'part' || node.kind === 'assembly') {
      node.childIds = node.childIds.filter(
        (childId) => !removedNodeIds.has(childId)
      );
    }
  }
  next.version += 1;
  return next;
}

export function renameNode(
  document: ProjectDocument,
  input: NodeRenameInput
): ProjectDocument {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error('Name must not be empty.');
  }
  const next = cloneDocument(document);
  const node = next.nodes[input.nodeId];
  if (!node) {
    throw new Error(`Node ${input.nodeId} not found.`);
  }
  node.name = name;
  if (node.kind === 'project') {
    next.name = name;
  }
  next.version += 1;
  return next;
}

export interface NodeMetadataInput {
  nodeId: string;
  /** Keys set to `null` are removed; other keys are merged into the node. */
  metadata: Record<string, string | number | boolean | null>;
}

/** Merges metadata keys into an existing node (e.g. display color). */
export function setNodeMetadata(
  document: ProjectDocument,
  input: NodeMetadataInput
): ProjectDocument {
  const next = cloneDocument(document);
  const node = next.nodes[input.nodeId];
  if (!node) {
    throw new Error(`Node ${input.nodeId} not found.`);
  }
  const metadata: Record<string, string | number | boolean> = {
    ...node.metadata
  };
  for (const [key, value] of Object.entries(input.metadata)) {
    if (value === null) {
      delete metadata[key];
    } else {
      metadata[key] = value;
    }
  }
  node.metadata = metadata;
  next.version += 1;
  return next;
}

function boundedHistoryReason(reason: string): string {
  return reason.length > MAX_CHECKPOINT_REASON_LENGTH
    ? `${reason.slice(0, MAX_CHECKPOINT_REASON_LENGTH - 1)}…`
    : reason;
}

export function appendRevision(
  document: ProjectDocument,
  reason: string
): ProjectDocument {
  // Clamped because the label is user text: command labels interpolate names
  // (`Edit ${value.name}`, `Rename to ${payload.name}`), and a long enough one
  // pushed the revision past the 500-character bound the account enforces on
  // every write. The rejection is a 400 that no retry can fix, the client maps
  // an unrecognised failure to `offline`, and so a permanently unsaveable
  // document presented as a network problem — while `normalizeDocument` quietly
  // dropped the offending revision on reload, taking that save point with it.
  // Shallow copy is sufficient: only `revisions` and `version` change, and the
  // shared sub-objects are never mutated in place (see module invariant).
  return {
    ...document,
    // Trimming the oldest keeps the array bounded; consumers only read the
    // newest entries and the count, never a trimmed record.
    revisions: [
      ...document.revisions,
      {
        revisionId: toRevisionId(createId('rev')),
        createdAt: nowIso(),
        reason: boundedHistoryReason(reason),
        commandCount: document.commandLog.length
      }
    ].slice(-MAX_PROJECT_REVISION_RECORDS),
    version: document.version + 1
  };
}

/** A persisted save owns a fresh revision ID; model version and undo stay unchanged. */
export function createSavedRevision(
  document: ProjectDocument,
  reason: string
): ProjectDocument {
  const appended = appendRevision(document, reason);
  return createCheckpoint({ ...appended, version: document.version }, reason);
}

/**
 * `live` carrying the save points an account echo minted that it lacks.
 *
 * An account Save checkpoints the document it was sent. When edits land while
 * that request is in flight, `live` is the document to keep — adopting the
 * echo would erase them — but it has to take the new save point along, or the
 * next fenced autosave replaces the account copy and the named save vanishes
 * from both. The echo's revisions go first, so the newest revision still names
 * the newest model: the edits' own revisions follow the one the save minted.
 */
export function withEchoedSavePoints(
  live: ProjectDocument,
  echo: ProjectDocument
): ProjectDocument {
  const revisionIds = new Set(
    echo.revisions.map((revision) => revision.revisionId)
  );
  const checkpointIds = new Set(
    echo.checkpoints.map((checkpoint) => checkpoint.checkpointId)
  );
  return {
    ...live,
    revisions: [
      ...echo.revisions,
      ...live.revisions.filter(
        (revision) => !revisionIds.has(revision.revisionId)
      )
    ].slice(-MAX_PROJECT_REVISION_RECORDS),
    checkpoints: [
      ...echo.checkpoints,
      ...live.checkpoints.filter(
        (checkpoint) => !checkpointIds.has(checkpoint.checkpointId)
      )
    ].slice(-MAX_PROJECT_CHECKPOINTS)
  };
}

/**
 * The save point a user's Save makes. A checkpoint names a revision, and a
 * document can arrive with none — a conflict recovery copy is born that way —
 * so where there is nothing to name, the save mints the revision first instead
 * of refusing. That refusal used to surface as "Cannot create a checkpoint
 * without a revision. Saved on this device." on every save of such a project,
 * including Save to my account, which never reached the account at all.
 */
export function createSavePoint(
  document: ProjectDocument,
  reason: string
): ProjectDocument {
  return document.revisions.length === 0
    ? createSavedRevision(document, reason)
    : createCheckpoint(document, reason);
}

/** Records a durable save point without changing model or undo semantics. */
export function createCheckpoint(
  document: ProjectDocument,
  reason: string
): ProjectDocument {
  const latestRevision = document.revisions.at(-1);
  if (!latestRevision) {
    throw new Error('Cannot create a checkpoint without a revision.');
  }
  const normalizedReason = boundedHistoryReason(reason.trim() || 'Saved');
  const previous = document.checkpoints.at(-1);
  if (
    previous?.documentVersion === document.version &&
    previous.revisionId === latestRevision.revisionId &&
    previous.reason === normalizedReason
  ) {
    return document;
  }
  return {
    ...document,
    checkpoints: [
      ...document.checkpoints,
      {
        checkpointId: createId('checkpoint'),
        revisionId: latestRevision.revisionId,
        documentVersion: document.version,
        createdAt: nowIso(),
        reason: normalizedReason
      }
    ].slice(-MAX_PROJECT_CHECKPOINTS)
  };
}

export function attachDerivedState(
  document: ProjectDocument,
  derived: ProjectDocument['derived']
): ProjectDocument {
  // Derived state is a disposable projection; attaching it intentionally does
  // not bump `version`, so consumers can tell model edits from re-derivation.
  // Reference repairs and warning attribution are both advice to the session
  // that computed them; stripping them here keeps stale lists out of saved and
  // replayed documents.
  const {
    referenceRepairs: _referenceRepairs,
    faceReferenceRepairs: _faceReferenceRepairs,
    featureWarnings: _featureWarnings,
    ...persisted
  } = derived;
  return { ...document, derived: persisted };
}

export function getLatestSketchId(
  document: ProjectDocument
): SketchId | undefined {
  return document.sketchOrder.at(-1);
}

export function getLatestBodyId(document: ProjectDocument): BodyId | undefined {
  return document.bodyOrder.at(-1);
}

// ---------------------------------------------------------------------------
// Expression evaluation.
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;

/**
 * F05: the kinds of a scope's typed parameters, carried on the scope object
 * itself under a non-enumerable symbol key. Every consumer keeps passing the
 * same `Record<string, number>`, and keys, JSON and deep equality never see
 * it. A copy must carry it on explicitly:
 * `withParameterKinds({ ...scope }, parameterKindsOf(scope))`.
 */
const PARAMETER_KINDS = Symbol.for('openzcad.parameterKinds');
type KindedScope = Record<string, number> & {
  [PARAMETER_KINDS]?: Readonly<Record<string, ParameterKind>>;
};

/** Marks `scope`'s typed parameters with their kinds; returns `scope`. */
export function withParameterKinds(
  scope: Record<string, number>,
  kinds: Readonly<Record<string, ParameterKind>>
): Record<string, number> {
  Object.defineProperty(scope, PARAMETER_KINDS, {
    value: kinds,
    enumerable: false,
    configurable: true,
    writable: true
  });
  return scope;
}

/** The kinds a scope carries for its typed parameters (none: all unitless). */
export function parameterKindsOf(
  scope: Record<string, number>
): Readonly<Record<string, ParameterKind>> {
  return (scope as KindedScope)[PARAMETER_KINDS] ?? {};
}

/**
 * A value moving through the expression parser: a plain number plus integer
 * exponents of length and angle. Plain numbers, scope parameters and `pi`
 * are dimensionless; unit suffixes introduce length (`mm`, `cm`, `m`,
 * `in`/`inch`, `ft`/`foot`/`feet`, `'`/`"` and their long/plural spellings)
 * or angle (`deg`, `rad` and their long/plural spellings). Dimensions exist
 * only to refuse incoherent arithmetic through the evaluator's usual thrown
 * errors — the public result is always a plain number in document units
 * (angles in degrees, matching every `angleDeg` field in the app).
 */
interface ExpressionQuantity {
  value: number;
  length: number;
  angle: number;
}

const quantity = (
  value: number,
  length = 0,
  angle = 0
): ExpressionQuantity => ({ value, length, angle });

/** Human-readable dimension for refusal messages. */
function describeDimension(value: ExpressionQuantity): string {
  if (value.length === 0 && value.angle === 0) return 'number';
  if (value.length === 1 && value.angle === 0) return 'length';
  if (value.length === 2 && value.angle === 0) return 'area';
  if (value.length === 0 && value.angle === 1) return 'angle';
  const parts: string[] = [];
  if (value.length !== 0) parts.push(`length^${value.length}`);
  if (value.angle !== 0) parts.push(`angle^${value.angle}`);
  return parts.join(' * ');
}

/**
 * Refuses incoherent arithmetic on the evaluator's existing thrown-error
 * path: `length ± angle`, `number ± length`, `length * angle`, dimensioned
 * exponents and the like. Inputs that evaluated successfully before
 * dimensions existed are all dimensionless, so they never reach this.
 */
function incompatibleDimensions(
  what: string,
  left: ExpressionQuantity,
  right?: ExpressionQuantity
): Error {
  const detail =
    right === undefined
      ? `${describeDimension(left)}.`
      : `${describeDimension(left)} and ${describeDimension(right)}.`;
  return new Error(`Incompatible dimensions in expression: ${what} ${detail}`);
}

/** Millimetres per length suffix (lowercase; lookup lowercases first). */
const EXPRESSION_LENGTH_UNITS: Record<string, number> = {
  mm: 1,
  millimeter: 1,
  millimetre: 1,
  millimeters: 1,
  millimetres: 1,
  cm: 10,
  centimeter: 10,
  centimetre: 10,
  centimeters: 10,
  centimetres: 10,
  m: 1000,
  meter: 1000,
  metre: 1000,
  meters: 1000,
  metres: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  ft: 304.8,
  foot: 304.8,
  feet: 304.8
};

/** Degrees per angle suffix (lowercase; lookup lowercases first). */
const EXPRESSION_ANGLE_UNITS: Record<string, number> = {
  deg: 1,
  degree: 1,
  degrees: 1,
  rad: 180 / Math.PI,
  radian: 180 / Math.PI,
  radians: 180 / Math.PI
};

/**
 * Whether an identifier token in unit position names a unit. Used both when
 * evaluating (`5 mm` is a quantity) and when renaming (`5 mm` keeps its
 * suffix while a bare `mm` parameter read is rewritten). Unit names are
 * deliberately NOT reserved parameter names, so a parameter called `m` still
 * resolves bare — only the number-adjacent suffix position reads as a unit.
 */
function isUnitSuffix(name: string): boolean {
  const suffix = name.toLowerCase();
  return suffix in EXPRESSION_LENGTH_UNITS || suffix in EXPRESSION_ANGLE_UNITS;
}

/** Trigonometry takes degrees — the conventional unit in CAD parameter tables. */
const EXPRESSION_FUNCTIONS: Record<
  string,
  {
    arity: 'unary' | 'binary' | 'variadic' | 'nullary';
    apply: (args: ExpressionQuantity[]) => ExpressionQuantity;
  }
> = {
  require_min: {
    arity: 'variadic',
    apply: (args) => {
      const [value, minimum] = args;
      if (
        args.length !== 2 ||
        !args.every((arg) => Number.isFinite(arg.value))
      ) {
        throw new Error('require_min needs a finite value and minimum.');
      }
      if (
        value!.length !== minimum!.length ||
        value!.angle !== minimum!.angle
      ) {
        throw incompatibleDimensions(
          'require_min needs matching dimensions',
          value!,
          minimum
        );
      }
      if (value!.value < minimum!.value) {
        throw new Error(
          `Parameter value ${value!.value} must be at least ${minimum!.value}.`
        );
      }
      return value!;
    }
  },
  require_one_of: {
    arity: 'variadic',
    apply: (args) => {
      const [value, ...supported] = args;
      if (
        supported.length === 0 ||
        !args.every((arg) => Number.isFinite(arg.value))
      ) {
        throw new Error(
          'require_one_of needs a finite value and at least one supported value.'
        );
      }
      for (const option of supported) {
        if (option.length !== value!.length || option.angle !== value!.angle) {
          throw incompatibleDimensions(
            'require_one_of needs matching dimensions',
            value!,
            option
          );
        }
      }
      if (!supported.some((option) => option.value === value!.value)) {
        throw new Error(
          `Parameter value ${value!.value} is unsupported; supported values: ${supported.map((option) => option.value).join(', ')}.`
        );
      }
      return value!;
    }
  },
  abs: {
    arity: 'unary',
    apply: ([a]) => quantity(Math.abs(a!.value), a!.length, a!.angle)
  },
  sqrt: {
    arity: 'unary',
    apply: ([a]) => {
      // Plain numbers keep the legacy path exactly (sqrt(-1) still fails on
      // the finite-result check); only even length powers narrow further.
      if (a!.angle !== 0 || a!.length % 2 !== 0) {
        throw incompatibleDimensions('cannot take the square root of', a!);
      }
      return quantity(Math.sqrt(a!.value), a!.length / 2, 0);
    }
  },
  floor: {
    arity: 'unary',
    apply: ([a]) => quantity(Math.floor(a!.value), a!.length, a!.angle)
  },
  ceil: {
    arity: 'unary',
    apply: ([a]) => quantity(Math.ceil(a!.value), a!.length, a!.angle)
  },
  round: {
    arity: 'unary',
    apply: ([a]) => quantity(Math.round(a!.value), a!.length, a!.angle)
  },
  sin: {
    arity: 'unary',
    apply: ([a]) => quantity(Math.sin(toDegrees('sin', a!)))
  },
  cos: {
    arity: 'unary',
    apply: ([a]) => quantity(Math.cos(toDegrees('cos', a!)))
  },
  tan: {
    arity: 'unary',
    apply: ([a]) => quantity(Math.tan(toDegrees('tan', a!)))
  },
  asin: {
    arity: 'unary',
    apply: ([a]) => quantity(degreesFromUnitInterval('asin', a!))
  },
  acos: {
    arity: 'unary',
    apply: ([a]) => quantity(degreesFromUnitInterval('acos', a!))
  },
  atan: {
    arity: 'unary',
    apply: ([a]) => {
      rejectDimensioned('atan', a!);
      return quantity(Math.atan(a!.value) / DEG_TO_RAD);
    }
  },
  atan2: {
    arity: 'binary',
    apply: ([y, x]) => {
      if (y!.length !== x!.length || y!.angle !== x!.angle) {
        throw incompatibleDimensions(
          'atan2() needs both coordinates with matching dimensions',
          y!,
          x
        );
      }
      return quantity(Math.atan2(y!.value, x!.value) / DEG_TO_RAD);
    }
  },
  mod: {
    arity: 'binary',
    apply: ([a, b]) => {
      if (a!.length !== b!.length || a!.angle !== b!.angle) {
        throw incompatibleDimensions('mod() needs matching dimensions', a!, b);
      }
      if (b!.value === 0) {
        throw new Error('mod() divisor must not be zero.');
      }
      // Floored (sign-of-divisor) remainder, so negative dividends wrap
      // instead of going negative the way a truncated remainder would.
      return quantity(
        a!.value - b!.value * Math.floor(a!.value / b!.value),
        a!.length,
        a!.angle
      );
    }
  },
  avg: {
    arity: 'variadic',
    apply: (args) => {
      if (args.length === 0) {
        throw new Error('avg() expects at least one argument.');
      }
      const [first, ...rest] = args;
      for (const other of rest) {
        if (other.length !== first!.length || other.angle !== first!.angle) {
          throw incompatibleDimensions(
            'avg() needs matching dimensions',
            first!,
            other
          );
        }
      }
      const total = args.reduce((sum, arg) => sum + arg.value, 0);
      return quantity(total / args.length, first!.length, first!.angle);
    }
  },
  sign: {
    arity: 'unary',
    apply: ([a]) => quantity(Math.sign(a!.value))
  },
  pi: {
    arity: 'nullary',
    apply: () => quantity(Math.PI)
  },
  min: {
    arity: 'variadic',
    apply: (args) =>
      requireMatchingDimensions(
        'min',
        args,
        Math.min(...args.map((arg) => arg.value))
      )
  },
  max: {
    arity: 'variadic',
    apply: (args) =>
      requireMatchingDimensions(
        'max',
        args,
        Math.max(...args.map((arg) => arg.value))
      )
  }
};

/** Reads a trig argument as degrees: angles convert, plain numbers keep the legacy degree meaning. */
function toDegrees(name: string, arg: ExpressionQuantity): number {
  if (arg.length !== 0) {
    throw incompatibleDimensions(
      `${name}() expects an angle or a number in degrees, not`,
      arg
    );
  }
  // An angle quantity already stores degrees; a plain number IS degrees.
  return arg.value * DEG_TO_RAD;
}

/** Inverse trig takes a plain unit-interval number and returns degrees. */
function degreesFromUnitInterval(
  name: 'asin' | 'acos',
  arg: ExpressionQuantity
): number {
  rejectDimensioned(name, arg);
  if (!(arg.value >= -1 && arg.value <= 1)) {
    throw new Error(`${name}() expects an argument between -1 and 1.`);
  }
  const radians = name === 'asin' ? Math.asin(arg.value) : Math.acos(arg.value);
  return radians / DEG_TO_RAD;
}

function rejectDimensioned(name: string, arg: ExpressionQuantity): void {
  if (arg.length !== 0 || arg.angle !== 0) {
    throw incompatibleDimensions(`${name}() expects a plain number, not`, arg);
  }
}

/** Shared min/max tail: every argument must share one dimension. */
function requireMatchingDimensions(
  name: string,
  args: ExpressionQuantity[],
  value: number
): ExpressionQuantity {
  const [first, ...rest] = args;
  for (const other of rest) {
    if (other.length !== first!.length || other.angle !== first!.angle) {
      throw incompatibleDimensions(
        `${name}() needs matching dimensions`,
        first!,
        other
      );
    }
  }
  // With no arguments Math.min/max yields ±Infinity, which the top-level
  // finite-result check refuses exactly as it did before dimensions existed.
  return quantity(value, first?.length ?? 0, first?.angle ?? 0);
}

const EXPRESSION_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  PI: Math.PI
};

export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  ...Object.keys(EXPRESSION_FUNCTIONS),
  ...Object.keys(EXPRESSION_CONSTANTS)
]);

type ExpressionToken =
  | { type: 'number'; value: number }
  | { type: 'identifier'; name: string }
  | { type: 'operator'; value: '+' | '-' | '*' | '/' | '^' }
  | { type: 'comma' }
  /** A feet/inch symbol directly after a number: `'`/`′` is foot, `"`/`″` is inch. */
  | { type: 'quote'; value: "'" | '"' }
  | { type: 'paren'; value: '(' | ')' };

function tokenizeExpression(expression: string): ExpressionToken[] {
  if (expression.length > 4_096)
    throw new Error('Expression exceeds the 4096 character limit.');
  const tokens: ExpressionToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index]!;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (
      char === '+' ||
      char === '-' ||
      char === '*' ||
      char === '/' ||
      char === '^'
    ) {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }

    if (char === ',') {
      tokens.push({ type: 'comma' });
      index += 1;
      continue;
    }

    // A feet/inch mark is a unit only directly after a number; anywhere else
    // it is not expression text at all and is refused like any other
    // unexpected character, as it was before units existed.
    if (
      (char === "'" || char === '′' || char === '"' || char === '″') &&
      tokens.at(-1)?.type === 'number'
    ) {
      tokens.push({
        type: 'quote',
        value: char === "'" || char === '′' ? "'" : '"'
      });
      index += 1;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char });
      index += 1;
      continue;
    }

    const numberMatch = /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
      expression.slice(index)
    );
    if (numberMatch) {
      tokens.push({ type: 'number', value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(
      expression.slice(index)
    );
    if (identifierMatch) {
      tokens.push({ type: 'identifier', name: identifierMatch[0] });
      index += identifierMatch[0].length;
      continue;
    }

    throw new Error(`Unexpected character "${char}" in expression.`);
  }

  // Every recursive grammar edge consumes a token; a token budget also bounds
  // long unary/power chains that a parenthesis-only guard would miss.
  if (tokens.length > 256)
    throw new Error('Expression exceeds the 256 token limit.');
  return tokens;
}

/**
 * Options for {@link evaluateExpression}. Everything is optional so every
 * existing two-argument call keeps its meaning: unit-free expressions never
 * consult `documentUnits`, and without it a length suffix is refused (as
 * every suffix was before) instead of being read in an assumed unit.
 */
export interface ExpressionOptions {
  /**
   * Document units that unit-suffixed quantities convert into. Scope values
   * are already document-unit numbers and pass through untouched.
   */
  documentUnits?: UnitSystem;
}

/**
 * Parses and evaluates an expression to a dimensioned quantity. Shared by
 * {@link evaluateExpression} and {@link getExpressionDimensions} so the
 * value and its dimensions always agree and throw on the same path.
 */
function parseExpressionQuantity(
  expression: string,
  scope: Record<string, number>,
  documentUnits: UnitSystem | undefined
): ExpressionQuantity {
  const tokens = tokenizeExpression(expression);
  let position = 0;
  let callError: Error | undefined;

  const peek = (): ExpressionToken | undefined => tokens[position];
  const next = (): ExpressionToken => {
    const token = tokens[position];
    if (!token) {
      throw new Error('Unexpected end of expression.');
    }
    position += 1;
    return token;
  };

  /** Converts a raw suffixed number into document units with its dimension. */
  function applyUnitSuffix(raw: number, suffix: string): ExpressionQuantity {
    const lowered = suffix.toLowerCase();
    const millimeters = EXPRESSION_LENGTH_UNITS[lowered];
    if (millimeters !== undefined) {
      if (documentUnits === undefined) {
        throw new Error(
          `A "${suffix}" length needs the document's units, which this field does not know; enter the value in document units.`
        );
      }
      return quantity((raw * millimeters) / UNIT_TO_MM[documentUnits], 1, 0);
    }
    const degrees = EXPRESSION_ANGLE_UNITS[lowered];
    if (degrees !== undefined) {
      return quantity(raw * degrees, 0, 1);
    }
    // Unreachable: callers check isUnitSuffix first.
    throw new Error(`Unknown unit "${suffix}" in expression.`);
  }

  /**
   * Reads the optional unit after a numeric literal. A bare identifier keeps
   * its legacy meaning (scope parameter or a throw), so a parameter called
   * `m` still resolves bare while `5 m` is five metres — an input that
   * previously threw either way.
   */
  function parseQuantitySuffix(raw: number): ExpressionQuantity {
    const following = peek();
    if (following?.type === 'identifier' && isUnitSuffix(following.name)) {
      position += 1;
      return applyUnitSuffix(raw, following.name);
    }
    if (following?.type === 'quote') {
      position += 1;
      return applyUnitSuffix(raw, following.value === "'" ? 'ft' : 'in');
    }
    return quantity(raw);
  }

  function parseCall(name: string): ExpressionQuantity {
    const fn = EXPRESSION_FUNCTIONS[name];
    if (!fn) {
      throw new Error(`Unknown function "${name}" in expression.`);
    }
    const args: ExpressionQuantity[] = [];
    const closing = peek();
    if (closing?.type !== 'paren' || closing.value !== ')') {
      args.push(parseAdditive());
      for (;;) {
        const token = peek();
        if (token?.type === 'comma') {
          position += 1;
          args.push(parseAdditive());
          continue;
        }
        break;
      }
    }
    const end = next();
    if (end.type !== 'paren' || end.value !== ')') {
      throw new Error(`Expected ")" after arguments to ${name}().`);
    }
    if (fn.arity === 'unary' && args.length !== 1) {
      throw new Error(`${name}() expects exactly one argument.`);
    }
    if (fn.arity === 'binary' && args.length !== 2) {
      throw new Error(`${name}() expects exactly two arguments.`);
    }
    if (fn.arity === 'nullary' && args.length !== 0) {
      throw new Error(`${name}() takes no arguments.`);
    }
    try {
      return fn.apply(args);
    } catch (error) {
      // Finish parsing before reporting a value/domain failure. Otherwise a
      // failed guard can hide malformed trailing syntax from field guidance.
      callError ??= error instanceof Error ? error : new Error(String(error));
      return quantity(Number.NaN);
    }
  }

  function parsePrimary(): ExpressionQuantity {
    const token = next();
    if (token.type === 'number') {
      let result = parseQuantitySuffix(token.value);
      // Juxtaposed quantities add: `1' 2"` reads as one foot plus two inches.
      // Only dimensioned quantities juxtapose (`5 3` still throws), and
      // juxtaposition never means multiplication (`2 (3)` still throws).
      while (result.length !== 0 || result.angle !== 0) {
        const juxtaposed = peek();
        if (juxtaposed?.type !== 'number') {
          break;
        }
        position += 1;
        const following = parseQuantitySuffix(juxtaposed.value);
        if (following.length === 0 && following.angle === 0) {
          throw new Error('Unexpected trailing tokens in expression.');
        }
        if (
          result.length !== following.length ||
          result.angle !== following.angle
        ) {
          throw incompatibleDimensions('cannot add', result, following);
        }
        result = quantity(
          result.value + following.value,
          result.length,
          result.angle
        );
      }
      return result;
    }
    if (token.type === 'identifier') {
      const following = peek();
      if (following?.type === 'paren' && following.value === '(') {
        position += 1;
        return parseCall(token.name);
      }
      const constant = EXPRESSION_CONSTANTS[token.name];
      if (constant !== undefined) {
        return quantity(constant);
      }
      const value = scope[token.name];
      if (value === undefined) {
        throw new Error(`Unknown identifier "${token.name}" in expression.`);
      }
      // A typed parameter (F05) brings its dimension; unitless ones and any
      // plain scope value stay dimensionless, exactly as before v21.
      const kind = (scope as KindedScope)[PARAMETER_KINDS]?.[token.name];
      return quantity(
        value,
        kind === 'length' ? 1 : 0,
        kind === 'angle' ? 1 : 0
      );
    }
    if (token.type === 'paren' && token.value === '(') {
      const value = parseAdditive();
      const closing = next();
      if (closing.type !== 'paren' || closing.value !== ')') {
        throw new Error('Expected closing parenthesis in expression.');
      }
      return value;
    }
    throw new Error('Unexpected token in expression.');
  }

  function parsePower(): ExpressionQuantity {
    const base = parsePrimary();
    const token = peek();
    if (token?.type === 'operator' && token.value === '^') {
      position += 1;
      // Right-associative: 2^3^2 = 2^(3^2).
      const exponent = parseUnary();
      if (exponent.length !== 0 || exponent.angle !== 0) {
        throw incompatibleDimensions(
          'the exponent must be a plain number, not',
          exponent
        );
      }
      if (base.length === 0 && base.angle === 0) {
        return quantity(Math.pow(base.value, exponent.value));
      }
      if (base.angle !== 0) {
        throw incompatibleDimensions('cannot raise an angle to a power', base);
      }
      if (!Number.isInteger(exponent.value)) {
        throw incompatibleDimensions(
          `cannot raise ${describeDimension(base)} to a non-integer power`,
          base
        );
      }
      return quantity(
        Math.pow(base.value, exponent.value),
        base.length * exponent.value,
        0
      );
    }
    return base;
  }

  function parseUnary(): ExpressionQuantity {
    const token = peek();
    if (
      token?.type === 'operator' &&
      (token.value === '-' || token.value === '+')
    ) {
      position += 1;
      const operand = parseUnary();
      return token.value === '-'
        ? quantity(-operand.value, operand.length, operand.angle)
        : operand;
    }
    return parsePower();
  }

  function parseMultiplicative(): ExpressionQuantity {
    let value = parseUnary();
    for (;;) {
      const token = peek();
      if (
        token?.type !== 'operator' ||
        (token.value !== '*' && token.value !== '/')
      ) {
        return value;
      }
      position += 1;
      const right = parseUnary();
      const scaled =
        (value.angle !== 0 && (right.length !== 0 || right.angle !== 0)) ||
        (right.angle !== 0 && (value.length !== 0 || value.angle !== 0));
      if (scaled) {
        throw incompatibleDimensions(
          token.value === '*' ? 'cannot multiply' : 'cannot divide',
          value,
          right
        );
      }
      value =
        token.value === '*'
          ? quantity(
              value.value * right.value,
              value.length + right.length,
              value.angle + right.angle
            )
          : quantity(
              value.value / right.value,
              value.length - right.length,
              value.angle - right.angle
            );
    }
  }

  function parseAdditive(): ExpressionQuantity {
    let value = parseMultiplicative();
    for (;;) {
      const token = peek();
      if (
        token?.type !== 'operator' ||
        (token.value !== '+' && token.value !== '-')
      ) {
        return value;
      }
      position += 1;
      const right = parseMultiplicative();
      if (value.length !== right.length || value.angle !== right.angle) {
        throw incompatibleDimensions(
          token.value === '+' ? 'cannot add' : 'cannot subtract',
          value,
          right
        );
      }
      value = quantity(
        token.value === '+'
          ? value.value + right.value
          : value.value - right.value,
        value.length,
        value.angle
      );
    }
  }

  const result = parseAdditive();
  if (position < tokens.length) {
    throw new Error('Unexpected trailing tokens in expression.');
  }
  if (callError !== undefined) throw callError;
  return result;
}

/**
 * Evaluates a parameter expression supporting numbers, scope variables, the
 * `pi` constant (and `pi()`), unit-suffixed quantities (`5 mm`, `2 cm`,
 * `3 in`, `1 ft`, `1' 2"`, `90deg`, `1.5rad`), function calls (abs, sqrt,
 * floor, ceil, round, min, max, avg, mod, sign, degree-based sin/cos/tan,
 * degree-returning asin/acos/atan/atan2, plus require_min and
 * require_one_of), `+ - * / ^`, juxtaposed-quantity addition (`1' 2"`),
 * unary minus, and parentheses.
 * Implemented as a small recursive-descent parser so untrusted expressions
 * are never executed as JavaScript. Throws on syntax errors, unknown
 * identifiers, and incompatible dimensions.
 */
export function evaluateExpression(
  expression: string,
  scope: Record<string, number>,
  options?: ExpressionOptions
): number {
  const result = parseExpressionQuantity(
    expression,
    scope,
    options?.documentUnits
  );
  if (!Number.isFinite(result.value)) {
    throw new Error('Expression did not evaluate to a finite number.');
  }
  return result.value;
}

/** The dimension exponents of an evaluated expression (length, angle). */
export interface ExpressionDimensions {
  length: number;
  angle: number;
}

/** The quantity a typed field holds. */
export type ExpressionDimension = 'length' | 'angle' | 'number';

/** A typed field: the document's units and the quantity it measures. */
export interface FieldQuantity {
  documentUnits: UnitSystem;
  dimension: ExpressionDimension;
}

/**
 * Evaluates a typed field's expression: unit suffixes convert into the
 * document's units, and a result of another dimension is refused on the
 * evaluator's usual throw path — an angle or an area in a length field, a
 * length or squared angle in an angle field, units in a count field.
 * Unit-free results pass, because bare numbers and
 * parameters are document-unit values (and degrees) by definition.
 *
 * One rule for every owner of a typed field (the keypad, expression inputs),
 * so they cannot disagree about what `5 mm` or `30 deg` means. It is kept out
 * of {@link evaluateExpression} so the kernel worker, which resolves through
 * that, does not carry it inside its size-budgeted chunk.
 */
export function evaluateFieldExpression(
  expression: string,
  scope: Record<string, number>,
  { documentUnits, dimension }: FieldQuantity
): number {
  const { value, length, angle } = parseExpressionQuantity(
    expression,
    scope,
    documentUnits
  );
  if (!Number.isFinite(value)) {
    throw new Error('Expression did not evaluate to a finite number.');
  }
  requireFieldDimension({ value, length, angle }, dimension);
  return value;
}

/**
 * Refuses a result that a field of `dimension` cannot hold. Unit-free
 * results pass every field (bare numbers are document-unit values and
 * degrees by definition); otherwise the dimension must match exactly.
 */
function requireFieldDimension(
  { length, angle }: ExpressionQuantity,
  dimension: ExpressionDimension
): void {
  // `length * (length - 1)` is zero exactly when the length power is 0 or 1.
  const angleField = dimension === 'angle';
  if (
    dimension === 'number'
      ? length !== 0 || angle !== 0
      : angleField
        ? length !== 0 || angle * (angle - 1) !== 0
        : angle !== 0 || length * (length - 1) !== 0
  ) {
    throw new Error(
      `Incompatible dimensions in expression: expected ${dimension === 'number' ? 'a number without units' : angleField ? 'an angle, not a length' : 'a length, not an angle or area'}.`
    );
  }
}

/**
 * Reports the dimensions {@link evaluateExpression} computed for an
 * expression, throwing identically on anything it would refuse. Field
 * owners (e.g. the keypad) use this to refuse a length in an angle field
 * and vice versa; the evaluator itself stays a plain number so every
 * existing two-argument call keeps its meaning.
 */
export function getExpressionDimensions(
  expression: string,
  scope: Record<string, number>,
  options?: ExpressionOptions
): ExpressionDimensions {
  const result = parseExpressionQuantity(
    expression,
    scope,
    options?.documentUnits
  );
  if (!Number.isFinite(result.value)) {
    throw new Error('Expression did not evaluate to a finite number.');
  }
  return { length: result.length, angle: result.angle };
}

/**
 * The scope variables an expression reads. Functions and constants are
 * filtered out by name; `isValidParameterName` refuses every one of them, so
 * a surviving identifier can only be a parameter reference (or a typo).
 * A unit suffix directly after a number (`5 m`) is the parser's unit, and a
 * name directly before `(` is always a function call (`foo(1)`), so neither
 * is a read of a parameter that happens to share the name.
 * Unparseable input reads nothing rather than throwing — callers here are
 * auditing a document, not evaluating it.
 */
export function expressionIdentifiers(expression: string): string[] {
  let tokens: ExpressionToken[];
  try {
    tokens = tokenizeExpression(expression);
  } catch {
    return [];
  }
  const names: string[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'identifier' || RESERVED_IDENTIFIERS.has(token.name)) {
      return;
    }
    if (tokens[index - 1]?.type === 'number' && isUnitSuffix(token.name)) {
      return;
    }
    const next = tokens[index + 1];
    if (next?.type === 'paren' && next.value === '(') return;
    names.push(token.name);
  });
  return names;
}

/** One document node whose stored expressions read a given parameter. */
export interface ParameterReference {
  nodeId: EntityId;
  /** How a refusal names the holder, e.g. `Sketch "Profile"`. */
  label: string;
  /** The reading expressions, in document order, deduplicated. */
  expressions: string[];
}

/**
 * Replaces identifier tokens equal to `oldName` with `newName`, leaving
 * everything else — whitespace, operators, number literals — byte-identical.
 * Scans numbers before identifiers in the same order as `tokenizeExpression`,
 * so the `e5` inside `1e5` is an exponent, never a rename candidate. A unit
 * suffix (`5 mm`) is grammar rather than a parameter read, so it is never
 * renamed even when a parameter shares the unit's name; a bare `mm` still is.
 */
function renameIdentifierInExpression(
  expression: string,
  oldName: string,
  newName: string
): string {
  let out = '';
  let index = 0;
  let previousWasNumber = false;
  while (index < expression.length) {
    const rest = expression.slice(index);
    const numberMatch = /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
    if (numberMatch) {
      out += numberMatch[0];
      index += numberMatch[0].length;
      previousWasNumber = true;
      continue;
    }
    const identifierMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(rest);
    if (identifierMatch) {
      const name = identifierMatch[0];
      const isUnitPosition = previousWasNumber && isUnitSuffix(name);
      out += name === oldName && !isUnitPosition ? newName : name;
      index += name.length;
      previousWasNumber = false;
      continue;
    }
    out += expression[index];
    index += 1;
    // Whitespace between a number and its suffix still reads as a quantity
    // (`5 mm`), so only a non-space token ends the unit position.
    if (!/\s/.test(expression[index - 1]!)) {
      previousWasNumber = false;
    }
  }
  return out;
}

/**
 * Whether a stored string is an expression that reads `name` right now.
 *
 * Called only for authored expression fields. Reference queries retain the
 * existing requirement that an expression evaluate against the live scope:
 * a broken expression is not currently reading a value a delete would strand.
 * Renames still preserve its identifier tokens so repairing it later works.
 */
function readsParameter(
  candidate: string,
  name: string,
  scope: Record<string, number>,
  documentUnits?: UnitSystem
): boolean {
  if (!expressionIdentifiers(candidate).includes(name)) {
    return false;
  }
  try {
    evaluateExpression(candidate, scope, { documentUnits });
    return true;
  } catch {
    return false;
  }
}

/** How a refusal names the node holding a reference. */
function referenceLabel(node: DocumentNode): string {
  const named = node.name.trim();
  const kind =
    node.kind === 'sketch-object'
      ? 'Sketch object'
      : node.kind.charAt(0).toUpperCase() + node.kind.slice(1);
  return named ? `${kind} "${named}"` : kind;
}

/**
 * Every node still reading `name`, so a caller can refuse to strand them.
 *
 * A parameter's own expression is skipped — deleting `w = 2 * w` strands
 * nothing — but a second parameter written in terms of this one is reported
 * like any other reader.
 */
export function findParameterReferences(
  document: ProjectDocument,
  name: string
): ParameterReference[] {
  const { scope } = getParameterScope(document);
  if (scope[name] === undefined) {
    // An unevaluatable parameter is read by nobody: every expression naming
    // it already fails, so the delete repairs the document rather than
    // breaking it.
    return [];
  }
  const references: ParameterReference[] = [];
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'parameter' && node.name === name) {
      continue;
    }
    const candidates: string[] = [];
    rewriteNodeExpressions(node, (expression) => {
      candidates.push(expression);
      return expression;
    });
    const expressions: string[] = [];
    for (const candidate of candidates) {
      if (
        !expressions.includes(candidate) &&
        readsParameter(candidate, name, scope, document.units)
      ) {
        expressions.push(candidate);
      }
    }
    if (expressions.length > 0) {
      references.push({
        nodeId: node.id,
        label: referenceLabel(node),
        expressions
      });
    }
  }
  return references;
}

/**
 * F05: why `name` cannot take `quantity` (null clears it to unitless), or
 * null when it can. Every stored expression that names the parameter is
 * re-evaluated with the new quantity: a field of known dimension must still
 * hold its kind (a length parameter in an angle field, a typed count with
 * units), and every other expression must still be dimensionally coherent
 * (`width + 5` once width is a length: a bare number cannot be added to a
 * length). Parameters that read it are re-evaluated the same way.
 */
export function parameterQuantityRefusal(
  document: ProjectDocument,
  name: string,
  quantity: ParameterKind | null
): string | null {
  const target = listParameters(document).find(
    (parameter) => parameter.name === name
  );
  if (!target) return `Parameter "${name}" does not exist.`;
  if (target.toggle && quantity !== null && quantity !== 'number') {
    return 'An on/off parameter is a number (0 or 1); it cannot be a length or an angle.';
  }
  const candidate = cloneDocument(document);
  const parameter = listParameters(candidate).find(
    (entry) => entry.name === name
  )!;
  if (quantity) parameter.quantity = quantity;
  else delete parameter.quantity;
  const before = new Set(getParameterScope(document).errors);
  const { scope, errors } = getParameterScope(candidate);
  const fresh = errors.find((error) => !before.has(error));
  if (fresh) return fresh;
  for (const node of Object.values(candidate.nodes)) {
    if (node.kind === 'parameter') continue;
    let refusal: string | null = null;
    rewriteNodeExpressions(node, (expression, dimension) => {
      if (refusal || !expressionIdentifiers(expression).includes(name)) {
        return expression;
      }
      try {
        const result = parseExpressionQuantity(
          expression,
          scope,
          candidate.units
        );
        if (dimension) requireFieldDimension(result, dimension);
      } catch (error) {
        refusal = `${referenceLabel(node)} uses "${expression}": ${error instanceof Error ? error.message : 'it no longer evaluates.'}`;
      }
      return expression;
    });
    if (refusal) return refusal;
  }
  return null;
}

/** One stored expression that uses a typed parameter in a way it cannot hold. */
/**
 * Every object inside `root` keyed to its property path
 * (`data.transform.translation`). An array element with an id is named by
 * it (`constraints[c_12]`), so removing an earlier entry renames nothing.
 */
function objectPaths(root: object): WeakMap<object, string> {
  const paths = new WeakMap<object, string>();
  const stack: [object, string][] = [[root, '']];
  while (stack.length > 0) {
    const [value, path] = stack.pop()!;
    if (paths.has(value)) continue;
    paths.set(value, path);
    const list = Array.isArray(value);
    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== 'object') continue;
      const { id = undefined, constraintId = undefined } = child as {
        id?: unknown;
        constraintId?: unknown;
      };
      const name = typeof id === 'string' ? id : constraintId;
      const segment = list
        ? `[${typeof name === 'string' ? name : key}]`
        : path
          ? `.${key}`
          : key;
      stack.push([child as object, `${path}${segment}`]);
    }
  }
  return paths;
}

export interface TypedParameterMisuse {
  /** The feature that would build from it (null when none does). */
  featureId: FeatureId | null;
  /**
   * Which occurrence this is: the holding node and the field's property
   * path. Labels repeat (two sketch lines with the same expression), so
   * comparisons between documents key on this, not on the message.
   */
  occurrence: string;
  message: string;
}

/**
 * F05: every stored expression that reads a typed parameter and no longer
 * holds its field's dimension (a length parameter as a revolve angle) or is
 * incoherent (`width + 5` with width a length). The command boundary refuses
 * an edit that adds one, and the exact build refuses to build the feature
 * that holds one, so a typed parameter never reaches the kernel as the
 * wrong quantity — whoever authored the feature (a form, the assistant, an
 * API client or an older client's document).
 */
export function typedParameterMisuse(
  document: ProjectDocument
): TypedParameterMisuse[] {
  const { scope } = getParameterScope(document);
  const typed = new Set(Object.keys(parameterKindsOf(scope)));
  if (typed.size === 0) return [];
  const sketchFeature = new Map<string, FeatureId>();
  for (const feature of listFeaturesInOrder(document)) {
    if (feature.data.featureKind === 'sketch') {
      sketchFeature.set(String(feature.data.sketchId), feature.featureId);
    }
  }
  const owner = (node: DocumentNode): FeatureId | null => {
    if (node.kind === 'feature') return node.featureId;
    if (node.kind === 'sketch')
      return sketchFeature.get(String(node.sketchId)) ?? null;
    if (node.kind === 'sketch-object') {
      const parent = node.parentId ? document.nodes[node.parentId] : undefined;
      return parent?.kind === 'sketch'
        ? (sketchFeature.get(String(parent.sketchId)) ?? null)
        : null;
    }
    return null;
  };
  const misuse: TypedParameterMisuse[] = [];
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'parameter') continue;
    let paths: WeakMap<object, string> | null = null;
    rewriteNodeExpressions(node, (expression, dimension, site) => {
      if (!expressionIdentifiers(expression).some((name) => typed.has(name))) {
        return expression;
      }
      try {
        const result = parseExpressionQuantity(
          expression,
          scope,
          document.units
        );
        if (dimension) requireFieldDimension(result, dimension);
      } catch (error) {
        misuse.push({
          featureId: owner(node),
          occurrence: `${node.id}:${(paths ??= objectPaths(node)).get(site.container) ?? '?'}.${site.key}`,
          message: `${referenceLabel(node)} uses "${expression}": ${error instanceof Error ? error.message : 'it no longer evaluates.'}`
        });
      }
      return expression;
    });
  }
  return misuse;
}

/**
 * The first typed-parameter misuse `after` has that `before` did not, or
 * null: what a command must not introduce. Misuse already present (a document
 * from elsewhere) does not block an unrelated edit; the build refuses it.
 */
export function newTypedParameterMisuse(
  before: ProjectDocument,
  after: ProjectDocument
): string | null {
  const found = typedParameterMisuse(after);
  if (found.length === 0) return null;
  // Same field, same expression, same complaint: an occurrence the edit did
  // not introduce. Keyed per node and field, as labels and messages repeat.
  const key = (entry: TypedParameterMisuse) =>
    `${entry.occurrence}\u0000${entry.message}`;
  const known = new Set(typedParameterMisuse(before).map(key));
  return found.find((entry) => !known.has(key(entry)))?.message ?? null;
}

/**
 * F05: the quantity each unitless parameter most plausibly measures, offered
 * to the owner rather than applied: what its own expression carries
 * (`12 mm`, `30 deg`), else the one dimension every field that reads it
 * agrees on. A parameter is left out when it is typed or a toggle, the
 * evidence disagrees or is absent, or the suggestion would break a use.
 *
 * One pass for the whole table: the scope and an index of every expression
 * by the names it reads are built once, and each candidate re-checks only
 * the expressions that read it, so a large document stays linear.
 */
export function suggestParameterQuantities(
  document: ProjectDocument
): Record<string, ParameterKind> {
  const parameters = listParameters(document);
  const suggestions: Record<string, ParameterKind> = {};
  const candidates = parameters.filter(
    (parameter) => !parameter.quantity && !parameter.toggle
  );
  if (candidates.length === 0) return suggestions;
  const { scope } = getParameterScope(document);
  const uses = new Map<
    string,
    {
      expression: string;
      dimension: ExpressionFieldDimension;
      self: string | null;
    }[]
  >();
  for (const node of Object.values(document.nodes)) {
    const self = node.kind === 'parameter' ? node.name : null;
    rewriteNodeExpressions(node, (expression, dimension) => {
      for (const name of new Set(expressionIdentifiers(expression))) {
        let list = uses.get(name);
        if (!list) uses.set(name, (list = []));
        list.push({ expression, dimension, self });
      }
      return expression;
    });
  }
  // One trial scope for every candidate: the candidate's kind is set for its
  // check and removed after (candidates are untyped, so never in `kinds`).
  const trialKinds: Record<string, ParameterKind> = {
    ...parameterKindsOf(scope)
  };
  const trial = withParameterKinds({ ...scope }, trialKinds);
  for (const target of candidates) {
    let suggestion: ParameterKind | null = null;
    try {
      const own = getExpressionDimensions(target.expression, scope, {
        documentUnits: document.units
      });
      if (own.length === 1 && own.angle === 0) suggestion = 'length';
      else if (own.angle === 1 && own.length === 0) suggestion = 'angle';
    } catch {
      continue;
    }
    const reads = (uses.get(target.name) ?? []).filter(
      (use) => use.self !== target.name
    );
    if (!suggestion) {
      const seen = new Set(reads.map((use) => use.dimension));
      seen.delete(null);
      if (seen.size !== 1) continue;
      suggestion = [...seen][0] as ParameterKind;
    }
    trialKinds[target.name] = suggestion;
    const breaks = reads.some((use) => {
      try {
        const result = parseExpressionQuantity(
          use.expression,
          trial,
          document.units
        );
        if (use.dimension) requireFieldDimension(result, use.dimension);
        return false;
      } catch {
        return true;
      }
    });
    delete trialKinds[target.name];
    if (!breaks) suggestions[target.name] = suggestion;
  }
  return suggestions;
}

/** {@link suggestParameterQuantities} for one parameter. */
export function suggestParameterQuantity(
  document: ProjectDocument,
  name: string
): ParameterKind | null {
  return suggestParameterQuantities(document)[name] ?? null;
}

export {
  keyableImportedNodeData,
  keyableImportedNodes
} from './imported-payload-key';
