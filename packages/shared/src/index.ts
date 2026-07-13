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

export type UnitSystem = 'mm' | 'cm' | 'm' | 'inch';
export type PlaneId = 'XY' | 'XZ' | 'YZ';
export type PrimitiveKind = 'box' | 'cylinder' | 'sphere';
export type FeatureKind =
  | 'primitive'
  | 'sketch'
  | 'extrude'
  | 'boolean'
  | 'transform'
  | 'imported-mesh';
export type SketchObjectKind = 'line' | 'rectangle' | 'circle';
export type ConstraintKind =
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'distance'
  | 'radius'
  | 'diameter';
export type BooleanOperation = 'union' | 'subtract' | 'intersect';
export type EditableDimension = 'width' | 'height' | 'depth' | 'radius';

export interface FilletDefinition {
  radius: number;
  edgeIds: string[];
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Transform3D {
  translation: Vector3;
  rotationDeg: Vector3;
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
  objectIds: EntityId[];
  constraintIds: EntityId[];
}

export interface SketchObjectNode extends BaseNode {
  kind: 'sketch-object';
  objectKind: SketchObjectKind;
  data:
    | {
        objectKind: 'line';
        start: { x: number; y: number };
        end: { x: number; y: number };
      }
    | {
        objectKind: 'rectangle';
        width: number;
        height: number;
      }
    | {
        objectKind: 'circle';
        radius: number;
      };
}

export interface ConstraintNode extends BaseNode {
  kind: 'constraint';
  constraintKind: ConstraintKind;
  targetIds: EntityId[];
  value?: number;
}

export interface FeatureNode extends BaseNode {
  kind: 'feature';
  featureId: FeatureId;
  featureKind: FeatureKind;
  bodyId?: BodyId;
  data:
    | {
        featureKind: 'primitive';
        primitiveKind: PrimitiveKind;
        dimensions: Record<string, number>;
        fillet?: FilletDefinition;
      }
    | {
        featureKind: 'sketch';
        sketchId: SketchId;
      }
    | {
        featureKind: 'extrude';
        sketchId: SketchId;
        distance: number;
        fillet?: FilletDefinition;
      }
    | {
        featureKind: 'boolean';
        operation: BooleanOperation;
        targetBodyIds: BodyId[];
      }
    | {
        featureKind: 'transform';
        targetBodyId: BodyId;
        transform: Transform3D;
      }
    | {
        featureKind: 'imported-mesh';
        artifactId: ArtifactId;
        sourceName: string;
        triangleCount: number;
      };
}

export interface BodyNode extends BaseNode {
  kind: 'body';
  bodyId: BodyId;
  featureId: FeatureId;
  bodyType: 'solid' | 'mesh-reference';
  representationSource: 'mock' | 'native' | 'mesh-reference' | 'composite';
  exportableStep: boolean;
}

export type DocumentNode =
  | ProjectNode
  | AssemblyNode
  | PartNode
  | ParameterNode
  | SketchNode
  | SketchObjectNode
  | ConstraintNode
  | FeatureNode
  | BodyNode;

export interface PrimitiveGeometry {
  kind: PrimitiveKind;
  dimensions: Record<string, number>;
  fillet?: FilletDefinition;
}

export interface MeshGeometry {
  kind: 'mesh';
  vertices: number[];
  indices: number[];
}

export interface CompositeGeometry {
  kind: 'composite';
  operation: BooleanOperation;
  children: BodyRepresentation[];
}

export type DisplayGeometry =
  | PrimitiveGeometry
  | MeshGeometry
  | CompositeGeometry;

export interface BodyRepresentation {
  bodyId: BodyId;
  name: string;
  source: FeatureKind;
  geometry: DisplayGeometry;
  transform: Transform3D;
  color: string;
  exportableStep: boolean;
}

export interface RevisionRecord {
  revisionId: RevisionId;
  createdAt: string;
  reason: string;
  commandCount: number;
}

export interface DerivedState {
  bodyRepresentations: Record<BodyId, BodyRepresentation>;
  exportableBodyIds: BodyId[];
  warnings: string[];
  updatedAt: string;
}

export interface ProjectDocument {
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
  revisions: RevisionRecord[];
  commandLog: SerializedCommand[];
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
  kind:
    | 'thumbnail'
    | 'validation'
    | 'import'
    | 'export'
    | 'analysis'
    | 'generative';
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
export const toRevisionId = (value: string): RevisionId => value as RevisionId;
export const toArtifactId = (value: string): ArtifactId => value as ArtifactId;
export const toUploadSessionId = (value: string): UploadSessionId =>
  value as UploadSessionId;
export const toUserId = (value: string): UserId => value as UserId;
export const toJobId = (value: string): JobId => value as JobId;

export const DEFAULT_BODY_COLOR = '#e1a948';
