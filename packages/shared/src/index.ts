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
export type UploadSessionId = Brand<string, 'UploadSessionId'>;
export type AssetId = Brand<string, 'AssetId'>;

export const PROJECT_DOCUMENT_SCHEMA_VERSION = 3 as const;
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
  | 'fillet'
  | 'chamfer'
  | 'pattern'
  | 'direct-edit'
  | 'imported-step'
  | 'imported-mesh';
export type SketchObjectKind = 'rectangle' | 'circle' | 'polygon';
export type BooleanOperation = 'union' | 'subtract' | 'intersect';
export type PatternKind = 'linear' | 'circular';
export type AxisId = 'x' | 'y' | 'z';

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

/**
 * History-backed edits applied directly to exact B-Rep topology. The source
 * dimension is a geometric fingerprint: rebuilding fails closed if the face
 * ordinal now resolves to different geometry instead of editing the wrong
 * feature.
 */
export type DirectEditOperation =
  | {
      kind: 'resize-through-hole';
      faceHash: number;
      sourceDiameter: number;
      sourceAxisStart: Vector3;
      sourceAxisEnd: Vector3;
      diameter: ParamValue;
    }
  | {
      kind: 'remove-face-feature';
      faceHash: number;
      sourceSurfaceType: string;
      sourceArea: number;
      sourceCenter: Vector3;
      sourceDiameter?: number;
      sourceAxisStart?: Vector3;
      sourceAxisEnd?: Vector3;
    };

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
      featureKind: 'fillet';
      targetBodyId: BodyId;
      edgeHashes: number[];
      radius: ParamValue;
    }
  | {
      featureKind: 'chamfer';
      targetBodyId: BodyId;
      edgeHashes: number[];
      distance: ParamValue;
    }
  | {
      featureKind: 'pattern';
      targetBodyId: BodyId;
      patternKind: PatternKind;
      count: ParamValue;
      axis: AxisId;
      spacing: ParamValue;
      angleDeg: ParamValue;
    }
  | {
      featureKind: 'direct-edit';
      targetBodyId: BodyId;
      operation: DirectEditOperation;
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
    }
  | {
      featureKind: 'imported-step';
      artifactId: ArtifactId;
      sourceName: string;
      /** ISO 10303-21 source retained for deterministic offline rebuilds. */
      stepText: string;
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
  representationSource: 'brep' | 'step-import' | 'mesh-import';
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

export interface FaceTopology {
  topologyId: string;
  hash: number;
  triangleStart: number;
  triangleCount: number;
  /** Exact surface measurements supplied by the browser geometry kernel. */
  geometry?: FaceGeometry;
}

export interface FaceGeometry {
  /** Underlying OCCT surface class (plane, cylinder, cone, B-spline, ...). */
  surfaceType: string;
  area: number;
  /** Exact surface center of mass, used as a topology fingerprint. */
  center: Vector3;
  /** Present for exact cylindrical surfaces. */
  radius?: number;
  diameter?: number;
  /** Axis endpoints of the trimmed cylindrical face in world coordinates. */
  axisStart?: Vector3;
  axisEnd?: Vector3;
  axialLength?: number;
  /** Set only when the kernel proves that both axial ends open outside. */
  featureType?: 'through-hole';
  /** Dimension currently supported by a deterministic direct edit. */
  editableDimension?: 'diameter';
}

export interface EdgeTopology {
  topologyId: string;
  hash: number;
  /** XYZ-interleaved sampled polyline points. */
  points: number[];
}

export interface BodyTopology {
  faces: FaceTopology[];
  edges: EdgeTopology[];
}

export interface TopologySelection {
  bodyId: BodyId;
  kind: 'body' | 'face' | 'edge';
  topologyId?: string;
  hash?: number;
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
  topology?: BodyTopology;
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
  projectId: ProjectId;
  objectKey: string;
  uploadUrl?: string;
  expiresAt: string;
  fileName: string;
  contentType: string;
  kind: ArtifactKind;
  metadata: Record<string, string | number | boolean>;
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

export type ArtifactKind = ArtifactRecord['kind'];

export interface ProjectSummary {
  projectId: ProjectId;
  name: string;
  lastRevisionId?: RevisionId;
  revisionCount: number;
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
  expectedVersion: number;
  document: ProjectDocument;
}

export interface CreateUploadSessionRequest {
  projectId: ProjectId;
  fileName: string;
  contentType: string;
  kind: ArtifactKind;
  metadata?: Record<string, string | number | boolean>;
}

export interface CreateUploadSessionResponse {
  session: UploadSessionRecord;
}

export interface FinalizeArtifactRequest {
  projectId: ProjectId;
  uploadSessionId: UploadSessionId;
  artifactId: ArtifactId;
}

/** @deprecated Use FinalizeArtifactRequest. */
export type FinalizeImportRequest = FinalizeArtifactRequest;

export interface ListArtifactsResponse {
  artifacts: ArtifactRecord[];
}

export interface ArtifactMetadataResponse {
  artifact: ArtifactRecord | null;
}

export interface HealthResponse {
  status: 'ok';
  environment: 'development' | 'beta';
  time: string;
}

export interface AuthSession {
  userId: UserId;
  displayName: string;
  email?: string;
  mode: 'development' | 'cloudflare-access';
}

export const APP_SETTINGS_SCHEMA_VERSION = 1 as const;

export type AppTheme = 'system' | 'dark';
export type AppDensity = 'compact' | 'comfortable';
export type SettingsProjectionMode = 'perspective' | 'orthographic';
export type SettingsDisplayMode = 'shaded-edges' | 'shaded' | 'wireframe';
export type AssistantProvider =
  'openrouter' | 'openai' | 'responses-compatible';
export type AssistantCredentialSource = 'deployment' | 'personal';
export type AssistantReasoningEffort =
  'provider-default' | 'off' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Global user preferences. These never belong to ProjectDocument: project
 * geometry/history stays portable and collaboration-safe when preferences
 * change on one device.
 */
export interface AppSettings {
  schemaVersion: typeof APP_SETTINGS_SCHEMA_VERSION;
  general: {
    reopenLastProject: boolean;
    defaultUnits: UnitSystem;
    confirmDestructiveActions: boolean;
  };
  appearance: {
    theme: AppTheme;
    density: AppDensity;
    reducedMotion: boolean;
  };
  viewport: {
    defaultProjection: SettingsProjectionMode;
    showGrid: boolean;
    displayMode: SettingsDisplayMode;
  };
  sketching: {
    snapEnabled: boolean;
    linearSnap: number;
    angleSnap: number;
  };
  assistant: {
    enabled: boolean;
    credentialSource: AssistantCredentialSource;
    provider: AssistantProvider;
    baseUrl: string;
    model: string;
    reasoningEffort: AssistantReasoningEffort;
    maxOutputTokens: number;
    timeoutMs: number;
    customInstructions: string;
  };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  schemaVersion: APP_SETTINGS_SCHEMA_VERSION,
  general: {
    reopenLastProject: true,
    defaultUnits: 'mm',
    confirmDestructiveActions: true
  },
  appearance: {
    theme: 'system',
    density: 'compact',
    reducedMotion: false
  },
  viewport: {
    defaultProjection: 'perspective',
    showGrid: true,
    displayMode: 'shaded-edges'
  },
  sketching: {
    snapEnabled: true,
    linearSnap: 1,
    angleSnap: 15
  },
  assistant: {
    enabled: true,
    credentialSource: 'deployment',
    provider: 'openrouter',
    baseUrl: '',
    model: 'openai/gpt-5.6-terra',
    reasoningEffort: 'high',
    maxOutputTokens: 32_000,
    timeoutMs: 120_000,
    customInstructions: ''
  }
};

export interface AssistantCredentialMetadata {
  stored: boolean;
  hint?: string;
  updatedAt?: string;
  lastValidatedAt?: string;
  storageAvailable: boolean;
}

export interface EffectiveAssistantSettings {
  configured: boolean;
  source: AssistantCredentialSource;
  provider: AssistantProvider;
  model: string;
  reasoningEffort: string;
}

export interface AppSettingsResponse {
  settings: AppSettings;
  revision: number;
  synced: boolean;
  credential: AssistantCredentialMetadata;
  effectiveAssistant: EffectiveAssistantSettings;
}

export interface UpdateAppSettingsRequest {
  settings: AppSettings;
  expectedRevision: number;
}

export interface SaveAssistantCredentialRequest {
  token: string;
}

export interface CollaborationMember {
  clientId: string;
  userId: UserId;
  displayName: string;
  status: 'active' | 'idle';
}

export type CollaborationClientMessage =
  | {
      type: 'hello';
      clientId: string;
      displayName: string;
      baseVersion: number | null;
      document: ProjectDocument | null;
    }
  | {
      type: 'document';
      clientId: string;
      baseVersion: number | null;
      document: ProjectDocument;
    }
  | { type: 'presence'; clientId: string; status: 'active' | 'idle' };

export type CollaborationServerMessage =
  | {
      type: 'state';
      members: CollaborationMember[];
      document: ProjectDocument | null;
    }
  | { type: 'presence'; members: CollaborationMember[] }
  | { type: 'document'; clientId: string; document: ProjectDocument }
  /**
   * Acknowledges an accepted submission. `document` is present only when the
   * resolved document differs from what the sender submitted (a server-side
   * merge), because the merged state is broadcast to every *other* socket and
   * would otherwise never reach the sender.
   */
  | { type: 'ack'; version: number; document?: ProjectDocument }
  | { type: 'conflict'; document: ProjectDocument };

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
export const toAssetId = (value: string): AssetId => value as AssetId;

export const DEFAULT_BODY_COLOR = '#e1a948';

export const FEATURE_COLORS: Record<FeatureKind, string> = {
  primitive: '#e1a948',
  sketch: DEFAULT_BODY_COLOR,
  extrude: '#4bb7a7',
  revolve: '#5fb3e8',
  boolean: '#ff7452',
  transform: '#8b80f9',
  fillet: '#f59e0b',
  chamfer: '#fb7185',
  pattern: '#38bdf8',
  'direct-edit': '#2dd4bf',
  'imported-step': '#d6a653',
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
