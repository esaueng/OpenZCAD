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

export const PROJECT_DOCUMENT_SCHEMA_VERSION = 7 as const;
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
  | 'mirror'
  | 'shell'
  | 'solid-offset'
  | 'fillet'
  | 'chamfer'
  | 'pattern'
  | 'direct-edit'
  | 'imported-step'
  | 'imported-mesh';
export type SketchObjectKind =
  'rectangle' | 'circle' | 'polygon' | 'line' | 'arc' | 'text';
/**
 * Font style of a text sketch object. Each style is a distinct bundled font
 * file — never a synthetic shear or emboldening — so the letterforms are the
 * ones the type designer drew.
 */
export type TextFontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';
export type TextAlign = 'left' | 'center' | 'right';
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

/** Integer coordinates measured in the frozen ADR-011 1e-6 document-unit quantum. */
export type QuantizedTopologyPoint = [number, number, number];

export type ParametricClosure = 'open' | 'closed' | 'unknown';

/** Exact, phase-independent inputs used to fingerprint one edge. */
export type EdgeWitnessV1 = {
  curveType: string;
  length: number;
} & (
  | {
      closed: false;
      endpoints: [QuantizedTopologyPoint, QuantizedTopologyPoint];
      midpoint: QuantizedTopologyPoint;
    }
  | {
      closed: true;
      center: QuantizedTopologyPoint;
      /** Canonical direction in the ADR-011 direction quantum, or null when degenerate. */
      axis: QuantizedTopologyPoint | null;
    }
);

/** Exact analytic carrier term used by a face witness. */
export type FaceAnalyticWitnessV1 =
  | {
      kind: 'plane';
      normal: QuantizedTopologyPoint;
      offset: number;
    }
  | {
      kind: 'cylinder';
      axis: QuantizedTopologyPoint;
      axisFoot: QuantizedTopologyPoint;
      radius: number;
    }
  | { kind: 'none' };

/** Exact, kernel-neutral inputs used to fingerprint one face. */
export interface FaceWitnessV1 {
  surfaceType: string;
  perimeter: number;
  centroid: QuantizedTopologyPoint | null;
  analytic: FaceAnalyticWitnessV1;
  closure: { u: ParametricClosure; v: ParametricClosure };
}

interface TopologyReferenceBaseV5 {
  producingFeatureId: FeatureId;
  /** Stable semantic/evolution name scoped by producingFeatureId. */
  lineageName: string;
  /** ADR-011 fingerprint at the time this reference was written. */
  currentHash: number;
  witnessVersion: 1;
}

export interface EdgeTopologyReferenceV5 extends TopologyReferenceBaseV5 {
  kind: 'edge';
  witness: EdgeWitnessV1;
}

export interface FaceTopologyReferenceV5 extends TopologyReferenceBaseV5 {
  kind: 'face';
  witness: FaceWitnessV1;
}

export type TopologyReferenceV5 =
  EdgeTopologyReferenceV5 | FaceTopologyReferenceV5;

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

/** Parametric plane used by exact mirror features. */
export interface ParametricPlane {
  origin: ParametricVector3;
  /** Resolved and normalized during exact preflight; zero vectors are invalid. */
  normal: ParametricVector3;
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
      faceReference?: FaceTopologyReferenceV5;
      sourceDiameter: number;
      sourceAxisStart: Vector3;
      sourceAxisEnd: Vector3;
      diameter: ParamValue;
    }
  | {
      kind: 'remove-face-feature';
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      sourceSurfaceType: string;
      sourceArea: number;
      sourceCenter: Vector3;
      sourceDiameter?: number;
      sourceAxisStart?: Vector3;
      sourceAxisEnd?: Vector3;
    }
  | {
      kind: 'offset-face';
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      sourceSurfaceType: 'plane';
      sourceArea: number;
      sourceCenter: Vector3;
      /** Outward unit normal the offset moves along. */
      sourceNormal: Vector3;
      /** Signed distance along sourceNormal; positive adds material. */
      offset: ParamValue;
    }
  | {
      kind: 'resize-cylindrical-face';
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      sourceRadius: number;
      sourceAxisStart: Vector3;
      sourceAxisEnd: Vector3;
      /** Whether the wall faces material inward (hole) or outward (boss). */
      concavity: 'hole' | 'boss';
      radius: ParamValue;
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

/**
 * An orthonormal right-handed frame (xAxis × yAxis = zAxis) positioning a
 * sketch plane in model space. Axes are unit vectors; `zAxis` is the plane
 * normal profiles extrude along.
 */
export interface SketchPlaneFrame {
  origin: Vector3;
  xAxis: Vector3;
  yAxis: Vector3;
  zAxis: Vector3;
}

/**
 * Where a sketch plane lives. `canonical` is the classic principal plane +
 * normal offset. `frame` is an arbitrary placed plane. `face` records that the
 * plane was taken from a body face. Schema-v5 `faceReference` lineage is
 * authoritative for exact rebuilds: the frame is re-derived from the evolved
 * planar face at the sketch's history position and fails closed if that face
 * is deleted, ambiguous, or non-planar. The embedded frame remains only for
 * schema-v4 migration and diagnostics; it is never a fallback for a v5 ref.
 */
export type SketchPlaneRef =
  | { type: 'canonical'; plane: PlaneId; offset: ParamValue }
  | { type: 'frame'; frame: SketchPlaneFrame }
  | {
      type: 'face';
      bodyId: BodyId;
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      sourceArea: number;
      sourceCenter: Vector3;
      sourceNormal: Vector3;
      frame: SketchPlaneFrame;
    };

export interface SketchNode extends BaseNode {
  kind: 'sketch';
  sketchId: SketchId;
  planeRef: SketchPlaneRef;
  /** @deprecated Schema v3 field; superseded by `planeRef`. Kept so legacy documents parse. */
  plane?: PlaneId;
  /** @deprecated Schema v3 field; superseded by `planeRef`. Kept so legacy documents parse. */
  offset?: ParamValue;
  objectIds: EntityId[];
}

export type SketchObjectData = (
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
    }
  | {
      objectKind: 'line';
      x1: ParamValue;
      y1: ParamValue;
      x2: ParamValue;
      y2: ParamValue;
    }
  | {
      objectKind: 'arc';
      centerX: ParamValue;
      centerY: ParamValue;
      radius: ParamValue;
      /** Counter-clockwise sweep from start to end, in degrees. */
      startAngleDeg: ParamValue;
      endAngleDeg: ParamValue;
    }
  | {
      objectKind: 'text';
      /**
       * The string to render. Glyph outlines are never persisted — they are
       * re-derived from these parameters on every rebuild, so editing the
       * string regenerates every downstream feature.
       */
      text: string;
      /** Registry family id, e.g. `'open-sans'`. */
      fontFamily: string;
      fontStyle: TextFontStyle;
      /** Em size in model units. Parametric like every other dimension. */
      size: ParamValue;
      /** Sketch-plane origin of the first baseline. */
      x: ParamValue;
      y: ParamValue;
      /** Rotation about (`x`, `y`) in degrees. */
      rotation?: ParamValue;
      /** Horizontal alignment of each line about `x`. Defaults to `'left'`. */
      align?: TextAlign;
    }
) & {
  /**
   * Reference-only geometry. Construction entities remain visible and
   * snappable but never split curves or bound a solid profile.
   */
  construction?: boolean;
};

export interface SketchObjectNode extends BaseNode {
  kind: 'sketch-object';
  objectKind: SketchObjectKind;
  data: SketchObjectData;
}

/** In-sketch axis a revolve sweeps the profile around. */
export type RevolveAxis = 'horizontal' | 'vertical';

/**
 * Persistent reference to one derived bounded sketch cell.
 *
 * `profileId` is the preferred stable identity for newly created references.
 * The fingerprint/sample/area fields retain fail-closed compatibility with
 * profile references written before first-class profile ids were introduced.
 */
export interface SketchRegionProfileReference {
  profileId?: string;
  regionFingerprint: number;
  samplePoint: { x: number; y: number };
  sourceArea: number;
  sourceEntityIds?: string[];
  /** Discriminator; a region reference never carries the entity-wide mode. */
  all?: false;
}

/**
 * Reference to *every* profile bounded solely by the named sketch entities,
 * however many there are and whatever their geometry.
 *
 * Geometry-derived identity (fingerprint, area, sample point) cannot survive an
 * edit that changes how many regions an entity produces — changing a text
 * object from "HI" to "HELLO" changes the region count, every fingerprint, and
 * every area at once. Entity identity does survive: the sketch object's
 * `EntityId` is stable across every edit to its parameters. This mode exists so
 * a text extrude keeps working after the exact edit the text feature is for.
 *
 * Resolution is still fail-closed: an entity that currently bounds no profile
 * is an error, not an empty extrude.
 */
export interface SketchEntityProfileReference {
  all: true;
  /** Profiles qualify when their source entities are a subset of these ids. */
  sourceEntityIds: string[];
}

export type SketchProfileReference =
  SketchRegionProfileReference | SketchEntityProfileReference;

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
      /**
       * When present, extrudes one detected closed region of the sketch
       * instead of the whole profile. Resolution fails closed: if neither the
       * fingerprint nor the sample point + area match a current region, the
       * rebuild reports a warning rather than guessing.
       */
      profile?: SketchProfileReference;
      /**
       * First-class multi-profile selection. Adjacent cells are fused into
       * one exact solid; disconnected cells remain distinct solids owned by
       * the same feature. `profile` remains readable for older documents.
       */
      profiles?: SketchProfileReference[];
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
      featureKind: 'mirror';
      targetBodyId: BodyId;
      /** The original remains live; this feature owns only the mirrored copy. */
      plane: ParametricPlane;
    }
  | {
      featureKind: 'shell';
      targetBodyId: BodyId;
      openingFaceHashes: number[];
      openingFaceReferences?: FaceTopologyReferenceV5[];
      /** Positive inward wall thickness; the source outer envelope is retained. */
      thickness: ParamValue;
    }
  | {
      featureKind: 'solid-offset';
      targetBodyId: BodyId;
      /** Positive values offset every face outward. */
      distance: ParamValue;
    }
  | {
      featureKind: 'fillet';
      targetBodyId: BodyId;
      edgeHashes: number[];
      edgeReferences?: EdgeTopologyReferenceV5[];
      radius: ParamValue;
    }
  | {
      featureKind: 'chamfer';
      targetBodyId: BodyId;
      edgeHashes: number[];
      edgeReferences?: EdgeTopologyReferenceV5[];
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
  reference?: FaceTopologyReferenceV5;
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
  /** Outward unit normal; present for exact planar surfaces. */
  normal?: Vector3;
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
  reference?: EdgeTopologyReferenceV5;
  /**
   * Periodic B-Rep faces need topological seam edges to close their UV
   * parameterization. They remain available to the kernel for stable topology
   * identity, but are not physical feature edges and stay out of the viewport.
   */
  displayRole?: 'feature' | 'seam';
  /**
   * Hashes of the faces this edge bounds, sorted ascending.
   *
   * This is the kernel's own edge-to-face map translated from face handles to
   * the ADR-011 hashes `FaceTopology.hash` publishes, so a consumer can ask
   * which faces meet at an edge without a second kernel round trip. It exists
   * for topological edge-run walking and measure tools, which currently infer
   * adjacency from geometry.
   *
   * Three things it is NOT:
   *
   * - **Not a pair.** A seam edge lists its one face twice, and a non-manifold
   *   edge on a flagged STEP import lists three or more. Multiplicity is kept
   *   rather than deduplicated, because it is the raw fact and a consumer can
   *   always narrow it.
   * - **Not unique per face.** BrepKit builds a sphere from two same-surface
   *   hemispheres that share one exact witness, so both patches hash
   *   identically. Two edges reporting a common hash therefore do not
   *   necessarily touch the same face. This is the identity scheme failing
   *   closed as designed, and it is a live product limit — face picks on
   *   spheres are unavailable for the same reason.
   * - **Not sufficient for an edge run on its own.** Two edges on opposite
   *   sides of a box's top face share that face. A run also needs vertex
   *   incidence, which nothing publishes yet.
   */
  adjacentFaceHashes?: number[];
  /**
   * XYZ-interleaved display polyline sampled from the exact edge curve.
   * Closed feature edges repeat their first point so the viewport draws the
   * closing segment.
   */
  points: number[];
}

export interface BodyTopology {
  faces: FaceTopology[];
  edges: EdgeTopology[];
  lineageDiagnostics?: TopologyLineageDiagnostic[];
}

export interface TopologyLineageDiagnostic {
  kind: 'edge' | 'face' | 'body';
  status:
    'hash-only' | 'deleted' | 'split' | 'merged' | 'ambiguous' | 'unsupported';
  featureId?: FeatureId;
  topologyId?: string;
  message: string;
}

export interface TopologySelection {
  bodyId: BodyId;
  kind: 'body' | 'face' | 'edge';
  topologyId?: string;
  hash?: number;
  /** Present when the kernel can prove a schema-v5 persistent reference. */
  reference?: TopologyReferenceV5;
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

/**
 * Which shelf a project sits on. `deleted` is the recycle bin: the project is
 * hidden from the parts grid but still fully restorable until it is purged.
 */
export type ProjectStatus = 'active' | 'archived' | 'deleted';

export const PROJECT_STATUSES: readonly ProjectStatus[] = [
  'active',
  'archived',
  'deleted'
];

/**
 * Shelf state for a project: where it lives and in what order it is shown.
 * Kept apart from the project itself because it describes the owner's desk,
 * not the part — nothing here changes the geometry or the revision history.
 */
export interface ProjectOrganization {
  status: ProjectStatus;
  /** Pinned projects lead their shelf regardless of manual order. */
  pinned: boolean;
  /** Manual drag order within a shelf; lower sorts first. */
  sortOrder: number;
  /** When the project entered the recycle bin, if it is in there. */
  deletedAt?: string;
  /** When the project was archived, if it is archived. */
  archivedAt?: string;
}

export const DEFAULT_PROJECT_ORGANIZATION: ProjectOrganization = {
  status: 'active',
  pinned: false,
  sortOrder: 0
};

export interface ProjectSummary {
  projectId: ProjectId;
  name: string;
  lastRevisionId?: RevisionId;
  revisionCount: number;
  updatedAt: string;
  /**
   * Absent when the store holding this summary has no shelf state for the
   * project — an older row, or a device that has never organised it. Read it
   * through {@link projectOrganization} so a missing record reads as defaults
   * instead of silently overwriting one that does exist elsewhere.
   */
  organization?: ProjectOrganization;
}

/**
 * Folds a partial shelf edit into the current state. The archived/deleted
 * timestamps are owned by this function rather than by callers so that they
 * always mean "when it entered this shelf": moving straight from the archive
 * to the bin restamps `deletedAt`, restoring clears both, and the retention
 * countdown always measures from the move that put the project there.
 */
export function applyOrganizationUpdate(
  current: ProjectOrganization,
  update: Pick<UpdateProjectRequest, 'status' | 'pinned' | 'sortOrder'>,
  now = nowIso()
): ProjectOrganization {
  const status = update.status ?? current.status;
  const next: ProjectOrganization = {
    status,
    pinned: update.pinned ?? current.pinned,
    sortOrder: update.sortOrder ?? current.sortOrder
  };
  if (status === 'deleted') {
    next.deletedAt =
      current.status === 'deleted' ? (current.deletedAt ?? now) : now;
  }
  if (status === 'archived') {
    next.archivedAt =
      current.status === 'archived' ? (current.archivedAt ?? now) : now;
  }
  return next;
}

/** Shelf state of a summary, with the defaults applied. */
export function projectOrganization(
  summary: Pick<ProjectSummary, 'organization'>
): ProjectOrganization {
  return summary.organization ?? DEFAULT_PROJECT_ORGANIZATION;
}

/** How long a deleted project stays restorable before it is purged. */
export const TRASH_RETENTION_DAYS = 30;
export const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** When a project deleted at `deletedAt` becomes eligible for purging. */
export function trashPurgeAt(deletedAt: string): string {
  return new Date(Date.parse(deletedAt) + TRASH_RETENTION_MS).toISOString();
}

/** Whole days left before a deleted project is purged; 0 once it is due. */
export function daysUntilPurge(deletedAt: string, now = Date.now()): number {
  const remaining = Date.parse(deletedAt) + TRASH_RETENTION_MS - now;
  return remaining <= 0 ? 0 : Math.ceil(remaining / (24 * 60 * 60 * 1000));
}

/**
 * True once a deleted project has outlived the retention window. An unparsable
 * timestamp is treated as *not* due: a purge is irreversible, so a corrupt
 * record has to be looked at rather than quietly destroyed.
 */
export function isPurgeDue(deletedAt: string | undefined, now = Date.now()) {
  if (!deletedAt) {
    return false;
  }
  const parsed = Date.parse(deletedAt);
  return Number.isFinite(parsed) && parsed + TRASH_RETENTION_MS <= now;
}

/**
 * Shelf order: pinned first, then the manual drag order, then most recently
 * touched. The project id breaks the final tie so the sort is total — without
 * it two projects saved in the same millisecond could swap places per render.
 */
export function compareProjectSummaries(
  left: ProjectSummary,
  right: ProjectSummary
): number {
  const a = projectOrganization(left);
  const b = projectOrganization(right);
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  if (a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }
  const byUpdated = right.updatedAt.localeCompare(left.updatedAt);
  return byUpdated !== 0
    ? byUpdated
    : left.projectId.localeCompare(right.projectId);
}

const COPY_SUFFIX_PATTERN = /\s*\(copy(?: (\d+))?\)$/i;

/**
 * Name for a copy of `baseName` that does not collide with `existingNames`.
 * Duplicating a duplicate extends the existing counter rather than nesting
 * another "(copy)", so a part copied five times is not called
 * "Bracket (copy) (copy) (copy) (copy) (copy)".
 */
export function duplicateProjectName(
  baseName: string,
  existingNames: Iterable<string>
): string {
  const taken = new Set(
    [...existingNames].map((name) => name.trim().toLowerCase())
  );
  const root = baseName.trim().replace(COPY_SUFFIX_PATTERN, '') || 'Untitled';
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? ' (copy)' : ` (copy ${index})`;
    // The suffix is what makes the name unique, so the root is what gives way
    // when the pair would exceed the limit.
    const candidate =
      `${root.slice(0, MAX_PROJECT_NAME_LENGTH - suffix.length)}${suffix}`.trim();
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
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

/** Partial shelf-state edit; omitted fields are left as they are. */
export interface UpdateProjectRequest {
  projectId: ProjectId;
  status?: ProjectStatus;
  pinned?: boolean;
  sortOrder?: number;
}

export interface UpdateProjectResponse {
  project: ProjectSummary;
}

export interface DuplicateProjectRequest {
  projectId: ProjectId;
  /** Defaults to a non-colliding "(copy)" of the source name. */
  name?: string;
}

export type DuplicateProjectResponse = CreateProjectResponse;

/**
 * The projects to renumber, in their new order. Ids the caller leaves out keep
 * whatever position they had, so one shelf can be reordered without disturbing
 * the others.
 */
export interface ReorderProjectsRequest {
  projectIds: ProjectId[];
}

export type ReorderProjectsResponse = ListProjectsResponse;

export interface PurgeProjectsResponse {
  /** Projects destroyed because their retention window ran out. */
  purgedProjectIds: ProjectId[];
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
  /** Public rollout capability; absent older Workers are treated as disabled. */
  projectSharingEnabled?: boolean;
  /** Public rollout capability; absent older Workers are treated as disabled. */
  projectEditLeasesEnforced?: boolean;
}

export interface AuthSession {
  userId: UserId;
  displayName: string;
  email?: string;
  mode: 'development' | 'email-code';
}

export interface AuthConfigResponse {
  mode: 'development' | 'email-code' | 'unconfigured';
  emailCodeEnabled: boolean;
  turnstileSiteKey?: string;
}

export interface StartEmailLoginRequest {
  email: string;
  turnstileToken: string;
}

export interface StartEmailLoginResponse {
  challengeId: string;
  expiresInSeconds: number;
}

export interface VerifyEmailLoginRequest {
  challengeId: string;
  code: string;
}

export const APP_SETTINGS_SCHEMA_VERSION = 1 as const;

export type AppTheme = 'system' | 'dark';
export type AppDensity = 'compact' | 'comfortable';
export type SettingsProjectionMode = 'perspective' | 'orthographic';
export type SettingsDisplayMode = 'shaded-edges' | 'shaded' | 'wireframe';
export type SettingsMiddleDrag = 'pan' | 'orbit' | 'zoom';
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
    /** Wheel zoom moves toward the pointer rather than the orbit target. */
    zoomToCursor: boolean;
    /** What a middle-button drag does: pan, orbit, or zoom. */
    middleDrag: SettingsMiddleDrag;
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
  experiments: {
    /** Selection-first direct manipulation: click geometry, drag handles. */
    directManipulation: boolean;
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
    displayMode: 'shaded-edges',
    zoomToCursor: true,
    middleDrag: 'pan'
  },
  sketching: {
    snapEnabled: true,
    linearSnap: 1,
    angleSnap: 15
  },
  assistant: {
    enabled: false,
    credentialSource: 'deployment',
    provider: 'openrouter',
    baseUrl: '',
    model: 'openai/gpt-5.6-terra',
    reasoningEffort: 'high',
    maxOutputTokens: 32_000,
    timeoutMs: 120_000,
    customInstructions: ''
  },
  experiments: {
    directManipulation: true
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

export type ProjectAccessRole = 'owner' | 'editor' | 'viewer';
export type ProjectMemberRole = Exclude<ProjectAccessRole, 'owner'>;

export interface ProjectSharingMember {
  userId: UserId;
  email: string | null;
  role: ProjectMemberRole;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectInvitationSummary {
  invitationId: string;
  projectId: string;
  email: string;
  role: ProjectMemberRole;
  createdAt: number;
  expiresAt: number;
}

export interface ProjectSharingResponse {
  projectId: string;
  ownerUserId: UserId;
  members: ProjectSharingMember[];
  invitations: ProjectInvitationSummary[];
}

export interface CreateProjectInvitationRequest {
  email: string;
  role: ProjectMemberRole;
}

export interface CreateProjectInvitationResponse {
  invitation: ProjectInvitationSummary;
  /** Returned only once. Persistence stores only its SHA-256 hash. */
  token: string;
}

export interface AcceptProjectInvitationRequest {
  token: string;
}

export interface AcceptProjectInvitationResponse {
  projectId: string;
  role: ProjectMemberRole;
}

export interface ProjectEditLease {
  leaseId: string;
  projectId: string;
  clientId: string;
  userId: UserId;
  expiresAt: number;
}

export type CollaborationClientMessage =
  | {
      type: 'hello';
      clientId: string;
      displayName: string;
      baseVersion: number | null;
      document: ProjectDocument | null;
      leaseId?: string;
    }
  | {
      type: 'document';
      clientId: string;
      baseVersion: number | null;
      document: ProjectDocument;
      leaseId?: string;
    }
  | { type: 'presence'; clientId: string; status: 'active' | 'idle' }
  | { type: 'lease-acquire'; clientId: string }
  | { type: 'lease-renew'; clientId: string; leaseId: string }
  | { type: 'lease-release'; clientId: string; leaseId: string };

export type CollaborationServerMessage =
  | {
      type: 'state';
      members: CollaborationMember[];
      document: ProjectDocument | null;
      role: ProjectAccessRole;
      lease: ProjectEditLease | null;
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
  | { type: 'conflict'; document: ProjectDocument }
  | { type: 'lease-granted'; lease: ProjectEditLease }
  | {
      type: 'lease-denied';
      reason: 'held' | 'read-only';
      expiresAt?: number;
    }
  | {
      type: 'lease-lost';
      reason: 'expired' | 'released' | 'role-changed' | 'invalid';
    }
  /**
   * A submission the room refused outright. Room state is unchanged, so the
   * sender keeps its own document rather than reporting itself synced against
   * state the room never took.
   */
  | { type: 'error'; code: CollaborationErrorCode; message: string };

export type CollaborationErrorCode =
  /** Larger than a single durable-storage value can hold. */
  | 'document-too-large'
  /** Nested or numerous past what the room will walk. */
  | 'document-too-complex'
  /** Not a document-shaped payload at all. */
  | 'document-invalid'
  /** The authenticated project role cannot author room state. */
  | 'permission-denied'
  /** Lease enforcement is enabled and no matching live lease was supplied. */
  | 'lease-required'
  /** The room failed while handling an otherwise well-formed message. */
  | 'internal';

/**
 * Longest accepted project name, measured after trimming. Shared so the client
 * can block an over-long name before submitting it rather than discovering the
 * limit from a rejected request.
 */
export const MAX_PROJECT_NAME_LENGTH = 200;

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
  mirror: '#a78bfa',
  shell: '#14b8a6',
  'solid-offset': '#06b6d4',
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
