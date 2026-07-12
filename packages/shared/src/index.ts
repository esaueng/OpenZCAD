export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type ProjectId = Brand<string, 'ProjectId'>;
export type UserId = Brand<string, 'UserId'>;
export type EntityId = Brand<string, 'EntityId'>;
export type FeatureId = Brand<string, 'FeatureId'>;
export type BodyId = Brand<string, 'BodyId'>;
export type SketchId = Brand<string, 'SketchId'>;
export type ParameterId = Brand<string, 'ParameterId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type RevisionId = Brand<string, 'RevisionId'>;
export type JobId = Brand<string, 'JobId'>;
export type UploadSessionId = Brand<string, 'UploadSessionId'>;
export type AssetId = Brand<string, 'AssetId'>;

export const PROJECT_DOCUMENT_SCHEMA_VERSION = 2 as const;
export type ProjectDocumentSchemaVersion =
  typeof PROJECT_DOCUMENT_SCHEMA_VERSION;

export type UnitSystem = 'mm' | 'cm' | 'm' | 'inch';
export type PlaneId = 'XY' | 'XZ' | 'YZ';
export type PrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';
export type FeatureKind =
  | 'primitive'
  | 'sketch'
  | 'extrude'
  | 'revolve'
  | 'boolean'
  | 'transform'
  | 'imported-mesh';
export type SketchObjectKind = 'rectangle' | 'circle' | 'polygon';
export type BooleanOperation = 'union' | 'subtract' | 'intersect';

/**
 * A parametric scalar: either a literal number or an expression string that is
 * evaluated against the document's parameter table when geometry is rebuilt
 * (e.g. `"width / 2 + 5"`). Storing the raw expression keeps features fully
 * parametric — editing a parameter regenerates every feature that uses it.
 */
export type ParamValue = number | string;

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface ParametricVector3 {
  x: ParamValue;
  y: ParamValue;
  z: ParamValue;
}

export interface Transform3D {
  translation: Vector3;
  rotationDeg: Vector3;
}

export interface ParametricTransform3D {
  translation: ParametricVector3;
  rotationDeg: ParametricVector3;
}

export interface BaseNode {
  id: EntityId;
  parentId: EntityId | null;
  revisionId: RevisionId | null;
  name: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface ProjectNode extends BaseNode {
  kind: 'project';
  projectId: ProjectId;
  units: UnitSystem;
  activePartId: EntityId;
}

export interface AssemblyNode extends BaseNode {
  kind: 'assembly';
  childIds: EntityId[];
}

export interface PartNode extends BaseNode {
  kind: 'part';
  childIds: EntityId[];
}

/**
 * A named model parameter. `expression` may reference other parameters;
 * `value` caches the last successful evaluation for display, but consumers
 * always re-evaluate the full scope when rebuilding geometry.
 */
export interface ParameterNode extends BaseNode {
  kind: 'parameter';
  parameterId: ParameterId;
  expression: string;
  value: number;
}

export interface SketchNode extends BaseNode {
  kind: 'sketch';
  sketchId: SketchId;
  plane: PlaneId;
  /** Offset of the sketch plane along its normal. */
  offset: ParamValue;
  objectIds: EntityId[];
}

export type SketchObjectData =
  | {
      objectKind: 'rectangle';
      width: ParamValue;
      height: ParamValue;
      centerX: ParamValue;
      centerY: ParamValue;
    }
  | {
      objectKind: 'circle';
      radius: ParamValue;
      centerX: ParamValue;
      centerY: ParamValue;
    }
  | {
      objectKind: 'polygon';
      sides: ParamValue;
      radius: ParamValue;
      centerX: ParamValue;
      centerY: ParamValue;
    };

export interface SketchObjectNode extends BaseNode {
  kind: 'sketch-object';
  objectKind: SketchObjectKind;
  data: SketchObjectData;
}

/** In-sketch axis a revolve sweeps the profile around. */
export type RevolveAxis = 'horizontal' | 'vertical';

export type FeatureData =
  | {
      featureKind: 'primitive';
      primitiveKind: PrimitiveKind;
      dimensions: Record<string, ParamValue>;
    }
  | {
      featureKind: 'sketch';
      sketchId: SketchId;
    }
  | {
      featureKind: 'extrude';
      sketchId: SketchId;
      distance: ParamValue;
    }
  | {
      featureKind: 'revolve';
      sketchId: SketchId;
      axis: RevolveAxis;
    }
  | {
      featureKind: 'boolean';
      operation: BooleanOperation;
      targetBodyIds: BodyId[];
    }
  | {
      featureKind: 'transform';
      targetBodyId: BodyId;
      transform: ParametricTransform3D;
    }
  | {
      featureKind: 'imported-mesh';
      artifactId: ArtifactId;
      sourceName: string;
      triangleCount: number;
      /** Flat xyz triples in document units. */
      vertices: number[];
      /** Triangle vertex indices. */
      indices: number[];
    };

export interface FeatureNode extends BaseNode {
  kind: 'feature';
  featureId: FeatureId;
  featureKind: FeatureKind;
  bodyId?: BodyId;
  data: FeatureData;
}

export interface BodyNode extends BaseNode {
  kind: 'body';
  bodyId: BodyId;
  featureId: FeatureId;
  bodyType: 'solid' | 'mesh-reference';
  representationSource: 'brep' | 'mesh-import';
  exportableStep: boolean;
}

export type DocumentNode =
  | ProjectNode
  | AssemblyNode
  | PartNode
  | ParameterNode
  | SketchNode
  | SketchObjectNode
  | FeatureNode
  | BodyNode;

export interface MeshGeometry {
  kind: 'mesh';
  vertices: number[];
  indices: number[];
}

export interface BoundingBox {
  min: Vector3;
  max: Vector3;
}

/**
 * Display/export projection of one body, derived by the kernel. Vertices are
 * already in world space (transform features are baked in), so the viewport
 * renders representations without additional placement.
 */
export interface BodyRepresentation {
  bodyId: BodyId;
  name: string;
  source: FeatureKind;
  mesh: MeshGeometry;
  /** Number of planar B-Rep faces in the underlying solid. */
  faceCount: number;
  color: string;
  exportableStep: boolean;
  /** True when a later boolean feature consumed this body. */
  consumed: boolean;
  volume: number;
  bbox: BoundingBox;
}

export interface RevisionRecord {
  revisionId: RevisionId;
  createdAt: string;
  reason: string;
  commandCount: number;
}

/** Durable user-visible save point. Command history and undo state remain separate. */
export interface ProjectCheckpoint {
  checkpointId: string;
  revisionId: RevisionId;
  documentVersion: number;
  createdAt: string;
  reason: string;
}

/**
 * Metadata-only reference to a large source or generated asset. Binary data is
 * stored outside the canonical document (IndexedDB locally, R2 when synced).
 */
export interface ProjectAssetRef {
  assetId: AssetId;
  artifactId?: ArtifactId;
  kind: 'step-source' | 'stl-source' | 'mesh-cache' | 'thumbnail' | 'export';
  name: string;
  contentType: string;
  bytes?: number;
  checksum?: string;
  storage: 'local' | 'remote' | 'local-and-remote';
  createdAt: string;
}

export interface DerivedState {
  bodyRepresentations: Record<BodyId, BodyRepresentation>;
  exportableBodyIds: BodyId[];
  warnings: string[];
  updatedAt: string;
}

export interface ProjectDocument {
  schemaVersion: ProjectDocumentSchemaVersion;
  projectId: ProjectId;
  ownerUserId: UserId;
  rootNodeId: EntityId;
  rootAssemblyId: EntityId;
  activePartId: EntityId;
  name: string;
  units: UnitSystem;
  version: number;
  nodes: Record<string, DocumentNode>;
  featureOrder: FeatureId[];
  bodyOrder: BodyId[];
  sketchOrder: SketchId[];
  parameterOrder: ParameterId[];
  revisions: RevisionRecord[];
  checkpoints: ProjectCheckpoint[];
  commandLog: SerializedCommand[];
  assets: Record<AssetId, ProjectAssetRef>;
  derived: DerivedState;
}

export interface SerializedCommand<TPayload = unknown> {
  kind: string;
  payload: TPayload;
  replayVersion: number;
  label: string;
  timestamp: string;
}

export interface UploadSessionRecord {
  uploadSessionId: UploadSessionId;
  artifactId: ArtifactId;
  objectKey: string;
  uploadUrl?: string;
  expiresAt: string;
  fileName: string;
  contentType: string;
}

export interface ArtifactRecord {
  artifactId: ArtifactId;
  projectId: ProjectId;
  kind:
    | 'step-import'
    | 'stl-import'
    | 'step-export'
    | 'stl-export'
    | 'snapshot'
    | 'thumbnail';
  name: string;
  objectKey: string;
  contentType: string;
  bytes?: number;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
}

export interface ProjectSummary {
  projectId: ProjectId;
  name: string;
  lastRevisionId?: RevisionId;
  revisionCount: number;
  updatedAt: string;
}

export interface JobRecord {
  jobId: JobId;
  kind: 'thumbnail' | 'validation' | 'import' | 'export';
  status: 'queued' | 'running' | 'completed' | 'failed';
  projectId: ProjectId;
  artifactId?: ArtifactId;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectRequest {
  name: string;
  units?: UnitSystem;
}

export interface CreateProjectResponse {
  project: ProjectSummary;
  document: ProjectDocument;
}

export interface ListProjectsResponse {
  projects: ProjectSummary[];
}

export interface SaveRevisionRequest {
  projectId: ProjectId;
  reason: string;
  document: ProjectDocument;
}

export interface CreateUploadSessionRequest {
  projectId: ProjectId;
  fileName: string;
  contentType: string;
}

export interface CreateUploadSessionResponse {
  session: UploadSessionRecord;
}

export interface FinalizeImportRequest {
  projectId: ProjectId;
  uploadSessionId: UploadSessionId;
  artifactId: ArtifactId;
  fileName: string;
  contentType: string;
}

export interface RequestExportRequest {
  projectId: ProjectId;
  bodyIds: BodyId[];
  format: 'step' | 'stl';
}

export interface RequestExportResponse {
  artifact: ArtifactRecord;
  job: JobRecord;
}

export interface ArtifactMetadataResponse {
  artifact: ArtifactRecord | null;
}

export interface HealthResponse {
  status: 'ok';
  environment: 'beta';
  time: string;
}

export interface AuthSession {
  userId: UserId;
  displayName: string;
  email?: string;
  mode: 'development' | 'cloudflare-access';
}

export const identityTransform = (): Transform3D => ({
  translation: { x: 0, y: 0, z: 0 },
  rotationDeg: { x: 0, y: 0, z: 0 }
});

export const deepClone = <T>(value: T): T => structuredClone(value);

export const nowIso = (): string => new Date().toISOString();

export function createId<Name extends string>(
  prefix: string
): Brand<string, Name> {
  return `${prefix}_${crypto.randomUUID()}` as Brand<string, Name>;
}

export const toEntityId = (value: string): EntityId => value as EntityId;
export const toProjectId = (value: string): ProjectId => value as ProjectId;
export const toFeatureId = (value: string): FeatureId => value as FeatureId;
export const toBodyId = (value: string): BodyId => value as BodyId;
export const toSketchId = (value: string): SketchId => value as SketchId;
export const toParameterId = (value: string): ParameterId =>
  value as ParameterId;
export const toRevisionId = (value: string): RevisionId => value as RevisionId;
export const toArtifactId = (value: string): ArtifactId => value as ArtifactId;
export const toUploadSessionId = (value: string): UploadSessionId =>
  value as UploadSessionId;
export const toUserId = (value: string): UserId => value as UserId;
export const toJobId = (value: string): JobId => value as JobId;
export const toAssetId = (value: string): AssetId => value as AssetId;

export const DEFAULT_BODY_COLOR = '#e1a948';

export const FEATURE_COLORS: Record<FeatureKind, string> = {
  primitive: '#e1a948',
  sketch: DEFAULT_BODY_COLOR,
  extrude: '#4bb7a7',
  revolve: '#5fb3e8',
  boolean: '#ff7452',
  transform: '#8b80f9',
  'imported-mesh': '#7aa3ff'
};

export const featureColor = (kind: FeatureKind): string =>
  FEATURE_COLORS[kind] ?? DEFAULT_BODY_COLOR;

/** Millimetres per document unit, used by exporters that fix a unit. */
export const UNIT_TO_MM: Record<UnitSystem, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  inch: 25.4
};

const FILE_NAME_MAX_LENGTH = 128;

/**
 * Normalizes a user-supplied file name so it is safe to embed in storage
 * object keys and artifact names: strips path segments, control characters,
 * and key-hostile punctuation, and caps the length.
 */
export function sanitizeFileName(fileName: string): string {
  const baseName = fileName.split(/[/\\]/).pop() ?? '';
  const cleaned = baseName
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, FILE_NAME_MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : 'upload';
}
