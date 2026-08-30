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
export type SketchConstraintId = Brand<string, 'SketchConstraintId'>;
export type ShaprImportId = Brand<string, 'ShaprImportId'>;

export const PROJECT_DOCUMENT_SCHEMA_VERSION = 13 as const;
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
  | 'loft'
  | 'sweep'
  | 'helical-sweep'
  | 'boolean'
  | 'transform'
  | 'mirror'
  | 'shell'
  | 'solid-offset'
  | 'draft'
  | 'thicken'
  | 'fillet'
  | 'chamfer'
  | 'pattern'
  | 'split'
  | 'hole'
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
export type PatternKind = 'linear' | 'circular' | 'grid';
export type AxisId = 'x' | 'y' | 'z';

/**
 * A parametric scalar: either a literal number or an expression string that is
 * evaluated against the document's parameter table when geometry is rebuilt
 * (e.g. `"width / 2 + 5"`). Storing the raw expression keeps features fully
 * parametric — editing a parameter regenerates every feature that uses it.
 */
export type ParamValue = number | string;
export const MAX_SKETCH_POLYGON_SIDES = 64;
export const MAX_SKETCH_ARC_SWEEP_DEGREES = 360;
export const MAX_HELICAL_SWEEP_TURNS = 100;

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
  /**
   * Uniform scale factor about the world origin, applied before rotation and
   * translation. Absent means 1 (no scaling); the rebuild rejects values that
   * do not resolve to a positive finite number. Uniform only: the exact
   * kernel preserves analytic surfaces under conformal maps, and a
   * non-uniform factor would silently degrade cylinders to NURBS.
   */
  scale?: ParamValue;
}

/** Parametric plane used by exact mirror features. */
export interface ParametricPlane {
  origin: ParametricVector3;
  /** Resolved and normalized during exact preflight; zero vectors are invalid. */
  normal: ParametricVector3;
}

export type FaceDistanceMoveMode =
  'symmetric' | 'one-sided-first' | 'one-sided-second';

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
      /**
       * An auto-parameterization binding may deliberately start at the source
       * diameter. The exact adapter keeps the source solid unchanged until the
       * named parameter moves; ordinary resize gestures still reject no-ops.
       */
      parameterBinding?: true;
    }
  | {
      kind: 'resize-imported-blind-hole';
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      sourceOpeningPoint: Vector3;
      /** Unit direction from the opening toward the blind floor. */
      sourceAxisDirection: Vector3;
      sourceDiameter: number;
      sourceDepth: number;
      diameter: ParamValue;
      depth: ParamValue;
      parameterBinding?: true;
    }
  | {
      kind: 'resize-imported-counterbore';
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      sourceOpeningPoint: Vector3;
      /** Unit direction from the opening toward the blind floor. */
      sourceAxisDirection: Vector3;
      sourceBoreDiameter: number;
      sourceCounterboreDiameter: number;
      sourceCounterboreDepth: number;
      sourceTotalDepth: number;
      sourceEntryChamfered: boolean;
      boreDiameter: ParamValue;
      counterboreDiameter: ParamValue;
      counterboreDepth: ParamValue;
      parameterBinding?: true;
    }
  | {
      kind: 'resize-imported-countersink';
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      sourceOpeningPoint: Vector3;
      /** Unit direction from the opening toward the blind floor. */
      sourceAxisDirection: Vector3;
      sourceBoreDiameter: number;
      sourceSinkDiameter: number;
      /** Full included angle, in radians, matching the recognition proof. */
      sourceAngleRadians: number;
      sourceCountersinkDepth: number;
      sourceTotalDepth: number;
      boreDiameter: ParamValue;
      sinkDiameter: ParamValue;
      angleRadians: ParamValue;
      parameterBinding?: true;
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
      kind: 'set-face-distance';
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      oppositeFaceHash: number;
      oppositeFaceReference?: FaceTopologyReferenceV5;
      /** Exact perpendicular separation recorded when the binding is made. */
      sourceDistance: number;
      /** The checkpointed changed-value proof fixes which face group moves. */
      moveMode: FaceDistanceMoveMode;
      distance: ParamValue;
      /** Auto-parameterization may deliberately begin as an exact no-op. */
      parameterBinding?: true;
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
    }
  | {
      kind: 'resize-blend';
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      /** Exact analytic carrier recorded when the edit was authored. */
      surfaceClass: 'torus' | 'cylinder';
      recordedRadius: number;
      /** Torus centre or a point on the cylinder axis. */
      recordedCenter: Vector3;
      /** Unoriented unit carrier axis. */
      recordedAxis: Vector3;
      /** Zero removes the analytic blend band and restores its sharp edge. */
      newRadius: ParamValue;
      /**
       * An auto-parameterization binding may start at the recorded radius.
       * The exact adapter still re-proves the seed and complete region, then
       * leaves the source solid unchanged until the parameter moves.
       */
      parameterBinding?: true;
    };

export interface BaseNode {
  id: EntityId;
  parentId: EntityId | null;
  revisionId: RevisionId | null;
  name: string;
  metadata?: Record<string, string | number | boolean>;
}

/** Replay-compatible metadata keys used by feature suppression. */
export const FEATURE_SUPPRESSED_METADATA_KEY = 'suppressed' as const;
export const FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY =
  'rollbackSuppressed' as const;

/** Replay-compatible metadata keys for per-body display appearance. */
export const BODY_COLOR_METADATA_KEY = 'color' as const;
export const BODY_OPACITY_METADATA_KEY = 'opacity' as const;

export function isFeatureManuallySuppressed(
  node: Pick<BaseNode, 'metadata'>
): boolean {
  return node.metadata?.[FEATURE_SUPPRESSED_METADATA_KEY] === true;
}

export function isFeatureRollbackSuppressed(
  node: Pick<BaseNode, 'metadata'>
): boolean {
  return node.metadata?.[FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY] === true;
}

/** Effective build state: either an individual toggle or the rollback marker. */
export function isFeatureSuppressed(node: Pick<BaseNode, 'metadata'>): boolean {
  return isFeatureManuallySuppressed(node) || isFeatureRollbackSuppressed(node);
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
  /**
   * Offered in Tweak mode and through a share link. Absent means "not
   * curated": a model where nobody has chosen exposes every parameter, so an
   * older document and a first share both behave the way they did before
   * curation existed. Once any parameter is exposed, the choice is taken to
   * be deliberate and only the exposed ones are offered — see
   * `listExposedParameters` in document-core, which is the single place that
   * rule lives.
   */
  exposed?: boolean;
  /**
   * What this parameter means, for whoever meets the model through Tweak mode
   * or a share link and never sees the feature that consumes it. Absent or
   * blank simply shows nothing: a name like `wall_thickness` often needs no
   * gloss, and an empty line under every row would be worse than none.
   */
  description?: string;
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
      /**
       * The face's area centroid when the sketch was placed, and the marker
       * that says WHERE its origin sits: present means the rebuild anchors the
       * frame on the evolved face's area centroid, absent means it anchors on
       * the vertex mean {@link SketchPlaneRef.sourceCenter} the way every
       * sketch written before the centroid existed already resolves.
       *
       * The distinction is load-bearing rather than historical. The two points
       * differ by a whole radius on a round face, and the origin is what the
       * sketch's stored coordinates are measured from, so re-anchoring an
       * existing sketch would move its geometry. New sketches take the
       * centroid; documents already saved keep what they were drawn against.
       */
      sourceCentroid?: Vector3;
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
  /**
   * Persisted design intent between this sketch's objects, solved by the
   * kernel's GCS. Schema v9, additive: absent means no constraints, so every
   * earlier document replays untouched.
   */
  constraints?: SketchConstraint[];
}

/**
 * Which point of a sketch object a constraint grabs. Lines expose `start`
 * (x1, y1) and `end` (x2, y2); circles expose `center`; arcs expose `center`
 * plus their sweep's `start` and `end`.
 */
export interface SketchPointRef {
  objectId: EntityId;
  point: 'start' | 'end' | 'center';
}

/**
 * v1 constraints attach to `line`, `arc`, and `circle` objects only.
 * Rectangles, polygons, and text are single parametric nodes without point
 * identity; decomposing them into constrainable point graphs would rewrite
 * `SketchObjectData` (and the persisted region fingerprints derived from it),
 * which this additive slice deliberately avoids.
 *
 * Dimensional values are `ParamValue`s like every other sketch dimension, so
 * a driving dimension can be an expression over named parameters.
 */
export type SketchConstraintData =
  | { constraintKind: 'coincident'; a: SketchPointRef; b: SketchPointRef }
  | { constraintKind: 'horizontal'; objectId: EntityId }
  | { constraintKind: 'vertical'; objectId: EntityId }
  | { constraintKind: 'parallel'; a: EntityId; b: EntityId }
  | { constraintKind: 'perpendicular'; a: EntityId; b: EntityId }
  /** Equal length (two lines) or equal radius (two circles/arcs). */
  | { constraintKind: 'equal'; a: EntityId; b: EntityId }
  /**
   * One line tangent to one circle, in either order. Point-free: the kernel's
   * `tangentLineCircle` constrains center-to-line distance to the radius, so
   * no synthesized contact-point entity is needed. Arcs still require the
   * contact-point form (TangentLineArc) and stay excluded.
   */
  | { constraintKind: 'tangent'; a: EntityId; b: EntityId }
  | { constraintKind: 'concentric'; a: EntityId; b: EntityId }
  | { constraintKind: 'midpoint'; point: SketchPointRef; line: EntityId }
  | {
      constraintKind: 'distance';
      a: SketchPointRef;
      b: SketchPointRef;
      value: ParamValue;
    }
  | { constraintKind: 'radius'; objectId: EntityId; value: ParamValue }
  | { constraintKind: 'angle'; a: EntityId; b: EntityId; valueDeg: ParamValue };

export type SketchConstraintKind = SketchConstraintData['constraintKind'];

export interface SketchConstraint {
  constraintId: SketchConstraintId;
  data: SketchConstraintData;
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
 * A complete turn. The kernel accepts `(0, 360]` degrees; 360 is both the
 * maximum and the value an absent `angleDeg` means, so documents written
 * before partial revolve existed keep building exactly as they did.
 */
export const FULL_REVOLVE_ANGLE_DEG = 360;

/** Persistent result mode chosen when an extrusion is first created. */
export type ExtrudeOperation = 'new-body' | 'add' | 'cut';

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

/** One persisted closed profile together with the sketch plane that owns it. */
export interface SketchSectionReference {
  sketchId: SketchId;
  profile: SketchProfileReference;
}

/** Ordered authored sketch entities used as an exact sweep path. */
export interface SketchPathReference {
  sketchId: SketchId;
  entityIds: EntityId[];
}

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
       * Extrude half the distance to each side of the sketch plane instead
       * of all of it above. Absent means the legacy one-sided extrude.
       */
      symmetric?: boolean;
      /**
       * Additional depth extruded behind the sketch plane, opposite the
       * `distance` direction. Absent or zero means the one-sided extrude;
       * combining it with `symmetric` is rejected at creation and fails
       * closed on rebuild rather than guessing which side wins.
       */
      backDistance?: ParamValue;
      /**
       * Resolved once at creation time. Absent preserves the legacy new-body
       * behavior; rebuilds never infer a different operation.
       */
      operation?: ExtrudeOperation;
      /** Required for stored add/cut operations and absent for new-body. */
      targetBodyId?: BodyId;
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
      /**
       * Sweep angle in degrees, in `(0, 360]`. Absent means a full turn, so
       * every document written before this field existed keeps its exact
       * previous geometry and its ADR-013 semantic lineage.
       *
       * A value below 360 is a deliberate ADR-011 hash-only body — see
       * `PARTIAL_REVOLVE_HASH_ONLY_REASON` in the kernel adapter.
       */
      angleDeg?: ParamValue;
    }
  | {
      featureKind: 'loft';
      /** User-authored section order; at least two are required. */
      sections: SketchSectionReference[];
      mode: 'ruled' | 'smooth';
    }
  | {
      featureKind: 'sweep';
      profile: SketchSectionReference;
      path: SketchPathReference;
      mode: 'standard' | 'smooth';
    }
  | {
      featureKind: 'helical-sweep';
      profile: SketchSectionReference;
      axisOrigin: ParametricVector3;
      axisDirection: ParametricVector3;
      radius: ParamValue;
      pitch: ParamValue;
      turns: ParamValue;
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
      featureKind: 'hole';
      /** Consumed: the drilled body replaces it. */
      targetBodyId: BodyId;
      /** The planar entry face, by fingerprint with an optional v5 anchor. */
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      style: 'simple' | 'counterbore' | 'countersink';
      diameter: ParamValue;
      /** 'blind' drills to `depth`; 'through' spans the whole body. */
      depthMode: 'blind' | 'through';
      depth?: ParamValue;
      counterboreDiameter?: ParamValue;
      counterboreDepth?: ParamValue;
      countersinkDiameter?: ParamValue;
      /** Full included angle, degrees. */
      countersinkAngleDeg?: ParamValue;
      /**
       * Axis position on the face, in the face's derived frame — the same
       * `frameFromFace(center, normal)` construction sketch-on-face and the
       * kernel's cylinder frames use, so it re-derives identically at every
       * rebuild from the resolved face rather than storing a world point
       * that would go stale when upstream features move the body.
       */
      position: { u: ParamValue; v: ParamValue };
      /**
       * Where {@link position} is measured FROM on the resolved entry face:
       * present means the face's area centroid, absent means the vertex mean
       * `FaceGeometry.center` that every hole drilled before the centroid
       * existed was already placed against.
       *
       * The presence of the marker selects the anchor, exactly as
       * `SketchPlaneRef.sourceCentroid` does, and for the same reason: on a
       * face bounded by one closed circular edge the two points are a whole
       * radius apart, so re-anchoring an existing hole would move it. New
       * holes take the centroid; saved documents keep the anchor they were
       * drilled against.
       *
       * Unlike the sketch's marker this carries no snapshot of the point. A
       * hole deliberately stores no world position — see {@link position} —
       * because upstream features move the body underneath it, and a value
       * that is never read back would be exactly that stale world point.
       */
      positionAnchor?: 'centroid';
    }
  | {
      featureKind: 'split';
      /** Consumed: the two halves replace the input body. */
      targetBodyId: BodyId;
      plane: ParametricPlane;
      /**
       * The half on the side the plane normal points away from. The
       * feature's own `bodyId` names the positive half; a `FeatureNode`
       * carries one body, so the second travels in the data, mirroring how
       * `targetBodyIds` carries body references.
       */
      secondBodyId: BodyId;
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
      featureKind: 'draft';
      targetBodyId: BodyId;
      faceHashes: number[];
      faceReferences?: FaceTopologyReferenceV5[];
      pullDirection: ParametricVector3;
      neutralPoint: ParametricVector3;
      angleDeg: ParamValue;
    }
  | {
      featureKind: 'thicken';
      targetBodyId: BodyId;
      faceHash: number;
      faceReference?: FaceTopologyReferenceV5;
      thickness: ParamValue;
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
      /**
       * Distance-angle chamfer: `distance` lands on the first adjacent face
       * and the bevel leaves it at this angle (degrees, strictly between 0
       * and 90). Absent means the symmetric 45° chamfer with `distance` on
       * both faces, which is what every earlier document stored.
       */
      angleDeg?: ParamValue;
    }
  | {
      featureKind: 'pattern';
      targetBodyId: BodyId;
      patternKind: PatternKind;
      count: ParamValue;
      axis: AxisId;
      spacing: ParamValue;
      angleDeg: ParamValue;
      /**
       * Linear patterns only: an arbitrary repeat direction that overrides
       * `axis` when present. Normalized at rebuild; a near-zero vector is a
       * feature error rather than a guess.
       */
      direction?: ParametricVector3;
      /** Grid patterns: the second repeat axis. Absent reads as 'y'. */
      axis2?: AxisId;
      /** Grid patterns: spacing along `axis2`. Absent reads as `spacing`. */
      spacing2?: ParamValue;
      /** Grid patterns: instance count along `axis2`. Absent reads as `count`. */
      count2?: ParamValue;
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
      /**
       * ISO 10303-21 source embedded in the document, for deterministic
       * offline rebuilds. Written by imports that predate `stepSourceRef`,
       * and still by the fallback when this browser denies blob storage —
       * capped at 12 MB on both paths. The cloud path externalises it into a
       * project asset and restores it on load, so a document in hand always
       * carries the text.
       *
       * Deliberately never migrated into `stepSourceRef`. The embedded form
       * is the more portable of the two: the document carries everything a
       * rebuild needs and it syncs, while a reference is only resolvable
       * where something can produce bytes matching its checksum. Rewriting
       * one into the other on load would strand the source on whichever
       * device did it until the bytes were archived, and — being a change to
       * canonical content that no user made — would leave an untouched
       * project reading as diverged. See `listLocalOnlyImportSources`.
       *
       * Exactly one of the two fields is present.
       */
      stepText?: string;
      /**
       * Content-addressed alternative to `stepText`, written by imports that
       * could reach the blob store. This is what keeps a document a few
       * hundred bytes while its source runs to hundreds of megabytes.
       */
      stepSourceRef?: ImportedSourceReference;
      /**
       * Partial import: zero-based indices into the file's DECLARED solid
       * order (the stable order the reader reports, before unreadable solids
       * are dropped — the same numbering the import diagnostics use). Absent
       * means every solid, and a set naming every declared solid is
       * equivalent to absent. Selected indices that turn out unreadable are
       * still dropped with the usual warning.
       */
      solidIndices?: number[];
    };

/**
 * A content-addressed pointer to import source bytes held outside the
 * document — in the browser's blob store locally and in R2 when synced. The
 * checksum is the identity: any store that can produce bytes hashing to
 * `checksumSha256` can satisfy the reference, which is what lets a document
 * stay a few hundred bytes while its source runs to hundreds of megabytes.
 */
export interface ImportedSourceReference {
  marker: 'openzcad-source-ref';
  version: 1;
  hashAlgorithm: 'sha256';
  /** Lowercase hex SHA-256 of the raw source bytes. */
  checksumSha256: string;
  /** Byte length of the raw (uncompressed) source. */
  logicalBytes: number;
}

export function isImportedSourceReference(
  value: unknown
): value is ImportedSourceReference {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.marker === 'openzcad-source-ref' &&
    record.version === 1 &&
    record.hashAlgorithm === 'sha256' &&
    typeof record.checksumSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(record.checksumSha256) &&
    typeof record.logicalBytes === 'number' &&
    Number.isSafeInteger(record.logicalBytes) &&
    record.logicalBytes >= 0
  );
}

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

/**
 * Display/derived triangle mesh. Typed arrays, deliberately: these live only
 * in `derived.bodyRepresentations`, which every serializer strips
 * (`withoutDerivedProjection`) and every rebuild reconstructs, so they never
 * meet JSON — and as typed arrays they cross the worker boundary without
 * per-element boxing and feed three.js buffer attributes without a copy.
 * Canonical mesh data that IS persisted (the `imported-mesh` feature payload)
 * stays `number[]` for exactly the inverse reason.
 */
export interface MeshGeometry {
  kind: 'mesh';
  /** Flat xyz triples in document units. */
  vertices: Float32Array;
  /** Triangle vertex indices. */
  indices: Uint32Array;
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

interface RecognizedImportedFeatureBase {
  /** Canonical face used to re-run the proof during exact rebuild. */
  seedFaceHash: number;
  seedFaceReference?: FaceTopologyReferenceV5;
  /** All faces consumed by the proof, used to suppress weaker overlapping hints. */
  participatingFaceHashes: number[];
}

interface RecognizedImportedHoleBase extends RecognizedImportedFeatureBase {
  openingPoint: Vector3;
  /** Unit direction from the opening into the body. */
  axisDirection: Vector3;
}

/** Bounded exact imported-feature proofs published with derived topology. */
export type RecognizedImportedFeature =
  | (RecognizedImportedHoleBase & {
      kind: 'blind-cylindrical-hole';
      diameter: number;
      depth: number;
    })
  | (RecognizedImportedHoleBase & {
      kind: 'counterbore';
      boreDiameter: number;
      counterboreDiameter: number;
      counterboreDepth: number;
      totalDepth: number;
      entryChamfered: boolean;
    })
  | (RecognizedImportedHoleBase & {
      kind: 'countersink';
      boreDiameter: number;
      sinkDiameter: number;
      angleRadians: number;
      countersinkDepth: number;
      totalDepth: number;
    })
  | (RecognizedImportedFeatureBase & {
      kind: 'cylindrical-boss';
      diameter: number;
      height: number;
    })
  | (RecognizedImportedFeatureBase & {
      kind: 'prismatic-pocket';
      depth: number;
    })
  | (RecognizedImportedFeatureBase & {
      kind: 'conical-taper';
      referenceRadius: number;
      oppositeRadius: number;
      length: number;
      angleRadians: number;
    });

/**
 * Whether {@link FaceGeometry.area} is the true area or an approximation.
 *
 * `kernel.faceArea` takes a deflection parameter, which reads as "approximate
 * everywhere". It is not: measured against closed forms on the pinned build
 * (test/measurement-provenance.test.ts), analytic curved surfaces come back at
 * machine precision, and so do planar faces bounded entirely by straight
 * edges — including non-convex ones, where an L-shaped face reads exactly 300.
 *
 * A plane bounded by any curve is the exception, and the deflection does not
 * govern it: the boundary is inscribed with a FIXED 256-point polygon, so the
 * error is identical at every deflection and every scale. The sign follows
 * which side the curve bounds — a disc cap reads 1.004e-4 low, while a plate
 * with a bore reads 5.183e-6 HIGH, because the inscribed hole is smaller than
 * the true one and leaves more material behind.
 */
export type FaceAreaProvenance =
  /** Closed form or exact polygon; trustworthy to machine precision. */
  | 'exact'
  /** A curved boundary inscribed with a fixed point count. */
  | 'sampled';

export interface FaceGeometry {
  /** Underlying surface class (plane, cylinder, cone, B-spline, ...). */
  surfaceType: string;
  area: number;
  /**
   * How far {@link area} can be trusted. Absent when the surface class is one
   * this build has not measured, which consumers must treat as "assume
   * approximate" rather than as "exact".
   */
  areaProvenance?: FaceAreaProvenance;
  /**
   * The mean of this face's VERTEX positions — not an area centroid, despite
   * being exactly reproducible and used as a topology fingerprint. For an
   * L-shaped or trimmed face it is not the centre of the face, and it is not
   * where a centre-of-mass marker belongs.
   *
   * The value is frozen: it is an ADR-011 witness input AND a direct-edit
   * authorization pin (`sourceCenter`), so changing it would invalidate
   * persisted topology hashes and refuse edits on documents that already open.
   */
  center: Vector3;
  /**
   * The planar face's AREA centroid — the point a user means by "the middle of
   * this face", and the anchor a sketch attached to the face is placed on.
   *
   * Distinct from {@link center} in exactly the cases that matter: a disc
   * bounded by one closed circular edge has a single seam vertex, so its
   * vertex mean sits on the rim. Present only for planar faces whose boundary
   * wires could be walked, which excludes NURBS-backed planes; absent means
   * "cannot answer", never "same as center".
   *
   * Exact for a straight-edged boundary. A curved boundary is inscribed with a
   * polygon dense relative to its own length, which leaves a residual far below
   * modelling tolerance but is not bit-stable across kernel versions.
   */
  centroid?: Vector3;
  /** Outward unit normal; present for exact planar surfaces. */
  normal?: Vector3;
  /**
   * The `d` in the plane's equation `n·x = d`, alongside {@link normal}.
   *
   * Present only when `normal` is, which excludes NURBS-backed planes — the
   * imported-STEP faces a raw pick most often lands on. Its whole purpose is
   * to make signed point-to-plane distance an exact client-side calculation
   * rather than a kernel round trip, so a consumer must treat the absence as
   * "cannot answer" rather than substituting a plane through the origin.
   */
  planeOffset?: number;
  /** Present for exact cylindrical surfaces. */
  radius?: number;
  diameter?: number;
  /** Axis endpoints of the trimmed cylindrical face in world coordinates. */
  axisStart?: Vector3;
  axisEnd?: Vector3;
  axialLength?: number;
  /** Exact torus centre, distinct from the frozen vertex-mean `center`. */
  torusCenter?: Vector3;
  /** Unit axis direction for an exact cone or torus when published. */
  axis?: Vector3;
  /** Exact torus ring and tube radii. */
  majorRadius?: number;
  minorRadius?: number;
  /** Exact cone apex and half-angle. */
  apex?: Vector3;
  halfAngle?: number;
  /** Semantic surface role proven by the kernel adapter. */
  featureType?: 'through-hole' | 'blend';
  /** Rolling-ball radius for a recognized blend surface. */
  blendRadius?: number;
  /**
   * Rebuild-local identity of the exact tangency-connected blend region.
   * Kernel handles are intentionally not persisted beyond derived state.
   */
  blendRegionKey?: string;
  /** Number of exact analytic faces in {@link blendRegionKey}. */
  blendRegionFaceCount?: number;
  /** Dimension currently supported by a deterministic direct edit. */
  editableDimension?: 'diameter' | 'blendRadius';
}

export interface EdgeTopology {
  topologyId: string;
  hash: number;
  reference?: EdgeTopologyReferenceV5;
  /**
   * Length measured by the browser geometry kernel from the edge's exact
   * curve. Optional for projections produced by older adapters; consumers may
   * fall back to the sampled display polyline only when they also identify the
   * result as approximate.
   */
  length?: number;
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
   * - **Not unique per face.** Remus builds a sphere from two same-surface
   *   hemispheres that share one exact witness, so both patches hash
   *   identically. Two edges reporting a common hash therefore do not
   *   necessarily touch the same face. This is the identity scheme failing
   *   closed as designed, and it is a live product limit — face picks on
   *   spheres are unavailable for the same reason.
   * - **Not sufficient for an edge run on its own.** Two edges on opposite
   *   sides of a box's top face share that face. A run also needs vertex
   *   incidence, which `vertexIds` publishes.
   */
  adjacentFaceHashes?: number[];
  /**
   * The exact curve underlying this edge, so a consumer can draw and measure
   * true geometry instead of the chords `points` samples.
   *
   * Absent when the kernel refuses the edge. Absent rather than approximate is
   * the rule for every part of this record: it is either exactly right or it
   * is not there.
   */
  curve?: EdgeCurve;
  /**
   * The two vertices this edge runs between, as `[start, end]` in the edge's
   * own direction — the same direction `points` is sampled in.
   *
   * These are the kernel's own vertex handles renumbered, not positions
   * matched to a tolerance. Two edges belong to the same run only if they
   * share a vertex, and `adjacentFaceHashes` cannot answer that: opposite
   * sides of a box's top face bound the same face and meet nowhere.
   *
   * Deriving this from geometry was measured and rejected — see
   * `test/vertex-identity.test.ts`. Quantizing display-polyline endpoints at
   * the ADR-011 1e-6 quantum produced 73 false splits across the parity
   * corpus, all on closed edges, because a closed edge's polyline is a loop
   * that begins a quarter turn away from its own vertex.
   *
   * Four things it is NOT:
   *
   * - **Not two distinct vertices.** A closed edge names one vertex twice: a
   *   cylinder's rim, a bore rim, and a torus's two zero-length degenerate
   *   edges all report `[v, v]`. The pair is kept rather than deduplicated
   *   because it is the kernel's own shape, it keeps start and end
   *   distinguishable, and `new Set(ids).size === 1` is how the fillet
   *   dispatcher already recognises a closed rim.
   * - **Not a persistent identity.** Unlike `hash`, these are dense integers
   *   assigned while walking one body's solids. They are comparable only
   *   within the same `BodyTopology`, and a rebuild may renumber them. Do not
   *   store them, key a document off them, or compare them across bodies.
   * - **Not shared between solids.** Numbering is body-wide but the handle
   *   map is rebuilt per solid, so two solids in one body — a linear pattern
   *   whose spacing equals its extent, say — never share a vertex id even
   *   where they touch exactly. That is deliberate: they are distinct
   *   topology that happens to be coincident, and a run must not walk across.
   * - **Not sufficient for an edge run on its own either.** Twelve box edges
   *   meet in pairs at eight vertices and are not one run. Shared vertex and
   *   shared face are both necessary; what makes a run is a product question
   *   about tangency on top of them.
   */
  vertexIds?: [number, number];
  /**
   * XYZ-interleaved display polyline sampled from the exact edge curve.
   * Closed feature edges repeat their first point so the viewport draws the
   * closing segment.
   */
  points: number[];
}

/**
 * An exact opposing planar pair whose stored move mode passed a non-zero
 * checkpointed rebuild before publication.
 */
export interface OpposingPlanarFacePair {
  faceAHash: number;
  faceAReference: FaceTopologyReferenceV5;
  faceBHash: number;
  faceBReference: FaceTopologyReferenceV5;
  distance: number;
  overlapArea: number;
  faceAreaA: number;
  faceAreaB: number;
  /** Outward unit normal of face A. */
  normal: Vector3;
  faceABordersBlend: boolean;
  faceBBordersBlend: boolean;
  moveMode: FaceDistanceMoveMode;
  /** The real changed distance accepted by the exact proof rebuild. */
  provenChangedDistance: number;
}

/**
 * Exact geometry for one edge's underlying curve.
 *
 * Only `type` is always present. Analytic data is published for circles alone,
 * and only after it has been checked against the edge's own sampled polyline,
 * so a consumer that finds `circle` may use it without further validation.
 *
 * Four things this record is NOT:
 *
 * - **Not a parameter range.** No `t` domain is published, and none should be
 *   added without re-measuring. The kernel's `getEdgeCurveParameters` reports
 *   the domain of the UNDERLYING curve, not the edge's trim of it: a quarter
 *   fillet arc of length 3pi/2 reports `[0, 2pi]`, and evaluating at that
 *   range's midpoint lands on the edge's own end vertex rather than its
 *   middle. A consumer handed that range would mis-draw every fillet and
 *   chamfer arc in the product. `circle` describes the full circle the edge
 *   lies on; where the edge starts and stops on it is recoverable only from
 *   `points` or the edge's vertices.
 * - **Not a swept direction.** `circle.axis` is the unoriented normal of the
 *   arc's plane, canonically signed so it does not flip between rebuilds. It
 *   says nothing about which way the edge runs, and crossing it with anything
 *   to recover a winding is meaningless.
 * - **Not a claim about the surfaces meeting at the edge.** A circular edge
 *   bounds whatever `adjacentFaceHashes` names; the curve is the intersection
 *   geometry, not either face's own axis or radius, and a fillet arc's radius
 *   is the fillet's only where the blend is tangent to both walls.
 * - **Not a completeness guarantee.** An edge with no `curve` means the kernel
 *   would not answer, not that the edge is degenerate; an edge whose `curve`
 *   has no `circle` means only that no analytic form is published for it.
 */
export interface EdgeCurve {
  /**
   * The kernel's curve-type vocabulary: `LINE`, `CIRCLE`, `ELLIPSE`,
   * `BSPLINE_CURVE`. Left open rather than closed to a union because it is the
   * kernel's word, matching `FaceGeometry.surfaceType`; a consumer should
   * compare against the case it handles and treat anything else as unknown.
   */
  type: string;
  /**
   * The full circle this edge lies on — never a subtended arc, see above.
   *
   * Published only for `type === 'CIRCLE'`. That gate is load-bearing rather
   * than cosmetic: the kernel's edge curvature measurement is silently wrong
   * for ellipses by roughly twelve orders of magnitude, reporting a radius of
   * 1.4999e12 for a true 1.5, and a record built without the gate would carry
   * plausible-shaped garbage rather than fail.
   */
  circle?: {
    center: Vector3;
    /** Unit normal of the arc's plane; unoriented, see above. */
    axis: Vector3;
    radius: number;
  };
}

export interface BodyTopology {
  faces: FaceTopology[];
  edges: EdgeTopology[];
  /** Non-overlapping exact proofs created while imported topology is live. */
  recognizedImportedFeatures?: RecognizedImportedFeature[];
  /** Bounded imported-body dimensions with a successful changed-value proof. */
  opposingPlanarFacePairs?: OpposingPlanarFacePair[];
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
/**
 * A solid's distribution of material, integrated over its exact surfaces.
 *
 * Deliberately carries no volume. The kernel's mass-properties integrator
 * returns one, but it is LESS accurate than `BodyRepresentation.volume` — on a
 * cylinder it lands 1.8e-13 off where the other is 2e-16 off, because the two
 * share an integrator and only one of them is additionally pinned bit-exact
 * for analytic bodies. Publishing both would invite a consumer to pick the
 * wrong one for `mass = density * volume`, so only the better one exists.
 *
 * Unit density throughout: these are geometric moments, not physical ones.
 * Multiplying by a density is the caller's job, and the caller is the only
 * part of the system that knows what the part is made of.
 */
export interface BodyMassProperties {
  /** Centroid of the enclosed volume, in document units. */
  centerOfMass: Vector3;
  /**
   * `[Ixx, Iyy, Izz, Ixy, Ixz, Iyz]` about the centre of mass, on global axes.
   * The three products vanish when the body is symmetric about those axes.
   */
  inertia: readonly [number, number, number, number, number, number];
  /** Principal moments, ascending. */
  principalMoments: readonly [number, number, number];
  /**
   * The axis belonging to each principal moment, in the same order.
   *
   * The kernel hands these over as a flat row-major nine, which is converted
   * here rather than downstream: an consumer reading `principalAxes[0]` and
   * expecting a vector would otherwise get a scalar with no type error.
   *
   * Order is a property of the body's proportions, not of the axes. A cylinder
   * taller than r*sqrt(3) has its spin axis FIRST, so nothing may assume the
   * last entry is the interesting one — pair each axis with its own moment.
   */
  principalAxes: readonly [Vector3, Vector3, Vector3];
}

export interface BodyRepresentation {
  bodyId: BodyId;
  name: string;
  source: FeatureKind;
  mesh: MeshGeometry;
  /** Number of planar B-Rep faces in the underlying solid. */
  faceCount: number;
  color: string;
  /** Display opacity in [0, 1]; absent means fully opaque. */
  opacity?: number;
  exportableStep: boolean;
  /** True when a later boolean feature consumed this body. */
  consumed: boolean;
  /**
   * For imported-step bodies: how many solids the source file declares, so
   * the inspector can offer per-solid selection. Absent on other sources.
   */
  importedStepDeclaredSolidCount?: number;
  volume: number;
  bbox: BoundingBox;
  /**
   * Absent when the kernel could not integrate this solid — it raises on a
   * degenerate one where `volume` merely answers zero — or when the projection
   * predates the field. Consumers must render the absence rather than
   * substituting zeros, which would read as a massless part.
   */
  massProperties?: BodyMassProperties;
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
 * Where a project was branched from, recorded on the copy at the moment it is
 * made.
 *
 * Provenance, not a live link. The source project can be renamed, edited past
 * this point, or deleted outright without the branch noticing: the whole point
 * of branching a save state is that the copy stops depending on the original.
 */
export interface ProjectBranchPoint {
  projectId: ProjectId;
  /** The save state the copy started from. */
  revisionId: RevisionId;
  /** The source project's name when the branch was taken. */
  projectName: string;
  /** That save point's reason, so the shelf can say which save it was. */
  checkpointReason: string;
  branchedAt: string;
}

/**
 * One stored save state, without its document. What the history panel lists.
 *
 * `available` is the honest answer to a question the three retention bounds
 * make unavoidable: an in-document checkpoint can outlive the stored snapshot
 * it points at, and a row the user can click has to know that before they
 * click it.
 */
export interface RevisionSummary {
  revisionId: RevisionId;
  projectId: ProjectId;
  reason: string;
  createdAt: string;
  /** Absent for revisions stored before authorship was recorded. */
  authorUserId?: UserId;
  documentBytes: number;
}

export interface ListRevisionsResponse {
  revisions: RevisionSummary[];
  /** The account's retention bound, so the panel can explain a short list. */
  maxRevisions: number;
}

/**
 * The lineage a branch records, built from the source project as it stands now
 * and the save state being branched. Both stores construct it the same way, so
 * a branch made online and one made offline describe themselves identically.
 */
export function projectBranchPoint(
  source: { projectId: ProjectId; name: string },
  revision: { revisionId: RevisionId; reason: string }
): ProjectBranchPoint {
  return {
    projectId: source.projectId,
    revisionId: revision.revisionId,
    projectName: source.name,
    checkpointReason: revision.reason,
    branchedAt: nowIso()
  };
}

export const MAX_PROJECT_CHECKPOINTS = 100;

/**
 * Retained in-document revision records. One is appended on every command,
 * undo, redo, and normalization, so without a bound document size grows
 * linearly with lifetime edit count. The records are small bookkeeping rows
 * (id, timestamp, reason, command count) that nothing looks up beyond the
 * most recent entries, so trimming the oldest loses no behavior; the durable
 * server-side snapshots have their own separate `MAX_PROJECT_REVISIONS` cap.
 */
export const MAX_PROJECT_REVISION_RECORDS = 500;

function isBoundedString(value: unknown, max: number, min = 0): boolean {
  return (
    typeof value === 'string' && value.length >= min && value.length <= max
  );
}

function isNonnegativeSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isProjectCheckpoint(
  value: unknown
): value is ProjectCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const checkpoint = value as Record<string, unknown>;
  return (
    isBoundedString(checkpoint.checkpointId, 200, 1) &&
    isBoundedString(checkpoint.revisionId, 200, 1) &&
    isNonnegativeSafeInteger(checkpoint.documentVersion) &&
    isBoundedString(checkpoint.createdAt, 100, 1) &&
    isBoundedString(checkpoint.reason, 500)
  );
}

export function isRevisionRecord(value: unknown): value is RevisionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const revision = value as Record<string, unknown>;
  return (
    isBoundedString(revision.revisionId, 200, 1) &&
    isBoundedString(revision.createdAt, 100, 1) &&
    isBoundedString(revision.reason, 500) &&
    isNonnegativeSafeInteger(revision.commandCount)
  );
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

export type ShaprMigrationOperationKind =
  | 'import'
  | 'sketch'
  | 'transform'
  | 'delete'
  | 'midplane'
  | 'split'
  | 'offset-face'
  | 'union'
  | 'extrude'
  | 'unknown';

export type ShaprMigrationOperationStatus =
  'proven' | 'candidate' | 'unsupported' | 'ambiguous';

/**
 * Sanitized, non-operative evidence recovered from a Shapr3D project. Raw
 * database rows, Parasolid data, thumbnails, paths, and remote identifiers are
 * deliberately excluded from the canonical document.
 */
export interface ShaprMigrationOperationRecord {
  sourceNodeId: number;
  name: string;
  kind: ShaprMigrationOperationKind;
  status: ShaprMigrationOperationStatus;
  numericCandidates: number[];
  diagnostic: string;
}

export interface ShaprMigrationDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface ShaprMigrationRecord {
  importId: ShaprImportId;
  representation: 'openzcad-shapr-migration';
  version: 1;
  sourceName: string;
  sourceChecksumSha256: string;
  companionStepName: string;
  companionStepChecksumSha256: string;
  createdAt: string;
  schema: {
    workspaceSchemaVersion: number;
    schemaVersion: number;
    historyVersion: number;
    projectVersion: number;
  };
  units: {
    source: 'metre-candidate';
    evidence: 'inferred';
    documentScaleCandidate: number;
  };
  exactGeometry: {
    featureId: FeatureId;
    bodyId: BodyId;
    stepChecksumSha256: string;
    validation: 'exact-kernel-preflight';
  };
  summary: {
    historyNodeCount: number;
    sketchCount: number;
    curveCount: number;
    constraintCount: number;
    importedBodyCount: number;
    importedPrototypeCount: number;
    revisionBlockCount: number;
    revisionDeltaCount: number;
  };
  operations: ShaprMigrationOperationRecord[];
  diagnostics: ShaprMigrationDiagnostic[];
  semanticReplay: {
    status: 'not-applied';
    reason: string;
  };
  privateDataOmitted: true;
}

/**
 * Kernel-proven v5 references for one legacy hash-only edge modifier. A
 * closed-edge hash embeds its length, so the only moment a hash-only
 * fillet/chamfer can be upgraded is while its stored hashes still resolve —
 * the rebuild that succeeds is the proof. The app persists these onto the
 * feature so later upstream edits resolve by lineage instead of dying on the
 * orphaned hashes.
 */
export interface EdgeReferenceRepair {
  featureId: FeatureId;
  edgeReferences: EdgeTopologyReferenceV5[];
}

/**
 * One warning the rebuild loop raised, with the feature it belongs to.
 *
 * `warnings` is a flat list of strings prefixed `Feature "<name>":`, which is
 * the right shape to show a user and the wrong shape to decide anything from.
 * Two features may share a name, and the loop emits the same prefix both when
 * a feature FAILED to build and when it was deliberately SKIPPED for being
 * suppressed — ten lines apart, in identical format. A commit gate reading
 * those strings therefore refuses an edit because some unrelated feature is
 * suppressed, and mis-attributes a failure whenever a name repeats.
 *
 * This carries the attribution and disposition the string cannot. Builder
 * advisories and refusals travel through the same user-visible string list;
 * this record is the commit gate's decision input.
 */
export interface FeatureWarning {
  featureId: FeatureId;
  featureName: string;
  /** The full warning text, exactly as it appears in `warnings`. */
  message: string;
  /**
   * What the warning means for the operation that raised it.
   *
   * - `build-failed`: the builder threw and produced no shape at all.
   * - `refusal`: a shape WAS produced, and it is the wrong one. A union that
   *   silently dropped an operand, or came back open and non-manifold, still
   *   yields a solid — it just is not the solid the user asked for, and the
   *   product has always refused to commit those.
   * - `advisory`: the result is real and usable, just approximate. Curves that
   *   came back faceted, a pattern whose overlapping instances did not merge.
   *   The user asked for this and got it; refusing would destroy work that
   *   succeeded.
   * - `suppressed`: a status. The feature was deliberately skipped.
   *
   * Only the first two refuse a commit. The distinction is NOT derivable from
   * whether a shape was produced — the gate rebuilds a throwaway candidate, so
   * every non-throwing builder sets a shape by construction. It is a judgement
   * about the result, and it belongs where the kernel makes it.
   */
  kind: 'build-failed' | 'refusal' | 'advisory' | 'suppressed';
}

export interface DerivedState {
  bodyRepresentations: Record<BodyId, BodyRepresentation>;
  exportableBodyIds: BodyId[];
  warnings: string[];
  updatedAt: string;
  /**
   * Advice to the session that ran this rebuild, not document state:
   * `attachDerivedState` strips it so it is never persisted or replayed.
   */
  referenceRepairs?: EdgeReferenceRepair[];
  /**
   * Complete feature-warning provenance for this rebuild. Session-only and
   * stripped like the repairs. Older adapter results may omit it.
   */
  featureWarnings?: FeatureWarning[];
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
  shaprImports: Record<ShaprImportId, ShaprMigrationRecord>;
  shaprImportOrder: ShaprImportId[];
  derived: DerivedState;
  /**
   * Set once, when this project was branched off a save state of another one.
   * Absent on every project created the ordinary way.
   */
  branchedFrom?: ProjectBranchPoint;
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
    | '3mf-export'
    | 'obj-export'
    | 'gltf-export'
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
  /**
   * The latest small cloud preview, when one has been published. Keeping the
   * reference in the listing lets a shelf fetch only image bytes instead of
   * loading every canonical project document to discover its geometry.
   */
  thumbnailArtifactId?: ArtifactId;
  revisionCount: number;
  updatedAt: string;
  /**
   * The document version this store holds. Present so a device can ask "am I
   * behind?" from the project listing it already fetches, instead of pulling
   * whole documents to find out. Absent on summaries built by stores that
   * predate it, where the answer is simply unknown.
   */
  documentVersion?: number;
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
  /**
   * An existing device-local document to adopt into the account rather than a
   * fresh project to mint. The document keeps its `projectId`, so the device's
   * local copy and the shelf metadata it has already accumulated stay pointed
   * at the same project once it has an account record. `units` is ignored when
   * this is present — the document already has them.
   */
  document?: ProjectDocument;
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
  /**
   * Branch from this stored save state instead of the project's current
   * document. The copy records where it came from in `branchedFrom`; the
   * source project is not touched either way.
   */
  revisionId?: RevisionId;
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

/**
 * A continuous-sync write: the same fenced update as a revision save, without
 * the history entry. Autosave uses this so a long editing session costs a
 * bounded number of row updates rather than one full document snapshot per
 * save; explicit checkpoints still go through {@link SaveRevisionRequest}.
 */
export interface SaveProjectDocumentRequest {
  projectId: ProjectId;
  expectedVersion: number;
  document: ProjectDocument;
}

/**
 * Acknowledgement only. The whole document does not come back — the client
 * already has it, and returning it would double the cost of every autosave.
 */
export interface SaveProjectDocumentResponse {
  projectId: ProjectId;
  version: number;
  updatedAt: string;
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

/**
 * Bodies larger than the single-PUT ceiling upload as fixed-size parts.
 * 16 MiB stays under every Cloudflare plan's request-body cap and R2's
 * equal-part-size rule; the last part may be smaller. R2's own floor for
 * non-final parts is 5 MiB.
 */
export const ARTIFACT_UPLOAD_PART_BYTES = 16 * 1024 * 1024;
/** Server-side ceiling for one part body; parts above this are refused. */
export const MAX_ARTIFACT_PART_BYTES = 32 * 1024 * 1024;
/** Ceiling on parts per upload (with 16 MiB parts: 1 GiB). */
export const MAX_ARTIFACT_UPLOAD_PARTS = 64;
/** Durable unfinished bytes one multipart upload may reserve. */
export const MAX_ARTIFACT_UPLOAD_BYTES =
  ARTIFACT_UPLOAD_PART_BYTES * MAX_ARTIFACT_UPLOAD_PARTS;
/** Unfinished upload sessions one account may hold at once. */
export const MAX_ACTIVE_ARTIFACT_UPLOAD_SESSIONS = 16;
/**
 * Ceiling on finalized artifact bytes per account, attributed to the project
 * owner. Uploads are otherwise unmetered R2 writes on an open-signup beta —
 * without an account ceiling, a scripted client can park unbounded storage on
 * the operator's bucket (32 MiB × 64 parts per artifact, no artifact count
 * limit). 2 GiB comfortably covers real use (the largest supported STEP
 * import is 128 MB) while bounding abuse.
 */
export const MAX_ACCOUNT_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
/** Explicit ceiling on the unfinished portion of account artifact usage. */
export const MAX_ACCOUNT_RESERVED_ARTIFACT_BYTES = MAX_ACCOUNT_ARTIFACT_BYTES;
/** Maximum encoded size of a shelf thumbnail that clients automatically load. */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;
/** The thumbnail renderer publishes WebP; other image formats are not accepted. */
export const THUMBNAIL_CONTENT_TYPE = 'image/webp';

export interface CreateMultipartUploadResponse {
  uploadId: string;
}

export interface UploadedArtifactPart {
  partNumber: number;
  etag: string;
}

export interface CompleteMultipartUploadRequest {
  uploadId: string;
  parts: UploadedArtifactPart[];
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
  /** Whether migration 0017 installed atomic unfinished-upload accounting. */
  artifactUploadAccountingReady?: boolean;
  /**
   * Whether D1 has every schema object installed by
   * 0010_document_storage_accounting. Absent older Workers are not ready.
   */
  documentStorageAccountingReady?: boolean;
  /** Whether migration 0011 and private R2 project storage are available. */
  projectObjectStorageReady?: boolean;
  /** Whether migration 0015 installed isolated measurement storage and fencing. */
  projectMeasurementStorageReady?: boolean;
  /** Whether migrations through 0016 installed resumable account-erasure fencing. */
  accountErasureReady?: boolean;
  /** Whether R2, D1 fencing, and collaboration-room erasure are all ready. */
  projectErasureReady?: boolean;
  /** Public rollout capability; absent older Workers are treated as disabled. */
  projectSharingEnabled?: boolean;
  /** Public rollout capability; absent older Workers are treated as disabled. */
  projectEditLeasesEnforced?: boolean;
  /**
   * Whether the owner's own devices may join a live room. Independent of
   * sharing: this being on says nothing about invitations, roles, or leases.
   */
  projectPersonalSyncEnabled?: boolean;
  /** Whether this deployment can sync project measurements between devices. */
  projectMeasurementSyncEnabled?: boolean;
}

/** Authenticated collaboration capabilities for the current account. */
export interface ProjectCollaborationCapabilitiesResponse {
  sharingEnabled: boolean;
  editLeasesEnforced: boolean;
  personalSyncEnabled: boolean;
  /** True when access comes from the account allowlist rather than a global flag. */
  canary: boolean;
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
  /** Present only on the native readiness endpoint. Older Workers fail closed. */
  desktopAuthEnabled?: boolean;
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

export type AppTheme = 'system' | 'dark' | 'light';
export type AppDensity = 'compact' | 'comfortable';
export type SettingsProjectionMode = 'perspective' | 'orthographic';
export type SettingsDisplayMode = 'shaded-edges' | 'shaded' | 'wireframe';
export type SettingsMiddleDrag = 'pan' | 'orbit' | 'zoom';
/**
 * How to read a wheel event. `auto` classifies each one; the other two force
 * a device's meaning for hardware the classification reads wrongly.
 */
export type SettingsPointerNavigation = 'auto' | 'mouse' | 'trackpad';
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
  /**
   * Workspace chrome widths in CSS pixels. Panel *collapse* is a per-device
   * habit and stays in local panel state, but a width someone dialled in is a
   * preference worth carrying: it rides the settings sync, so it follows an
   * account between browsers and still falls back to device storage for anyone
   * who is not signed in.
   */
  layout: {
    sidebarWidth: number;
    assistantWidth: number;
  };
  viewport: {
    defaultProjection: SettingsProjectionMode;
    showGrid: boolean;
    displayMode: SettingsDisplayMode;
    /** Wheel zoom moves toward the pointer rather than the orbit target. */
    zoomToCursor: boolean;
    /** What a middle-button drag does: pan, orbit, or zoom. */
    middleDrag: SettingsMiddleDrag;
    /** Whether wheel input is auto-classified or forced to one device. */
    pointerNavigation: SettingsPointerNavigation;
  };
  sketching: {
    /** Sketch-plane grid visibility is independent from grid snapping. */
    gridVisible: boolean;
    /** Quantize committed points to `linearSnap`; legacy name kept stable. */
    snapEnabled: boolean;
    /** Prefer exact sketch entities over the grid when candidates overlap. */
    geometrySnapEnabled: boolean;
    /** Offer temporary horizontal/vertical relations while drawing. */
    inferenceEnabled: boolean;
    linearSnap: number;
    angleSnap: number;
    /** Screen-space radius used for sketch snap candidates. */
    snapTolerancePx: number;
  };
  /**
   * How work reaches the account. There is no toggle for the device write —
   * that is what protects the work, and it is not a preference.
   */
  files: {
    /** Copy the open project to the account as you work. */
    cloudAutosave: boolean;
    /** Quiet time before a copy is written, in seconds. */
    cloudAutosaveDelaySeconds: number;
  };
  collaboration: {
    /** Allow project invitations and live collaboration connections. */
    enabled: boolean;
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

export interface PanelWidthLimits {
  min: number;
  max: number;
  default: number;
}

/**
 * What a resized panel is allowed to be, in CSS pixels. Shared so the browser,
 * the Worker's parser and the stylesheet caps agree on one set of numbers: the
 * minimums keep a panel usable rather than a sliver, and the maximums stop a
 * stored width from crowding out the viewport on the next device that reads it.
 */
export const PANEL_WIDTH_LIMITS: {
  sidebar: PanelWidthLimits;
  assistant: PanelWidthLimits;
} = {
  sidebar: { min: 180, max: 720, default: 252 },
  // The assistant needs room for a question card's chips and an audit table.
  assistant: { min: 300, max: 900, default: 360 }
};

/**
 * Bounds on the cloud-autosave quiet time, in seconds. Shared so the browser,
 * the Worker's parser, and the settings control agree. The floor is not zero:
 * a write on every keystroke would spend the account's write budget on
 * intermediate states nobody asked to keep.
 */
export const CLOUD_AUTOSAVE_DELAY_BOUNDS = {
  min: 1,
  max: 60,
  default: 3
} as const;

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
  layout: {
    sidebarWidth: PANEL_WIDTH_LIMITS.sidebar.default,
    assistantWidth: PANEL_WIDTH_LIMITS.assistant.default
  },
  viewport: {
    defaultProjection: 'perspective',
    showGrid: true,
    displayMode: 'shaded-edges',
    zoomToCursor: true,
    middleDrag: 'pan',
    pointerNavigation: 'auto'
  },
  sketching: {
    gridVisible: true,
    snapEnabled: false,
    geometrySnapEnabled: true,
    inferenceEnabled: true,
    linearSnap: 1,
    angleSnap: 15,
    snapTolerancePx: 10
  },
  files: {
    cloudAutosave: true,
    cloudAutosaveDelaySeconds: CLOUD_AUTOSAVE_DELAY_BOUNDS.default
  },
  collaboration: {
    enabled: true
  },
  assistant: {
    enabled: false,
    credentialSource: 'deployment',
    provider: 'openrouter',
    baseUrl: '',
    model: 'openai/gpt-5.6-sol',
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

/**
 * What a share-link visitor may do with the project. `tweak` opens the
 * parameters-only workspace; `view` is read-only.
 */
export type ProjectShareLinkMode = 'tweak' | 'view';

export interface ProjectShareLinkSummary {
  shareLinkId: string;
  projectId: string;
  mode: ProjectShareLinkMode;
  createdAt: number;
  revokedAt: number | null;
}

export interface CreateProjectShareLinkRequest {
  mode: ProjectShareLinkMode;
}

export interface CreateProjectShareLinkResponse {
  shareLink: ProjectShareLinkSummary;
  /** Returned only once. Persistence stores only its SHA-256 hash. */
  token: string;
}

export interface ListProjectShareLinksResponse {
  shareLinks: ProjectShareLinkSummary[];
}

/** Payload served to an anonymous visitor presenting a valid share token. */
export interface SharedProjectResponse {
  project: {
    projectId: string;
    name: string;
    mode: ProjectShareLinkMode;
  };
  document: ProjectDocument;
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

/**
 * How long a save point's reason may be.
 *
 * Shared rather than private to the worker's validator because the field is
 * now typed by a person: the input that bounds what they enter and the
 * validator that refuses what arrives have to agree, or the UI accepts a name
 * the save then rejects.
 */
export const MAX_CHECKPOINT_REASON_LENGTH = 500;

/**
 * Largest self-contained document stored in one legacy D1 or Durable Object
 * value. R2-backed account persistence has a separate request ceiling, but
 * collaboration rooms intentionally retain this value until their snapshots
 * also move to object storage.
 */
export const MAX_PERSISTED_DOCUMENT_BYTES = 1_500_000;

/**
 * Largest self-contained document accepted by cloud project persistence.
 * Imported source payloads are removed from the private R2 projection before
 * storage; this ceiling bounds request parsing and serialization work rather
 * than an R2 object-size limit.
 */
export const MAX_CLOUD_PROJECT_DOCUMENT_BYTES = 24 * 1024 * 1024;

/** Serialized size of `document`, measured the way the store measures it. */
export function persistedDocumentBytes(document: ProjectDocument): number {
  return new TextEncoder().encode(JSON.stringify(document)).byteLength;
}

/**
 * How many revisions a project keeps before the oldest are dropped.
 *
 * Each revision is a whole copy of the document, so an unbounded history is an
 * unbounded multiple of the project itself. Continuous sync does not add to
 * this count — every retained revision is a save somebody chose to make, and
 * the history panel lists exactly these.
 */
export const MAX_PROJECT_REVISIONS = 50;

/**
 * How many save-state documents one project keeps on this device.
 *
 * Restore has to work offline, which means the browser holds snapshot bodies
 * rather than only the account. That is the one genuinely new storage cost of
 * the history panel, so it is bounded well below the account's retention: the
 * checkpoint list stays complete either way, and a row whose local body has
 * been pruned falls back to the account copy.
 */
export const MAX_LOCAL_CHECKPOINT_DOCUMENTS = 25;

/** What an account is currently storing, for the settings panel. */
export interface AccountStorageUsage {
  projectCount: number;
  /** Bytes held by the current copy of each project. */
  documentBytes: number;
  /** Bytes held by saved revisions, across every project. */
  revisionBytes: number;
  /**
   * How many revisions are retained in total. Reported separately from the
   * bytes because retention bounds the count, not the size — later revisions of
   * a project are larger than earlier ones, so a flat byte total cannot show
   * that pruning is working.
   */
  revisionCount: number;
  /** The per-document ceiling, so the client can name it without hardcoding. */
  documentLimitBytes: number;
  maxRevisionsPerProject: number;
  /** Finalized artifact bytes across the account's projects. */
  artifactBytes: number;
  /** How many finalized artifacts the account's projects hold. */
  artifactCount: number;
  /** The account-wide artifact ceiling, for the same no-hardcoding reason. */
  artifactLimitBytes: number;
}

/** The three independently confirmed cloud-data deletion operations. */
export type AccountDeletionScope = 'profile' | 'projects' | 'all';

/** Server-owned inventory and confirmation contract for the deletion dialog. */
export interface AccountDeletionPreview {
  confirmationKind: 'email' | 'phrase';
  confirmationText: string;
  projectCount: number;
  documentBytes: number;
  revisionBytes: number;
  revisionCount: number;
  collaboratorCount: number;
}

export interface DeleteAccountDataRequest {
  scope: AccountDeletionScope;
  confirmation: string;
}

export interface DeleteAccountDataResponse {
  ok: true;
  scope: AccountDeletionScope;
  deletedProjectIds: ProjectId[];
  signedOut: boolean;
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
export const toAssetId = (value: string): AssetId => value as AssetId;
export const toSketchConstraintId = (value: string): SketchConstraintId =>
  value as SketchConstraintId;
export const toShaprImportId = (value: string): ShaprImportId =>
  value as ShaprImportId;

export const DEFAULT_BODY_COLOR = '#e1a948';

export const FEATURE_COLORS: Record<FeatureKind, string> = {
  primitive: '#e1a948',
  sketch: DEFAULT_BODY_COLOR,
  extrude: '#4bb7a7',
  revolve: '#5fb3e8',
  loft: '#22c55e',
  sweep: '#16a34a',
  'helical-sweep': '#65a30d',
  boolean: '#ff7452',
  transform: '#8b80f9',
  mirror: '#a78bfa',
  shell: '#14b8a6',
  'solid-offset': '#06b6d4',
  draft: '#0d9488',
  thicken: '#0891b2',
  fillet: '#f59e0b',
  chamfer: '#fb7185',
  pattern: '#38bdf8',
  split: '#f472b6',
  hole: '#fb923c',
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
