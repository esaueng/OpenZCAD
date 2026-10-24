export * from './workspace-resume';
export * from './document-validation';
export * from './document-history';
export * from './textLimits';
export * from './imported-step-source';
export * from './imported-mesh-payload';
export * from './sketch-reference-dimensions';
export * from './sketch-composites';
export * from './sketch-composite-targets';
export * from './sketch-boundary-provenance';
export * from './sketch-promotions';
export * from './mass-density';
export * from './keymap-settings';
export * from './drawings';
export * from './object-folders';
import type { DocumentHistory } from './document-history';
import type { KeymapOverrides } from './keymap-settings';
import type { DrawingSet } from './drawings';
import type {
  SketchCompositeCornerTarget,
  SketchCompositeSideTarget
} from './sketch-composite-targets';
import type { BoundaryProvenance } from './sketch-boundary-provenance';
import type { SketchPromotion } from './sketch-promotions';
import type { ObjectFolderSet } from './object-folders';
export * from './drawing-annotations';
export * from './topology-reference';
export * from './reference-images';
import type { ReferenceImageSet } from './reference-images';
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
export type SketchReferenceAnnotationId = Brand<
  string,
  'SketchReferenceAnnotationId'
>;
export type ShaprImportId = Brand<string, 'ShaprImportId'>;
export type SketchCompositeId = Brand<string, 'SketchCompositeId'>;

/**
 * v18 adds the S07 constraint kinds (`symmetric`, `point-on-object`, `lock`).
 * They are additive, but a v17 client would accept them and solve without
 * them, so the bump makes older clients refuse such documents instead.
 *
 * v19 adds R01 datum planes: the `datum-plane` feature kind and the datum
 * references sketches, Split and Mirror can hold in place of a numeric plane.
 *
 * v20 adds the F01 through-all extrude end condition (`endCondition`,
 * `throughAllSide`). A v19 client would replay such a cut at its stale blind
 * distance, so the bump makes it refuse the document instead.
 *
 * v21 adds F05 typed parameters (`ParameterNode.quantity`). A typed parameter
 * carries its dimension into expressions (`width + 5 mm`), which a v20 client
 * would refuse or read as a bare number, so the bump makes it refuse such a
 * document. Absent stays the unitless parameter every older document holds.
 *
 * v22 adds the M10 transform pivot (`ParametricTransform3D.pivot`): rotation
 * and scale turn about it rather than the world origin. A v21 client would
 * turn such a Move about the origin and move the body elsewhere, so the bump
 * makes it refuse the document instead.
 *
 * v23 adds the M10 transform copy (`copy: true` on a transform feature, which
 * then owns a body of its own and leaves its source live). A v22 client would
 * move the source instead and lose the copy's body, so the bump makes it
 * refuse the document.
 *
 * v24 adds the Stage 4 solid options: the extrude `intersect` result intent
 * (ZC-060) and keep-originals on Boolean (`keepOriginals`) and Split
 * (`keepOriginal`) (M11). A v23 client would rebuild an intersect extrude
 * as a cut and hide bodies the feature keeps, so the bump makes it refuse
 * such a document. Every field is optional; absent is the v23 behaviour.
 *
 * v25 adds two R01 datum-plane definitions, `three-point` and
 * `parallel-point`, and the point sources they read (world coordinates or an
 * edge's end vertex). An older client would refuse or misread such a datum
 * and every sketch, Split and Mirror built on it, so the bump makes it refuse
 * the document instead. Existing datums are unchanged.
 *
 * v26 adds S04 composite identity (`SketchNode.composites`): a rectangle or
 * polygon drawn in the viewport is real lines held by persisted relations,
 * and the composite record names those lines as one object with ordered
 * corners and sides. An older client would drop the record on its next save and
 * leave four unrelated lines, so the bump makes it refuse such a document.
 * Absent means no composites: every older rectangle and polygon object loads
 * unchanged and is never decomposed.
 *
 * v27 adds the I01 curve entities: the `ellipse` sketch object (a full
 * ellipse, or an elliptical arc when it carries a parameter range) and the
 * `spline` object (a fit spline through points or a control-point B-spline).
 * An older client would refuse or drop such an object and every profile it
 * bounds, so the bump makes it refuse the document instead. Existing objects
 * are unchanged.
 *
 * v28 adds R01 datum axes: the `datum-axis` feature kind (through two points,
 * along a straight edge, the axis of a cylinder or cone, or where two planes
 * meet) and the references that turn geometry about one: a revolve's
 * `axisRef`, a circular pattern's `axisRef` and a Move's `axisRotation`. An
 * older client would build those features about their stored sketch or world
 * axis instead, so the bump makes it refuse such a document. Every field is
 * optional; absent is the v27 behaviour.
 *
 * v29 adds two F01 extrude options: the `to-face` end condition, whose
 * `toFace` names a planar face by verified lineage and derives the distance
 * from it on every rebuild, and `draftAngleDeg`, which tapers the extrusion's
 * walls from the sketch plane. An older client would replay either at its
 * stale blind distance or with straight walls, so the bump makes it refuse
 * such a document. Both are optional; absent is the v28 extrude.
 *
 * v30 adds the D01 drawing section (`ProjectDocument.drawings`): sheets with
 * paper, scale, projection angle and title-block text, each holding placed
 * orthographic and isometric views of named bodies and a fingerprint of the
 * model they were last drawn from. Additive: absent means no drawings, and
 * every older document loads unchanged. An older client would drop the
 * section on its next save, so the bump makes it refuse such a document.
 *
 * v31 adds D02 drawing annotations (`DrawingSheet.annotations`): linear,
 * aligned, radius, diameter and angle dimensions that name the model edges
 * they measure by persistent reference, and text notes with optional
 * leaders. Additive: absent means a sheet has none, and every v30 document
 * loads unchanged. An older client would refuse the unknown field or drop
 * it on save, so the bump makes it refuse such a document.
 *
 * v32 adds the I05 reference-image section (`ProjectDocument.referenceImages`):
 * PNG and JPEG pictures placed on a principal plane, a datum plane or a
 * planar face, with their in-plane position, turn, width and opacity. The
 * pixels are never embedded: each image holds the SHA-256 of its file, whose
 * bytes live in the source blob store and its `reference-image` artifact.
 * Additive: absent means no images, every older document loads unchanged, and
 * images are never features or bodies, so no build or export reads them. An
 * older client would drop the section on its next save, so the bump makes it
 * refuse such a document.
 *
 * v33 adds I01 sketch projection (`SketchObjectData.projection`): a line,
 * arc, circle or ellipse projected from a model edge records the edge (by
 * schema-v5 lineage) and whether it stays linked to it or was copied once.
 * A linked projection is re-projected at the sketch's history position on
 * every rebuild. An older client would keep the stored geometry and drop the
 * link on its next save, so the bump makes it refuse such a document.
 * Absent means an ordinary drawn object, so every older document loads
 * unchanged.
 *
 * v34 adds the U06 Objects folders (`ProjectDocument.objectFolders`): named,
 * nestable folders and the bodies placed in them. Organization only — no
 * rebuild reads it. Additive: absent means no folders. An older client would
 * drop the section on its next save, so the bump makes it refuse such a
 * document.
 *
 * v35 adds optional S02 reference-distance modes. Absent means the existing
 * absolute distance; horizontal/vertical measure sketch-local X/Y separation.
 * Older clients must refuse rather than show those as Euclidean distances.
 */
// v36 adds composite-named reference corners/sides with explicit topology.
// Older clients must refuse instead of dropping or reinterpreting targets.
// v37 adds authored boundary provenance and explicit legacy conversion ownership.
// v38 adds U09 region profiles on revolve features (`profile`). An older
// client would revolve the sketch's first object instead, so it must refuse.
export const PROJECT_DOCUMENT_SCHEMA_VERSION = 38 as const;
export type ProjectDocumentSchemaVersion =
  typeof PROJECT_DOCUMENT_SCHEMA_VERSION;

export type UnitSystem = 'mm' | 'cm' | 'm' | 'inch';
/** F05: what a typed parameter measures. Absent on a node is unitless. */
export type ParameterKind = 'length' | 'angle' | 'number';
/** F01 extrude extents; to-next/offset-from-face are later slices. */
export type ExtrudeEndCondition = 'blind' | 'through-all' | 'to-face';
export type ThroughAllSide = 'forward' | 'backward' | 'both';
export type PlaneId = 'XY' | 'XZ' | 'YZ';
/** See `SketchPlaneRef`'s `basisRevision`; absent means revision 1. */
export type CanonicalPlaneBasisRevision = 2;
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
  | 'imported-mesh'
  | 'datum-plane'
  | 'datum-axis';
export type SketchObjectKind =
  | 'rectangle'
  | 'circle'
  | 'polygon'
  | 'line'
  | 'arc'
  | 'ellipse'
  | 'spline'
  | 'text';
/**
 * How a spline is defined (I01, schema v27): `fit` interpolates its points,
 * `control` treats them as the control polygon of a clamped B-spline.
 */
export type SketchSplineMethod = 'fit' | 'control';
/**
 * Control-spline degrees the sketch offers. A fit spline sets its own: cubic,
 * or quadratic through only three open points.
 */
export type SketchSplineDegree = 2 | 3;
/**
 * Font style of a text sketch object. Each style is a distinct bundled font
 * file — never a synthetic shear or emboldening — so the letterforms are the
 * ones the type designer drew.
 */
export type TextFontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';
export type TextAlign = 'left' | 'center' | 'right';
export type BooleanOperation = 'union' | 'subtract' | 'intersect';
/**
 * M11: which inputs a Boolean leaves live beside its result. The target is
 * the first body (a subtract's base); the tools are the rest. Absent keeps
 * none, the consume-everything Boolean every document before v24 stores.
 */
export type BooleanKeepOriginals = 'all' | 'target' | 'tools';
export type PatternKind = 'linear' | 'circular' | 'grid';
export type AxisId = 'x' | 'y' | 'z';

/**
 * How a variable-radius fillet runs between its two end radii.
 *
 * Deliberately only the two laws the kernel qualifies. Remus ships
 * variable-radius blending as an experimental capability with declared
 * bounds: a standard radius law whose extrema over the whole edge are its
 * own endpoints can be proved safe, and anything else — an interior peak, a
 * sampled law, a setback corner — is outside what it certifies. Both laws
 * here are monotone between `radius` and `endRadius`, so the blend's largest
 * and smallest ball are the two the user typed.
 *
 * Not a closed set at the kernel boundary: `filletVariable` silently treats
 * an unrecognized law as a CONSTANT blend at the start radius rather than
 * refusing, so a law outside this union has to be rejected before the call
 * rather than after it. See `assertQualifiedVariableFillet` in the kernel
 * adapter.
 */
export type VariableFilletLaw = 'linear' | 'scurve';

/** The runtime form of {@link VariableFilletLaw}, for validating documents. */
export const VARIABLE_FILLET_LAWS: readonly VariableFilletLaw[] = [
  'linear',
  'scurve'
];

export function isVariableFilletLaw(law: unknown): law is VariableFilletLaw {
  return (
    typeof law === 'string' &&
    (VARIABLE_FILLET_LAWS as readonly string[]).includes(law)
  );
}

/**
 * A parametric scalar: either a literal number or an expression string that is
 * evaluated against the document's parameter table when geometry is rebuilt
 * (e.g. `"width / 2 + 5"`). Storing the raw expression keeps features fully
 * parametric — editing a parameter regenerates every feature that uses it.
 */
export type ParamValue = number | string;
export const MAX_SKETCH_POLYGON_SIDES = 64;
export const MAX_SKETCH_ARC_SWEEP_DEGREES = 360;
/** Fit points or control points one spline may hold. */
export const MAX_SKETCH_SPLINE_POINTS = 64;
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
   * Uniform scale factor about the pivot, applied before rotation and
   * translation. Absent means 1 (no scaling); the rebuild rejects values that
   * do not resolve to a positive finite number. Uniform only: the exact
   * kernel preserves analytic surfaces under conformal maps, and a
   * non-uniform factor would silently degrade cylinders to NURBS.
   */
  scale?: ParamValue;
  /**
   * M10 (schema v22): the point rotation and scale turn about, in document
   * units; the translation then moves the result. Absent is the world origin,
   * as every older document stores it. The Move gizmo writes the body's
   * centre here, so a later edit to its rotation still turns the body in
   * place rather than about the origin.
   */
  pivot?: ParametricVector3;
}

/** Parametric plane used by exact mirror features. */
export interface ParametricPlane {
  origin: ParametricVector3;
  /** Resolved and normalized during exact preflight; zero vectors are invalid. */
  normal: ParametricVector3;
}

/**
 * A reference to an R01 datum plane by the feature that defines it. The
 * datum resolves once, at its own history position; every consumer reads
 * that result and never re-derives a plane from final topology.
 */
export interface DatumPlaneRef {
  type: 'datum';
  datumFeatureId: FeatureId;
}

/** A Split or Mirror plane: authored numbers, or a datum by reference. */
export type ModelingPlaneReference = ParametricPlane | DatumPlaneRef;

export function isDatumPlaneRef(
  plane: ModelingPlaneReference | SketchPlaneRef
): plane is DatumPlaneRef {
  return (plane as { type?: unknown }).type === 'datum';
}

/**
 * Schema v28: a reference to an R01 datum axis by the feature that defines
 * it. Like a datum plane, the axis resolves once at its own history position
 * and every consumer reads that line; nothing re-derives it from final
 * topology.
 */
export interface DatumAxisRef {
  type: 'datum-axis';
  datumFeatureId: FeatureId;
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
  /** A 0/1 on/off control. Bound bodies are omitted from display and exports
   * while off; their geometry and downstream feature history remain intact.
   * An empty list is a general boolean parameter usable in expressions. */
  toggle?: { bodyIds: BodyId[] };
  expression: string;
  value: number;
  /**
   * F05 (schema v21): what the parameter measures. A length or angle enters
   * expressions with that dimension, so `width + 5 mm` evaluates and a length
   * in an angle field is refused; a number is unit-free (counts, ratios).
   * Absent is the legacy unitless parameter: dimensionless everywhere, as in
   * every document before v21, and never retyped without the owner's say.
   * (Named `quantity` because `kind` is the node discriminator.)
   */
  quantity?: ParameterKind;
  /**
   * Offered in Tweak mode and through a share link. Absent means the row has
   * not been curated. A wholly uncurated model exposes every parameter for
   * backwards compatibility; the first eye-toggle materializes that effective
   * state before changing one row. See `listExposedParameters` in
   * document-core, which also interprets legacy partially-curated documents.
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
  | DatumPlaneRef
  | {
      type: 'canonical';
      plane: PlaneId;
      offset: ParamValue;
      /**
       * Schema v16: which basis the plane's stored coordinates were drawn
       * against. Absent is revision 1, the bases every sketch written before this field
       * resolves to; 2 turns the XZ plane to face the Front view (u = +X,
       * v = +Z, normal -Y) so a sketch entered on it reads +u right and +v up
       * instead of mirrored behind the model. XY and YZ are the same in both
       * revisions, so only XZ refs carry it.
       *
       * Like {@link SketchPlaneRef.sourceCentroid}, this is a marker rather
       * than a preference: rewriting an existing sketch's basis would move
       * its geometry and flip its extrudes, so new sketches take revision 2
       * and saved ones keep what they were drawn against.
       */
      basisRevision?: CanonicalPlaneBasisRevision;
    }
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

/** A canonical plane (optionally offset), as a datum source. */
export type CanonicalPlaneSource = Extract<
  SketchPlaneRef,
  { type: 'canonical' }
>;

/**
 * A qualified exact planar face, as a datum source: lineage and the
 * area-centroid anchor are both required, so the datum's origin never
 * depends on the legacy vertex-mean marker.
 */
export type FacePlaneSource = Extract<SketchPlaneRef, { type: 'face' }> & {
  faceReference: FaceTopologyReferenceV5;
  sourceCentroid: Vector3;
};

/**
 * F01 (schema v29): the face a `to-face` extrude reaches, in the same
 * lineage-qualified shape an R01 datum's face source uses, so one pick, one
 * resolver and one re-pick repair serve both.
 */
export type ExtrudeToFaceTarget = FacePlaneSource;

export type DatumPlaneSource =
  CanonicalPlaneSource | DatumPlaneRef | FacePlaneSource;

/**
 * Schema v25: a model vertex, named as one end of an open edge whose
 * schema-v5 lineage the exact build re-finds at the datum's history position.
 * `end` 0 is the end whose quantized (ADR-011) coordinates sort first by x,
 * then y, then z, which both kernels read identically; the vertex's exact
 * position is then taken from the resolved edge. A deleted, ambiguous or
 * closed edge refuses by name. No vertex is guessed by proximity.
 */
export interface EdgeVertexPointSource {
  type: 'edge-vertex';
  bodyId: BodyId;
  edgeReference: EdgeTopologyReferenceV5;
  end: 0 | 1;
}

/**
 * Schema v25: a point a datum plane passes through: expression-capable world
 * coordinates in document units, or a model vertex by reference.
 */
export type DatumPointSource =
  { type: 'point'; point: ParametricVector3 } | EdgeVertexPointSource;

export type DatumPlaneDefinition =
  | {
      kind: 'offset';
      source: DatumPlaneSource;
      /** Signed distance along the source normal; zero is the source. */
      offset: ParamValue;
      /** Flips the result's normal (and v) without moving it. */
      reverseNormal?: boolean;
    }
  | {
      kind: 'midplane';
      /** Ordered roles A and B; the result keeps A's frame. */
      sources: [DatumPlaneSource, DatumPlaneSource];
      reverseNormal?: boolean;
    }
  | {
      /**
       * Schema v25: the plane through three points. The origin is the first
       * point, u points at the second, and the normal follows the right-hand
       * rule (first → second → third). Coincident or collinear points are
       * refused; no plane is guessed.
       */
      kind: 'three-point';
      points: [DatumPointSource, DatumPointSource, DatumPointSource];
      reverseNormal?: boolean;
    }
  | {
      /**
       * Schema v25: the plane parallel to `source` through `point`, keeping
       * the source's axes. A point on the source gives the source itself.
       */
      kind: 'parallel-point';
      source: DatumPlaneSource;
      point: DatumPointSource;
      reverseNormal?: boolean;
    };

/**
 * Schema v28: a straight model edge, by its schema-v5 lineage, that a datum
 * axis runs along. The axis runs from the edge's end 0 to its end 1 (the
 * same quantized end order an `edge-vertex` uses), so neither kernel's edge
 * orientation decides its direction.
 */
export interface DatumAxisEdgeSource {
  type: 'edge';
  bodyId: BodyId;
  edgeReference: EdgeTopologyReferenceV5;
}

/**
 * Schema v28: a cylindrical or conical model face, by its schema-v5 lineage,
 * whose axis a datum axis follows.
 */
export interface DatumAxisFaceSource {
  type: 'face';
  bodyId: BodyId;
  faceReference: FaceTopologyReferenceV5;
}

/**
 * Schema v28: how a datum axis is built. Each is refused by name rather than
 * guessed when it has no single line: coincident points, an edge that is not
 * straight, a face that is not a cylinder or cone, parallel planes.
 * `reverseDirection` turns the axis end for end without moving it, which
 * reverses the sense of every angle measured about it.
 */
export type DatumAxisDefinition =
  | {
      /** From the first point toward the second; the origin is the first. */
      kind: 'two-point';
      points: [DatumPointSource, DatumPointSource];
      reverseDirection?: boolean;
    }
  | {
      /** Along a straight edge, from its end 0 toward its end 1. */
      kind: 'edge';
      source: DatumAxisEdgeSource;
      reverseDirection?: boolean;
    }
  | {
      /**
       * The axis of a cylindrical or conical face. A surface axis has no
       * preferred sense of its own, so the direction is canonical (its first
       * component beyond the direction quantum is positive) and kernel-neutral.
       */
      kind: 'cylinder';
      source: DatumAxisFaceSource;
      reverseDirection?: boolean;
    }
  | {
      /**
       * Where two planes meet, along A's normal × B's normal. The origin is
       * the point of the line nearest A's origin. Parallel planes have no
       * intersection line and are refused.
       */
      kind: 'plane-intersection';
      sources: [DatumPlaneSource, DatumPlaneSource];
      reverseDirection?: boolean;
    };

/** The plane sources a datum axis definition reads, in role order. */
export function datumAxisPlaneSources(
  definition: DatumAxisDefinition
): DatumPlaneSource[] {
  return definition.kind === 'plane-intersection'
    ? [...definition.sources]
    : [];
}

/** The point sources a datum axis definition reads, in role order. */
export function datumAxisPointSources(
  definition: DatumAxisDefinition
): DatumPointSource[] {
  return definition.kind === 'two-point' ? [...definition.points] : [];
}

/** The bodies whose topology a datum axis reads, like {@link datumSourceBodyIds}. */
export function datumAxisSourceBodyIds(
  definition: DatumAxisDefinition
): BodyId[] {
  const bodies = new Set<BodyId>();
  if (definition.kind === 'edge' || definition.kind === 'cylinder')
    bodies.add(definition.source.bodyId);
  for (const source of datumAxisPlaneSources(definition))
    if (source.type === 'face') bodies.add(source.bodyId);
  for (const point of datumAxisPointSources(definition))
    if (point.type === 'edge-vertex') bodies.add(point.bodyId);
  return [...bodies];
}

/**
 * Every datum axis a feature turns about: a revolve's or circular pattern's
 * `axisRef` and a Move's `axisRotation`. Suppressed features count; their
 * references are still live.
 */
export function featureDatumAxisRefs(data: FeatureData): DatumAxisRef[] {
  switch (data.featureKind) {
    case 'revolve':
    case 'pattern':
      return data.axisRef ? [data.axisRef] : [];
    case 'transform':
      return data.axisRotation ? [data.axisRotation.axis] : [];
    default:
      return [];
  }
}

/** The plane sources a datum definition reads, in role order. */
export function datumPlaneSources(
  definition: DatumPlaneDefinition
): DatumPlaneSource[] {
  switch (definition.kind) {
    case 'offset':
    case 'parallel-point':
      return [definition.source];
    case 'midplane':
      return [...definition.sources];
    case 'three-point':
      return [];
  }
}

/** The point sources a datum definition reads, in role order. */
export function datumPointSources(
  definition: DatumPlaneDefinition
): DatumPointSource[] {
  switch (definition.kind) {
    case 'three-point':
      return [...definition.points];
    case 'parallel-point':
      return [definition.point];
    default:
      return [];
  }
}

/**
 * The bodies whose topology a datum reads: face sources and vertex sources.
 * A datum resolving through one of these consumes its identity just as a
 * face-attached sketch does.
 */
export function datumSourceBodyIds(definition: DatumPlaneDefinition): BodyId[] {
  const bodies = new Set<BodyId>();
  for (const source of datumPlaneSources(definition))
    if (source.type === 'face') bodies.add(source.bodyId);
  for (const point of datumPointSources(definition))
    if (point.type === 'edge-vertex') bodies.add(point.bodyId);
  return [...bodies];
}

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
  /**
   * Plane-local offsets for driving-dimension labels. The offset is relative
   * to the derived geometric anchor, so parameter edits move the label with
   * its dimension while preserving the user's decluttering choice.
   *
   * The map is string-keyed presentation state shared by S01 driving rows
   * (keyed by `constraintId`) and S02 reference rows (keyed by
   * `annotationId`). Callers must use an explicit {@link SketchDimensionIdentity};
   * a bare string must never be resolved by searching both arrays.
   */
  dimensionLabelPositions?: Record<string, SketchDimensionLabelPosition>;
  /**
   * Saved reference (driven) dimensions. Schema v15, additive: absent means
   * no reference dimensions, so every earlier document replays untouched and
   * a document without reference dimensions serializes byte-identically.
   *
   * A reference row owns an `annotationId`, stores only target identity, and
   * derives its measured value from current sketch geometry. It never enters
   * GCS, never changes a `SketchObjectData` field, and never becomes a
   * constraint through a click or a label drag.
   */
  referenceDimensions?: SketchReferenceDimension[];
  /**
   * S04 composite identity (schema v26, additive): rectangles and polygons
   * drawn as lines, each named as one object. Absent means none, so every
   * earlier document replays untouched; a legacy `rectangle` or `polygon`
   * object is never rewritten into one.
   */
  composites?: SketchComposite[];
  /** Explicit legacy-to-line conversion witnesses and versioned aliases. */
  promotions?: SketchPromotion[];
}

export interface SketchDimensionLabelPosition {
  x: number;
  y: number;
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
   * One line tangent to one circle or arc, in either order.
   *
   * The circle form is point-free: the kernel's `tangentLineCircle`
   * constrains center-to-line distance to the radius, so no contact point is
   * needed and `at` is absent. The arc form is the kernel's
   * `tangentLineArc`, which asks which point of the arc the line touches, so
   * `at` names that arc point; it is what a sketch fillet records about the
   * arc it inserted. A constraint written before the arc form existed has no
   * `at` and replays exactly as it did.
   */
  | {
      constraintKind: 'tangent';
      a: EntityId;
      b: EntityId;
      at?: SketchPointRef;
    }
  | { constraintKind: 'concentric'; a: EntityId; b: EntityId }
  | { constraintKind: 'midpoint'; point: SketchPointRef; line: EntityId }
  | {
      constraintKind: 'distance';
      a: SketchPointRef;
      b: SketchPointRef;
      value: ParamValue;
    }
  | { constraintKind: 'radius'; objectId: EntityId; value: ParamValue }
  | { constraintKind: 'angle'; a: EntityId; b: EntityId; valueDeg: ParamValue }
  /** Two points mirrored about a line: the axis bisects them at a right angle. */
  | {
      constraintKind: 'symmetric';
      a: SketchPointRef;
      b: SketchPointRef;
      axis: EntityId;
    }
  /**
   * A point held on a line (or its extension), a circle, or an arc's circle.
   * The point stays free to slide along the curve.
   */
  | {
      constraintKind: 'point-on-object';
      point: SketchPointRef;
      objectId: EntityId;
    }
  /**
   * A point held at a fixed position in sketch coordinates, recorded when the
   * lock was made. An edit that would move it conflicts instead of dragging
   * the lock along; removing the constraint unlocks the point.
   */
  | { constraintKind: 'lock'; point: SketchPointRef; x: number; y: number };

export type SketchConstraintKind = SketchConstraintData['constraintKind'];

export interface SketchConstraint {
  constraintId: SketchConstraintId;
  data: SketchConstraintData;
  /** Absent remains an ordinary user constraint. */
  origin?: 'user' | 'promotion-structure';
  /** Required only for structure owned by an explicit legacy conversion. */
  promotionId?: string;
}

/**
 * Target identity for an S02 reference (driven) dimension. Supports primitive
 * sketch identities: line endpoints, circle/arc
 * centers, and arc start/end points for distance; circles and arcs for
 * radius; line objects and named held-line composite sides for angle. Named
 * held-line corners also support distance; datum/world-space targets remain
 * outside this contract.
 */
export type SketchReferenceDistanceMode =
  'absolute' | 'horizontal' | 'vertical';

/** Measured targets; driving constraints retain primitive point identities. */
export type SketchReferencePointTarget =
  SketchPointRef | SketchCompositeCornerTarget;
export type SketchReferenceCurveTarget = EntityId | SketchCompositeSideTarget;

export type SketchReferenceDimensionData =
  | {
      dimensionKind: 'distance';
      a: SketchReferencePointTarget;
      b: SketchReferencePointTarget;
      /** Absent is absolute; projected modes follow the sketch's local axes. */
      distanceMode?: SketchReferenceDistanceMode;
    }
  | { dimensionKind: 'radius'; objectId: EntityId }
  | {
      dimensionKind: 'angle';
      a: SketchReferenceCurveTarget;
      b: SketchReferenceCurveTarget;
    };

/**
 * A saved sketch annotation. It owns an `annotationId`, stores only target
 * identity, and derives a measured value from the current sketch geometry.
 * It carries no authored numeric value and no `ParamValue` field, so a stale
 * saved number can never be mistaken for current geometry and the record is
 * incapable of constraining the model by deserialization alone.
 *
 * The id is created once, retained when the target's parameters move, and
 * supplied again on command replay. It is never derived from target order or
 * the current numeric result.
 */
export interface SketchReferenceDimension {
  annotationId: SketchReferenceAnnotationId;
  data: SketchReferenceDimensionData;
}

/**
 * Explicit tagged identity for a dimension label or list row when driving
 * constraints and reference annotations appear together. `constraintId`
 * remains reserved for `SketchConstraint`; `annotationId` is reserved for
 * `SketchReferenceDimension`.
 */
export type SketchDimensionIdentity =
  | { kind: 'constraint'; constraintId: SketchConstraintId }
  | { kind: 'reference'; annotationId: SketchReferenceAnnotationId };

/**
 * How a composite was drawn. It decides which relations hold the shape
 * (horizontal/vertical sides for an axis-aligned rectangle, perpendicular
 * and parallel sides for a three-point one, equal sides on a circumcircle
 * for a polygon) and what a resize holds still: a corner rectangle keeps
 * corner 0, a centre rectangle keeps its centre.
 */
export type SketchCompositeData =
  | {
      compositeKind: 'rectangle';
      method: 'corner' | 'center' | 'three-point';
    }
  | {
      compositeKind: 'polygon';
      /** Vertices lie on the construction circle: its radius is the circumradius. */
      method: 'inscribed';
    };

export type SketchCompositeKind = SketchCompositeData['compositeKind'];

/**
 * S04: a rectangle or regular polygon drawn as real `line` objects, named as
 * one object. The shape's intent lives in ordinary persisted relations
 * (coincident corners, horizontal/vertical or perpendicular/parallel sides,
 * equal sides), so the solver, dimensions and modify tools treat its sides
 * like any other lines. This record adds the identity those relations
 * cannot carry: which lines form one shape, and in what order.
 *
 * Side `i` is `edgeIds[i]`; it runs from corner `i` to corner `i + 1`
 * (wrapping), counter-clockwise, so corner `i` is the start of side `i` and
 * is held to the end of side `i - 1` by a coincident relation. Corner and
 * side identity is therefore an index into this list, never a coordinate.
 * A polygon walked clockwise resolves as broken. A rectangle that an edit
 * has mirrored through itself still resolves: its corners keep their
 * indices, and nothing about it depends on the direction of the walk.
 *
 * `helperIds` are construction geometry the composite owns: a centre
 * rectangle's two diagonals (whose crossing is the centre) and a polygon's
 * circumcircle. Deleting any member dissolves the record; the lines and
 * their remaining relations stay.
 */
export type SketchComposite = SketchCompositeData & {
  compositeId: SketchCompositeId;
  edgeIds: EntityId[];
  helperIds?: EntityId[];
};

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
      /**
       * I01 (schema v27). The point at parameter `t` is
       * `center + radiusX·cos t·u + radiusY·sin t·v`, where `u` is the sketch
       * x axis turned counter-clockwise by `rotationDeg` and `v` is `u` turned
       * a further 90°. Either radius may be the larger one; which is the major
       * axis is a property of the values, not of the field names.
       */
      objectKind: 'ellipse';
      centerX: ParamValue;
      centerY: ParamValue;
      radiusX: ParamValue;
      radiusY: ParamValue;
      rotationDeg: ParamValue;
      /**
       * An elliptical arc: the counter-clockwise parameter range from
       * `startParamDeg` to `endParamDeg`, in degrees of the parameter `t`
       * above (the eccentric anomaly, not the polar angle). Both present or
       * both absent; absent is the full ellipse.
       */
      startParamDeg?: ParamValue;
      endParamDeg?: ParamValue;
    }
  | {
      /**
       * I01 (schema v27). A non-rational B-spline. A `fit` spline passes
       * through every point (cubic, chord-length parameterized; quadratic
       * through only three open points); a `control`
       * spline is the clamped uniform B-spline of `degree` over the points as
       * its control polygon. A `closed` spline is periodic: the curve joins
       * itself smoothly and no endpoint is repeated in `points`. The curve is
       * re-derived from these fields on every rebuild, never stored.
       */
      objectKind: 'spline';
      method: SketchSplineMethod;
      /** Control-spline degree; ignored for a fit spline. */
      degree?: SketchSplineDegree;
      points: { x: ParamValue; y: ParamValue }[];
      closed?: boolean;
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
  /**
   * I01 (schema v33): this object was projected from a model edge. Only
   * lines, arcs, circles and ellipses carry it. Absent is ordinary drawn
   * geometry.
   */
  projection?: SketchProjection;
};

/**
 * I01 (schema v33): the model edge a projected sketch object came from: a
 * body and one of its edges by schema-v5 lineage, re-found at the sketch's
 * history position. No edge is ever found by proximity.
 */
export interface SketchProjectionSource {
  bodyId: BodyId;
  edgeReference: EdgeTopologyReferenceV5;
}

/**
 * I01 (schema v33): how a projected sketch object relates to its edge.
 *
 * - `linked`: the exact build re-projects the edge onto the sketch plane at
 *   the sketch's history position on every rebuild and builds from that, so
 *   the object follows upstream edits. The stored geometry is the last valid
 *   projection: it stands in, with a broken status, when the edge can no
 *   longer be re-found through verified lineage, and the solver holds it
 *   fixed.
 * - `unlinked`: the geometry was copied once and is ordinary editable
 *   geometry from then on. `source` stays as provenance only (absent when
 *   the edge had no verified identity); nothing reads it during a rebuild.
 */
export type SketchProjection =
  | { mode: 'linked'; source: SketchProjectionSource }
  | { mode: 'unlinked'; source?: SketchProjectionSource };

export type SketchProjectionMode = SketchProjection['mode'];

/** Object kinds a projection can produce (and so may carry `projection`). */
export const SKETCH_PROJECTION_OBJECT_KINDS = [
  'line',
  'arc',
  'circle',
  'ellipse'
] as const satisfies readonly SketchObjectKind[];

/**
 * I01: what the exact build found for one linked projection at its sketch's
 * history position.
 *
 * - `current`: the re-projected edge matches the stored geometry.
 * - `moved`: the edge resolved but projects elsewhere now (an upstream edit
 *   moved it). The build used `data`; the app writes it back to the object.
 * - `broken`: the edge could not be re-found through verified lineage (its
 *   feature was deleted or suppressed, or the edge was consumed), or it no
 *   longer projects to the same kind of curve. The build used the stored,
 *   last valid geometry; repairing needs an explicit re-pick or unlink.
 */
export type SketchProjectionState =
  | { status: 'current' }
  | { status: 'moved'; data: SketchObjectData }
  | { status: 'broken'; reason: string };

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

/**
 * Persistent result mode chosen when an extrusion is first created.
 * `intersect` (ZC-060, schema v24) keeps only the material the extrusion and
 * its target share; it is always explicit, never inferred.
 */
export type ExtrudeOperation = 'new-body' | 'add' | 'cut' | 'intersect';

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
  /** Authored curve identity by loop, retaining repeated split-edge tokens. */
  sourceBoundaryLoops?: BoundaryProvenance;
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

/**
 * An in-place Move/Rotate/Scale: it rewrites `targetBodyId` and owns no body.
 * A transform copy (M10, `copy: true`) is not one: it owns its own body and
 * leaves the target untouched, so placement and in-place-edit rules that
 * read "the transform of body X" must skip it.
 */
export function isInPlaceTransform(
  data: FeatureData
): data is Extract<FeatureData, { featureKind: 'transform' }> {
  return data.featureKind === 'transform' && data.copy !== true;
}

/** M10: a transform that adds a moved copy and leaves its source live. */
export function isTransformCopy(data: FeatureData): data is Extract<
  FeatureData,
  { featureKind: 'transform' }
> & {
  copy: true;
} {
  return data.featureKind === 'transform' && data.copy === true;
}

export type FeatureData =
  | {
      /**
       * R01: a datum plane. It owns no body; its resolved frame is published
       * at its history position for the sketches, Splits and Mirrors that
       * reference it by this feature's id.
       */
      featureKind: 'datum-plane';
      definition: DatumPlaneDefinition;
    }
  | {
      /**
       * R01 (schema v28): a datum axis. Like a datum plane it owns no body;
       * its resolved line is published at its history position for the
       * revolves, circular patterns and Moves that turn about it.
       */
      featureKind: 'datum-axis';
      definition: DatumAxisDefinition;
    }
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
      /** Required for stored add/cut/intersect and absent for new-body. */
      targetBodyId?: BodyId;
      /**
       * F01 (schema v20): how far the extrusion reaches. Absent is `blind`,
       * the `distance`/`symmetric`/`backDistance` extrude every older document
       * stores. `through-all` cuts through the whole target along the sketch
       * normal: the span is recomputed from the target at the feature's
       * history position on every rebuild and never stored, and `distance`
       * is kept only so switching back to blind restores it.
       */
      endCondition?: ExtrudeEndCondition;
      /** Required with `through-all`; which side(s) of the sketch plane. */
      throughAllSide?: ThroughAllSide;
      /**
       * F01 (schema v29): required with `to-face` and absent otherwise. The
       * extrusion runs from the sketch plane to this planar face, which must
       * be parallel to it; the face is re-found through its verified lineage
       * at the feature's history position on every rebuild, and the distance
       * is derived from it, never stored. A face that no longer resolves
       * leaves the feature unresolved (it refuses by name) until a re-pick
       * replaces this target; `distance` is kept only so switching back to
       * blind restores it.
       */
      toFace?: ExtrudeToFaceTarget;
      /**
       * F01 (schema v29): wall draft in degrees, measured from the sketch
       * normal. Positive tapers the walls inward as the extrusion leaves the
       * sketch plane (the profile is the widest section), negative flares
       * them outward. The sketch plane is the neutral plane, so the profile
       * itself never changes. Absent or zero means straight walls. A one-sided
       * blind or to-face extrusion only: symmetric, two-sided and through-all
       * extents refuse it until per-side draft lands.
       */
      draftAngleDeg?: ParamValue;
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
      /**
       * R01 (schema v28): turn the profile about a datum axis instead of the
       * sketch's `axis`. The axis must lie in the sketch plane; one that
       * leaves it is refused by name rather than projected. `axis` is kept,
       * so clearing this restores the sketch axis the revolve had.
       */
      axisRef?: DatumAxisRef;
      /**
       * U09 (schema v38): the closed region the revolve turns, by the same
       * persistent reference a region extrude stores. Absent is the v37
       * behaviour, where the sketch's first object is the profile; that
       * cannot revolve a rectangle drawn as four edges, which is every
       * rectangle drawn since S04.
       */
      profile?: SketchProfileReference;
    }
  | {
      featureKind: 'loft';
      /** User-authored section order; at least two are required. */
      sections: SketchSectionReference[];
      mode: 'ruled' | 'smooth';
      /**
       * Apex point closing the loft after its last section, so that end comes
       * to a point instead of a flat cap. Absent means the flat cap every
       * document written before this field existed had, and the builder then
       * takes the unchanged `loft`/`loftSmooth` call.
       *
       * Ruled mode only: the pinned kernel's smooth section surfaces do not
       * close against an apex, and the adapter refuses the combination by
       * name rather than emitting the invalid solid it produces.
       *
       * There is deliberately no matching apex before the first section: the
       * kernel's `startPoint` leaves one apex facet out of the tessellation on
       * a rectangular profile, so that end is pointed by reversing the section
       * order instead. See `HANDOFF.md` for the measurement.
       */
      endPoint?: ParametricVector3;
    }
  | {
      featureKind: 'sweep';
      profile: SketchSectionReference;
      path: SketchPathReference;
      mode: 'standard' | 'smooth';
      /**
       * Guide rail whose direction the profile's up-vector tracks along the
       * path, replacing the rotation-minimizing frame. Absent means the
       * unchanged `sweepWithOptions`/`sweepAlongEdges` call, so a sweep
       * authored before this field existed replays identically.
       *
       * The kernel's guided sweep takes one spine curve and one rail curve,
       * so both the path and the rail must resolve to a single edge; the
       * adapter refuses anything wider by name.
       */
      guide?: SketchPathReference;
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
      /** Zero returns the first operand unchanged; omitted means active. */
      activeWhen?: ParamValue;
      operation: BooleanOperation;
      targetBodyIds: BodyId[];
      /**
       * M11 (schema v24): inputs left live beside the result instead of
       * consumed. Absent consumes every input, as before v24.
       */
      keepOriginals?: BooleanKeepOriginals;
    }
  | {
      featureKind: 'transform';
      targetBodyId: BodyId;
      transform: ParametricTransform3D;
      /**
       * M10 (schema v23): true makes this a copy. The feature then owns its
       * own `bodyId` (and body node), like a Mirror, and the target stays
       * live and unmoved. Absent is the in-place Move every older document
       * holds: it rewrites `targetBodyId` and has no body of its own.
       */
      copy?: true;
      /**
       * R01 (schema v28): turn the body `angleDeg` degrees about a datum
       * axis, right-handed about its direction, before `transform` applies
       * (so a translation then moves the turned body). Absent is the
       * Move every older document holds.
       */
      axisRotation?: { axis: DatumAxisRef; angleDeg: ParamValue };
    }
  | {
      featureKind: 'mirror';
      targetBodyId: BodyId;
      /** The original remains live; this feature owns only the mirrored copy. */
      plane: ModelingPlaneReference;
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
      plane: ModelingPlaneReference;
      /**
       * The half on the side the plane normal points away from. The
       * feature's own `bodyId` names the positive half; a `FeatureNode`
       * carries one body, so the second travels in the data, mirroring how
       * `targetBodyIds` carries body references.
       */
      secondBodyId: BodyId;
      /**
       * M11 (schema v24): leave the input body live beside the two halves.
       * Absent consumes it, as every split before v24 did; only `true` is
       * stored, so a cleared choice is the absent field, never `false`.
       */
      keepOriginal?: true;
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
      /**
       * The rolling-ball radius, and — when {@link endRadius} is present —
       * the radius at the start of each selected edge.
       */
      radius: ParamValue;
      /**
       * Variable-radius fillet: the radius at the far end of each selected
       * edge, in that edge's own direction. Absent means the constant-radius
       * fillet every earlier document stored, which still runs through the
       * constant blend entry point and replays unchanged.
       */
      endRadius?: ParamValue;
      /**
       * How the radius runs between `radius` and `endRadius`. Only read when
       * `endRadius` is present; absent reads as `'linear'`.
       */
      radiusLaw?: VariableFilletLaw;
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
      /**
       * Asymmetric chamfer: the setback measured on the SECOND of the two
       * faces each selected edge borders, with `distance` on the first. The
       * pair's order is the kernel's own edge-to-face order, which the
       * published `EdgeTopology.adjacentFaceHashes` deliberately sorts away —
       * the two setbacks are told apart in the viewport preview and swapped
       * from the form, not named from stored data.
       *
       * Absent means the symmetric chamfer. Mutually exclusive with
       * `angleDeg`: both express the same asymmetry and a document carrying
       * the two is refused rather than silently resolved one way.
       */
      distance2?: ParamValue;
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
      /**
       * R01 (schema v28), circular patterns only: turn the copies about a
       * datum axis, through its own origin, instead of the world `axis`
       * through the origin. Absent is the world axis every older pattern uses.
       */
      axisRef?: DatumAxisRef;
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
      /**
       * Flat xyz triples in document units, embedded. Written by imports
       * that predate `meshPayloadRef`, and still by the fallback when this
       * browser denies blob storage. Like `stepText`, never migrated into the
       * reference form. Present exactly when `indices` is, and exactly when
       * `meshPayloadRef` is not.
       */
      vertices?: number[];
      /** Triangle vertex indices, embedded alongside `vertices`. */
      indices?: number[];
      /**
       * Content-addressed alternative to `vertices`/`indices`: the SHA-256 of
       * the canonical payload (`encodeImportedMeshPayload`) holding the same
       * triangles in document units. The bytes live in the source blob store
       * and in the `mesh-payload` artifact named by `artifactId`, so neither
       * this node, its `import.mesh` command nor its undo entry repeats the
       * mesh. Schema v17 keeps clients that only understand embedded meshes
       * from accepting this document and silently omitting its imported body.
       */
      meshPayloadRef?: ImportedSourceReference;
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
      /** Exact, measured separation of raised planar lettering. Source bytes
       * remain immutable; every rebuild re-verifies the selected footprints. */
      planarEmboss?: {
        part: 'base' | 'text';
        selection: PlanarEmbossSelection;
        /** Fixed rigid moves in which the selection was measured. Rebuild
         * verifies the positioned source but returns the separated raw source;
         * ordinary transform features still perform the actual placement. */
        sourcePlacement?: Transform3D[];
      };
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

/**
 * Which recognizer proved a feature.
 *
 * Absent means the exact kernel-neutral recognizer, which has always published
 * holes, counterbores, countersinks, bosses and tapers, and whose proofs back
 * the coordinated direct-edit operations.
 *
 * `kernel-recognized` marks a family that recognizer does not publish, where
 * the geometry kernel's own recognizer supplied the candidate and the adapter
 * verified it against exact surfaces before publishing. Those features are
 * read-only: no coordinated edit operation may bind to one.
 */
export type RecognizedImportedFeatureProvenance = 'kernel-recognized';

interface RecognizedImportedFeatureBase {
  /** Canonical face used to re-run the proof during exact rebuild. */
  seedFaceHash: number;
  seedFaceReference?: FaceTopologyReferenceV5;
  /** All faces consumed by the proof, used to suppress weaker overlapping hints. */
  participatingFaceHashes: number[];
  /** Set only on read-only families; absent on every exactly proved feature. */
  provenance?: RecognizedImportedFeatureProvenance;
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
    })
  | (RecognizedImportedFeatureBase & {
      kind: 'fillet-band';
      /** Exact blend radius of the rolling ball that made the band. */
      radius: number;
      /** Exact length of the band's straight tangent contact with its walls. */
      length: number;
      /** `concave` rounds an internal corner, `convex` an external edge. */
      sense: 'concave' | 'convex';
    });

/**
 * Whether a recognized feature is read-only. A read-only feature is published
 * for reading and reasoning only: it carries no exact proof of the kind the
 * coordinated direct-edit operations replay, so nothing may bind an edit to it.
 */
export function isReadOnlyRecognizedImportedFeature(
  feature: Pick<RecognizedImportedFeature, 'provenance'>
): boolean {
  return feature.provenance !== undefined;
}

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

/**
 * Per-face on-demand recognition of one imported STEP face.
 *
 * Phase D of the imported STEP edit plan wires the existing
 * `recognizeImportedFeature` module through a lazy geometry-worker query into
 * the Inspector. The result rides this additive payload on top of the bulk
 * `recognizedImportedFeatures` list published at rebuild: `recognized` covers
 * a face the proof consumed, while `refusal` carries the typed refusal reason
 * for a face the proof declined. Presence is the contract — a face without
 * this field was never queried, not refused.
 */
export interface FaceRecognitionSummary {
  kind: 'recognized' | 'unsupported';
  /** Recognized feature kind, present only when `kind` is `recognized`. */
  featureKind?: RecognizedImportedFeature['kind'];
  /**
   * Stable refusal reason from the recognition module, present only when
   * `kind` is `unsupported`. Never a free-text guess.
   */
  refusalReason?: RecognitionRefusalReason;
  /** Human-readable recognition outcome, shown verbatim in the Inspector. */
  message: string;
  /**
   * Display dimensions in document units (diameters, depths, lengths, angles
   * in radians) keyed by the proof's own field names, minus identity fields.
   * Recognition dimensions arrive pre-scaled by the worker that measured them.
   */
  dimensions?: Record<string, number>;
}

/** Typed refusal reasons from the imported-feature recognition module. */
export type RecognitionRefusalReason =
  | 'seed-face-missing'
  | 'work-limit-exceeded'
  | 'unsupported-surface'
  | 'partial-revolution'
  | 'blend-detected'
  | 'rib-detected'
  | 'intersection-detected'
  | 'ambiguous-twins'
  | 'incomplete-proof';

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
  /**
   * How far {@link centroid} can be trusted. Mirrors the provenance the area
   * integrator reports: `exact` only when every boundary edge is a straight
   * line, `sampled` once any curved boundary is inscribed. Present only with
   * {@link centroid}; absent on older projections, which consumers must treat
   * as "assume approximate" rather than as "exact".
   */
  centroidProvenance?: FaceAreaProvenance;
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
   * On-demand per-face recognition outcome for an imported STEP face (Phase D
   * of the imported STEP edit plan). Additive only: queried lazily through
   * the geometry worker and cached by callers, never part of the rebuild
   * payload or any ADR-011 witness input.
   */
  recognition?: FaceRecognitionSummary;
  /**
   * Identity of the exact tangency-connected blend region, derived from the
   * ADR-011 hashes of its member faces: identical in every arena and every
   * rebuild of the same geometry. Not a durable reference — it changes
   * whenever the region's geometry does.
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

/**
 * Runtime-only identity qualified from native construction vertex subjects.
 * This is deliberately outside TopologyReferenceV5 and the document schema:
 * stored datum sources continue to address a named edge and canonical end.
 */
export interface RuntimeVertexReference {
  kind: 'vertex';
  producingFeatureId: FeatureId;
  lineageName: string;
  witnessVersion: 1;
  witness: { position: QuantizedTopologyPoint };
}

export type RuntimeVertexUnavailableReason =
  | 'journal-unavailable'
  | 'event-budget'
  | 'unsupported-source'
  | 'ambiguous-anchor'
  | 'conflicting-anchors'
  | 'stale-evidence';

/** Exact native vertex geometry, with the same body-scoped ids edges use. */
export interface VertexTopology {
  /** Transient body/solid numbering, never a WASM handle or persisted id. */
  id: number;
  point: Vector3;
  reference?: RuntimeVertexReference;
  unavailableReason?: RuntimeVertexUnavailableReason;
}

export interface BodyTopology {
  /** Independent exact raised-profile group; it does not require an opening. */
  recognizedPlanarEmboss?: PlanarEmbossSelection;
  faces: FaceTopology[];
  edges: EdgeTopology[];
  /** Derived native points; their optional references are runtime-only. */
  vertices?: VertexTopology[];
  /** Non-overlapping exact proofs created while imported topology is live. */
  recognizedImportedFeatures?: RecognizedImportedFeature[];
  /** Bounded imported-body dimensions with a successful changed-value proof. */
  opposingPlanarFacePairs?: OpposingPlanarFacePair[];
  /**
   * The body's symmetric straight-section opening, measured by the kernel
   * adapter for imported single-solid bodies. A recognized value is the
   * measured recipe the growing-holder compiler consumes; anything else says
   * why the body cannot be grown that way.
   */
  recognizedOpening?: OpeningRecognition;
  lineageDiagnostics?: TopologyLineageDiagnostic[];
}

export type OpeningAxis = 'x' | 'y' | 'z';

/**
 * The measured arm-height control of an opening: along `axis` (never the
 * opening axis) both ends have a straight section between `cuts`; material
 * beyond the upper cut moves with the height.
 */
export interface RecognizedArmHeight {
  axis: OpeningAxis;
  cuts: [number, number];
  /** Extent of the source along `axis`; the parameter's initial value. */
  sourceHeight: number;
  minimumHeight: number;
  /** Closed numeric line/arc profile of each end's straight section. */
  sections: { negative: SketchObjectData[]; positive: SketchObjectData[] };
  /** Longest straight run found on each end before the margin was applied. */
  straightRuns: { negative: [number, number]; positive: [number, number] };
}

/** Everything a growing-holder recipe needs except a name, body and parameters. */
export interface RecognizedOpening {
  axis: OpeningAxis;
  envelope: { min: Vector3; max: Vector3 };
  /** Coordinates along `axis` of the two cuts bounding the straight section. */
  cuts: [number, number];
  /** Coordinate along `axis` the two ends move symmetrically about. */
  center: number;
  sourceOpening: number;
  minimumOpening: number;
  /** Closed numeric line/arc profile of the straight section, in the sketch frame. */
  section: SketchObjectData[];
  /** Present when both ends also have a provable straight run along the arms. */
  height?: RecognizedArmHeight;
  /** Verified raised lettering on one rigid arm, kept together by the recipe. */
  lettering?: {
    selection: PlanarEmbossSelection;
    side: 'negative' | 'positive';
  };
}

export interface PlanarEmbossSelection {
  supportFaceHash: number;
  capFaceHashes: number[];
  normal: Vector3;
  depth: number;
  bounds: { min: Vector3; max: Vector3 };
}

export interface OpeningCandidate {
  axis: OpeningAxis;
  faceA: number;
  faceB: number;
  opening: number;
  /** Coordinates of the two inner faces along the axis, negative side first. */
  innerFaces: [number, number];
  overlapArea: number;
}

export interface OpeningEvidence {
  candidate: OpeningCandidate;
  /** Offset of the reflection plane that confirmed the center, and its coverage. */
  symmetry: { planeOffset: number; analyticCoverage: number };
  /** Longest interval between the inner faces whose section never changes. */
  straightRun: [number, number];
  sectionEdges: number;
  /** Why no arm-height control was measured, when the opening has none. */
  heightReason?: string;
}

export type OpeningRecognition =
  | {
      status: 'recognized';
      opening: RecognizedOpening;
      evidence: OpeningEvidence;
    }
  | { status: 'ambiguous'; reason: string; candidates: OpeningCandidate[] }
  | { status: 'unsupported'; reason: string };

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
  /** Worker-session projection identity; never substitutes for B-rep witnesses. */
  projectionRevision?: {
    session: string;
    geometry: number;
    topology: number;
    metadata: number;
  };
}

/** Validated display geometry; quantities and optional analysis are absent. */
export type GeometryBodyRepresentation = Omit<
  BodyRepresentation,
  'volume' | 'massProperties'
>;

/**
 * Disposable current-revision geometry, never a completed derived document.
 * Exact operations requiring analysis still await the completed result.
 */
export interface GeometryReadyState {
  /** Drag-only mesh publication: picking identities await complete topology. */
  topology?: 'pending';
  bodyRepresentations: Record<BodyId, GeometryBodyRepresentation>;
  warnings: string[];
  /** Current build attribution; never borrowed from a completed projection. */
  featureWarnings?: FeatureWarning[];
  updatedAt: string;
  analysis: 'pending';
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

/** A legacy direct-edit face proven by the successful original replay. */
export interface FaceReferenceRepair {
  featureId: FeatureId;
  faceHash: number;
  faceReference: FaceTopologyReferenceV5;
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
  /**
   * The exact kernel's own classification, present only when this warning
   * came from an operation the kernel refused with a category.
   *
   * Session-only like the rest of this record, and the field to branch on:
   * `message` is product copy and may be reworded at any time, while
   * `category` is the kernel's taxonomy — `quality_refused`, `unsupported`,
   * `resource_limit`, `nonconvergence`, `invalid_input`, `invalid_topology`,
   * `tolerance_violation`, `cancelled`, `internal`. It is typed as a string
   * rather than a union so a new kernel category cannot break a build here
   * before anyone has decided what it means.
   *
   * `family` says which kernel API refused, because the category alone does
   * not: `invalid_topology` from a boolean is a pair the engine would not
   * combine, and from a validation it is a body that came back malformed.
   * `operation` is present only for a family that names one — the booleans
   * do, a validation has no operand pair to name.
   *
   * This carried only booleans when it was introduced. Every family with a
   * typed twin on the pin now travels on the same field rather than growing
   * a second one beside it.
   */
  kernelRefusal?: {
    family: 'boolean' | 'validation' | 'healing' | 'import' | 'blend';
    operation?: string;
    category: string;
    code: string;
  };
}

/** Explicit, bounded foreground analysis; never part of canonical history. */
export interface EditAnalysisRequest {
  bodyId: string;
  /** Zero finds a bounded set; one or two restrict the measured face pair. */
  faceHashes: number[];
}

/** A resolved world frame: right-handed, u × v = normal. */
export interface DatumFrame {
  origin: Vector3;
  u: Vector3;
  v: Vector3;
  normal: Vector3;
}

/** A resolved datum axis: a point on the line and its unit direction. */
export interface DatumAxisLine {
  origin: Vector3;
  direction: Vector3;
}

export interface DerivedState {
  editAnalysis?: EditAnalysisRequest;
  bodyRepresentations: Record<BodyId, BodyRepresentation>;
  /**
   * R01: each datum plane's frame as the exact build resolved it at its own
   * history position, so the browser places datum-attached sketches exactly
   * as the kernel did. A datum that failed or is suppressed is absent.
   */
  datumFrames?: Record<FeatureId, DatumFrame>;
  /**
   * R01 (schema v28): each datum axis as the exact build resolved it at its
   * own history position. A datum axis that failed or is suppressed is absent.
   */
  datumAxes?: Record<FeatureId, DatumAxisLine>;
  /**
   * I01 (schema v33): each linked sketch projection's state as the exact
   * build found it at its sketch's history position, keyed by object id.
   * Unlinked projections and sketches the build did not reach are absent.
   */
  sketchProjections?: Record<string, SketchProjectionState>;
  /**
   * Session geometry from this exact build, including ordinary entities solved
   * against linked projections. Readers require both source identifiers to
   * match; authored nodes, expressions and history remain unchanged. Attaching
   * a result keeps this channel out of persisted documents.
   */
  sketchGeometry?: {
    projectId: ProjectId;
    documentVersion: number;
    objects: Record<string, SketchObjectData>;
  };
  exportableBodyIds: BodyId[];
  warnings: string[];
  updatedAt: string;
  /**
   * Advice to the session that ran this rebuild, not document state:
   * `attachDerivedState` strips it so it is never persisted or replayed.
   */
  referenceRepairs?: EdgeReferenceRepair[];
  /** Session-only direct-edit advice, stripped alongside edge repairs. */
  faceReferenceRepairs?: FaceReferenceRepair[];
  /**
   * Complete feature-warning provenance for this rebuild. Session-only and
   * stripped like the repairs. Older adapter results may omit it.
   */
  featureWarnings?: FeatureWarning[];
}

export interface ProjectDocument {
  editHistory?: DocumentHistory;
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
  /**
   * D01 drawing sheets (schema v30). Canonical user content: the sheets'
   * paper, scale and view placement, never projected lines. Absent means the
   * project has no drawings.
   */
  drawings?: DrawingSet;
  /**
   * U06 Objects folders (schema v34): how the bodies are organized in the
   * Objects browser. Never read by a rebuild. Absent means no folders.
   */
  objectFolders?: ObjectFolderSet;
  /**
   * I05 reference images (schema v32). Canonical user content: which picture
   * lies where, never its pixels. Absent means the project has none.
   */
  referenceImages?: ReferenceImageSet;
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
    /** Any other mesh interchange import: 3MF, OBJ, glTF binary, PLY. */
    | 'mesh-import'
    /**
     * The canonical triangles behind an `imported-mesh` feature's
     * `meshPayloadRef`; internal, not a file anyone downloads.
     */
    | 'mesh-payload'
    /**
     * I05: the PNG or JPEG behind a reference image's `source`; internal,
     * resolved by the viewport, not a file the File menu lists.
     */
    | 'reference-image'
    | 'step-export'
    | 'stl-export'
    | '3mf-export'
    | 'obj-export'
    | 'gltf-export'
    | 'ply-export'
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
  /**
   * How the account stores this project (ADR-024 Phase 4): 1 plaintext, 2
   * end-to-end encrypted (e2ee-v1). Absent means 1, which is what every
   * store wrote before formats existed. A browser opens only the formats in
   * {@link SUPPORTED_PROJECT_FORMATS} and asks for an update otherwise; a
   * format introduced after this build is listed too, as any number.
   */
  storageFormat?: number;
}

/** 1 = plaintext, 2 = end-to-end encrypted (e2ee-v1). */
export type ProjectStorageFormat = 1 | 2;
export const PROJECT_STORAGE_FORMAT_PLAINTEXT =
  1 satisfies ProjectStorageFormat;
export const PROJECT_STORAGE_FORMAT_E2EE_V1 = 2 satisfies ProjectStorageFormat;

/**
 * The project storage formats this build can open. Format 2 joins when the
 * browser can decrypt it (ADR-024 slice 4-5); until then a build refuses an
 * encrypted project instead of mistaking its ciphertext for a document.
 */
export const SUPPORTED_PROJECT_FORMATS: readonly ProjectStorageFormat[] = [
  PROJECT_STORAGE_FORMAT_PLAINTEXT
];

/** Whether this build opens a project stored in `format` (absent = 1). */
export function isSupportedProjectFormat(
  format: number | undefined,
  supported: readonly number[] = SUPPORTED_PROJECT_FORMATS
): boolean {
  return supported.includes(format ?? PROJECT_STORAGE_FORMAT_PLAINTEXT);
}

/** The Worker's refusal of a project stored in a format this build cannot open. */
export const PROJECT_FORMAT_UNSUPPORTED_CODE = 'PROJECT_FORMAT_UNSUPPORTED';
export const PROJECT_FORMAT_UNSUPPORTED_MESSAGE =
  'This project is end-to-end encrypted. Update OpenZCAD to open it.';
/** Invitations, share links and member rooms are refused on encrypted projects. */
export const ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE =
  'ENCRYPTED_PROJECT_SHARING_UNAVAILABLE';
/** An account that opted in to encryption may not store new plaintext projects. */
export const ENCRYPTED_PROJECTS_REQUIRED_CODE = 'ENCRYPTED_PROJECTS_REQUIRED';
/** The assistant is off on encrypted projects until per-project consent (D7). */
export const ENCRYPTED_PROJECT_ASSISTANT_UNAVAILABLE_CODE =
  'ENCRYPTED_PROJECT_ASSISTANT_UNAVAILABLE';

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

const COPY_SUFFIX_PATTERN = /\(copy(?: (\d+))?\)$/i;

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
  const trimmed = baseName.trim();
  const suffix = COPY_SUFFIX_PATTERN.exec(trimmed);
  const root =
    (suffix ? trimmed.slice(0, suffix.index).trimEnd() : trimmed) || 'Untitled';
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

/**
 * An embedded import payload the browser split out of a document it sends
 * (ADR-024 Phase 1): legacy `stepText`, or a mesh's `vertices`/`indices`.
 * The document carries the project-asset reference in its place, exactly as
 * the stored projection does, and the account stores these bytes under that
 * reference's content-addressed key after checking them against `checksumSha256`.
 */
export interface ProjectStorageAssetUpload {
  kind: 'step-source' | 'mesh-payload';
  /** SHA-256 of the payload before compression, lowercase hex. */
  checksumSha256: string;
  /** Payload bytes before compression. */
  logicalBytes: number;
  /** The gzip-compressed payload, base64-encoded. */
  storedBody: string;
}

/** Distinct split payloads one document write may carry. */
export const MAX_PROJECT_STORAGE_ASSET_UPLOADS = 1_000;

export interface CreateProjectRequest {
  name: string;
  units?: UnitSystem;
  /**
   * An existing device-local document to adopt. The server assigns its cloud
   * identity and remembers the account's original device ID for retry recovery.
   * The client moves its local records to the returned ID. Units are taken from
   * the document when present.
   */
  document?: ProjectDocument;
  /**
   * Client can transfer local records to the returned cloud identity. With 2
   * (ADR-024 Phase 1) the browser already re-homed `document`: it carries its
   * new `proj_<uuid>` id, the caller as owner, the request name and a closing
   * "Saved to account" checkpoint, and `localProjectId` is the device id the
   * account binds for retry recovery. Version 1 is kept for one release.
   */
  adoptionProtocolVersion?: 1 | 2;
  /** The device project id a version 2 adoption came from. */
  localProjectId?: string;
  /**
   * Archived import ids the device document held before the browser localized
   * them for its new home (version 2 only), so a discarded mesh upload still
   * refuses the adoption.
   */
  sourceArtifactIds?: string[];
  /**
   * A new project the browser built (ADR-024 Phase 1). The account stores it
   * under its own id after the checks an adoption gets; unlike `document`, it
   * keeps that id and records no device binding. Requests without it are the
   * pre-Phase 1 contract, kept for one release: the server builds the document.
   */
  initialDocument?: ProjectDocument;
  /**
   * With this, the document field is the browser's storage projection: its
   * embedded import payloads are split out into these uploads (ADR-024
   * Phase 1). Requests without it are the pre-Phase 1 contract, kept for one
   * release: the server splits the document itself.
   */
  storageAssets?: ProjectStorageAssetUpload[];
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
  /**
   * The copy the browser built with `duplicateProjectDocument` (ADR-024
   * Phase 1). The account keeps its `proj_<uuid>` id and stores it after the
   * checks a created or adopted project gets. Requests without it are the
   * pre-Phase 1 contract, kept for one release: the server builds the copy.
   */
  document?: ProjectDocument;
  /** `projectCopyDocumentDigest(document)`; required with `document`. */
  documentDigest?: string;
  /**
   * The source project's archived imports the copy references, which the
   * server copies byte for byte without reading either document.
   */
  importSources?: ImportSourceCopyRef[];
  /**
   * With this, the document field is the browser's storage projection: its
   * embedded import payloads are split out into these uploads (ADR-024
   * Phase 1). Requests without it are the pre-Phase 1 contract, kept for one
   * release: the server splits the document itself.
   */
  storageAssets?: ProjectStorageAssetUpload[];
}

/** One archived import source a browser-built copy needs under its own id. */
export interface ImportSourceCopyRef {
  /** The source project's archive of these bytes. */
  artifactId: string;
  kind: 'step-import' | 'mesh-payload';
  checksumSha256: string;
  logicalBytes: number;
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
  /**
   * The revision the browser appended to `document` for this save, with its
   * checkpoint (ADR-024 Phase 1). The server checks it and stores the document
   * as sent. Requests without it are the pre-Phase 1 contract, kept for one
   * release: the server mints the save point itself.
   */
  savedRevisionId?: RevisionId;
  /**
   * With this, the document field is the browser's storage projection: its
   * embedded import payloads are split out into these uploads (ADR-024
   * Phase 1). Requests without it are the pre-Phase 1 contract, kept for one
   * release: the server splits the document itself.
   */
  storageAssets?: ProjectStorageAssetUpload[];
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
  /**
   * With this, the document field is the browser's storage projection: its
   * embedded import payloads are split out into these uploads (ADR-024
   * Phase 1). Requests without it are the pre-Phase 1 contract, kept for one
   * release: the server splits the document itself.
   */
  storageAssets?: ProjectStorageAssetUpload[];
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

export type AccountTier = 'free' | 'premium';

export interface AccountEntitlements {
  tier: AccountTier;
  projectLimit: number;
  projectStorageLimitBytes: number;
  artifactLimitBytes: number;
  ai: {
    requestLimit: number;
    costLimitUnits: number;
    windowSeconds: number;
    concurrencyLimit: number;
  };
}

export interface AuthSession {
  /** Computed by the server; optional for older servers and local sessions. */
  entitlements?: AccountEntitlements;
  userId: UserId;
  displayName: string;
  email?: string;
  mode: 'development' | 'email-code';
}

// --- End-to-end encryption keys (ADR-024 Phase 3) -------------------------
// Every byte field is unpadded base64url. The Worker stores and relays these;
// the browser makes and verifies every one of them.

/** What a wrapped or sealed key is, as the Worker stores it. */
export type E2eeWrapPurpose =
  | 'account-key'
  | 'account-key-approval'
  | 'identity-key'
  | 'unlock-target-key'
  | 'encryption-key';

export interface E2eeWrapInput {
  purpose: E2eeWrapPurpose;
  /** Device id, unlock target id, or `current` for the encryption key. */
  targetId: string;
  wrapped: string;
}

export interface E2eeWrapRecord extends E2eeWrapInput {
  /** Device-list sequence the Worker stored it at. */
  keySequence: number;
}

export interface E2eeSignedStatementRecord {
  statement: string;
  signature: string;
}

export interface E2eeDeviceListEntryRecord {
  sequence: number;
  entry: string;
  signature: string;
}

export interface E2eeIdentityRecord {
  generation: number;
  identityKey: string;
  createdAt: string;
  /** Oldest first, starting at sequence 0. */
  entries: E2eeDeviceListEntryRecord[];
  transition: E2eeSignedStatementRecord | null;
  wraps: E2eeWrapRecord[];
  /** Display metadata only; live approval wraps determine read-only access. */
  approvedDevices?: E2eeApprovedDeviceRecord[];
}

export interface E2eeApprovedDeviceRecord {
  deviceId: string;
  label: string;
  approvedAt: string;
}

export interface E2eePreviousIdentityRecord {
  generation: number;
  identityKey: string;
  createdAt: string;
  /** The newest entry of that generation, for listing its devices. */
  head: E2eeDeviceListEntryRecord;
}

export interface E2eeConfigResponse {
  enabled: boolean;
  /**
   * Encrypted projects (E2EE_PROJECTS_ENABLED, ADR-024 Phase 4) are open to
   * this account and their storage is installed. Absent from older Workers.
   */
  projectsEnabled?: boolean;
}

/**
 * The account's "encrypt new projects" opt-in as the Worker stores it. The
 * browser trusts only `record` and `recordMac` (base64url canonical JSON
 * and its HMAC under the account key); the other fields are the Worker's
 * reading of the record, for its own refusals.
 */
export interface E2eeProjectPreferenceRecord {
  record: string;
  recordMac: string;
  encryptNewProjects: boolean;
  sequence: number;
  updatedAt: string;
}

export interface E2eeProjectPreferenceResponse {
  preference: E2eeProjectPreferenceRecord | null;
}

export interface E2eeSaveProjectPreferenceRequest {
  record: string;
  recordMac: string;
}

export interface E2eeAccountResponse {
  current: E2eeIdentityRecord | null;
  /** Up to three replaced identities, newest first. */
  previous: E2eePreviousIdentityRecord[];
}

export interface E2eeSetupRequest {
  identityKey: string;
  entry: string;
  signature: string;
  wraps: E2eeWrapInput[];
}

/**
 * A replaced account key wrapped under its successor (AES-KW purpose
 * `previous-account-key`). `generation` and `keySequence` name the replaced
 * key: its identity generation and the device-list sequence of the entry
 * that first committed to it.
 */
export interface E2eeAccountKeyHistoryInput {
  generation: number;
  keySequence: number;
  wrapped: string;
}

export interface E2eeAccountKeyHistoryRecord extends E2eeAccountKeyHistoryInput {
  createdAt: string;
}

export interface E2eeAccountKeyHistoryResponse {
  /** The caller's own history, oldest key first. */
  history: E2eeAccountKeyHistoryRecord[];
}

export interface E2eeAppendDeviceListRequest {
  generation: number;
  entry: string;
  signature: string;
  wraps: E2eeWrapInput[];
  /** Required exactly when the entry rotates the account key. */
  history?: E2eeAccountKeyHistoryInput;
}

export interface E2eeReplaceIdentityRequest extends E2eeSetupRequest {
  generation: number;
  transition: E2eeSignedStatementRecord;
  /** The replaced identity's current account key under the new one. */
  history: E2eeAccountKeyHistoryInput;
}

export type E2eeApprovalState =
  'requested' | 'responded' | 'revealed' | 'completed';

export interface E2eeCreateApprovalRequest {
  deviceId: string;
  label: string;
  signingKey: string;
  unlockKey: string;
  /** Present for the compare form; the scan form needs none. */
  commitment?: string;
}

export interface E2eeApprovalRecord {
  id: string;
  deviceId: string;
  label: string;
  signingKey: string;
  unlockKey: string;
  commitment: string | null;
  approverKey: string | null;
  approverNonce: string | null;
  deviceNonce: string | null;
  grant: E2eeSignedStatementRecord | null;
  state: E2eeApprovalState;
  createdAt: string;
  expiresAt: string;
}

export interface E2eeCompleteApprovalRequest {
  grant: E2eeSignedStatementRecord;
  /** The account key sealed to an approved but uncertified device. */
  sealedAccountKey?: string;
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
/**
 * Which sketch relations draw a glyph on their geometry: all of them, only
 * those that mention the selected entity, or none. Presentation only.
 */
export type SketchRelationGlyphVisibility = 'always' | 'selected' | 'hidden';
/** Relations drawn as glyphs; driving dimensions already have labels. */
export type SketchRelationGlyphKind = Exclude<
  SketchConstraintKind,
  'distance' | 'radius' | 'angle'
>;
/** Every glyph kind, in the order the per-kind filter lists them. */
export const SKETCH_RELATION_GLYPH_KINDS: readonly SketchRelationGlyphKind[] = [
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
  'coincident',
  'equal',
  'concentric',
  'symmetric',
  'point-on-object',
  'midpoint',
  'lock'
];

/**
 * A stored per-kind glyph filter, read leniently: unknown kinds (from a newer
 * client) and duplicates drop out, and the kinds come back in filter order.
 */
export function normalizeHiddenRelationGlyphs(
  value: unknown
): SketchRelationGlyphKind[] {
  if (!Array.isArray(value)) return [];
  return SKETCH_RELATION_GLYPH_KINDS.filter((kind) => value.includes(kind));
}
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
    /**
     * Vertical field of view of the perspective camera, in whole degrees.
     * Orthographic is its own projection and ignores it.
     */
    fieldOfView: number;
    /** How opaque faces stay in X-ray, as a whole percentage. */
    xrayOpacity: number;
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
    relationGlyphs: SketchRelationGlyphVisibility;
    /** Glyph kinds the per-kind filter hides; presentation only. */
    hiddenRelationGlyphs: SketchRelationGlyphKind[];
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
    /**
     * How a file that states no length unit (STL, OBJ, PLY, a DXF without
     * `$INSUNITS`) is read: ask at each import, the project's units, or one
     * fixed unit.
     */
    unitlessImportUnits: UnitlessImportUnits;
    /**
     * The length unit exports write where the format can carry one (STEP,
     * 3MF, DXF) or simply holds numbers (STL, OBJ, PLY). glTF is metres by
     * definition and SVG states its physical size, so neither follows it.
     */
    exportUnits: ExportUnits;
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
  /**
   * The user's shortcut remaps, by command id; a command without an entry
   * keeps its default. A preference, never project data: the same document
   * opens with whichever keys its reader chose.
   */
  keymap: {
    overrides: KeymapOverrides;
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
  sidebar: { min: 180, max: 720, default: 232 },
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

/**
 * The perspective field of view, in degrees. Narrow reads close to
 * orthographic; wide exaggerates depth, and past 90 the edges of the view
 * stretch more than they inform.
 */
export const VIEWPORT_FIELD_OF_VIEW_BOUNDS = {
  min: 15,
  max: 90,
  default: 45
} as const;

/**
 * Face opacity in X-ray, in percent. Below 10 the faces vanish and the view
 * is a wireframe; above 90 nothing behind them reads.
 */
export const XRAY_OPACITY_BOUNDS = {
  min: 10,
  max: 90,
  default: 35
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
    pointerNavigation: 'auto',
    fieldOfView: VIEWPORT_FIELD_OF_VIEW_BOUNDS.default,
    xrayOpacity: XRAY_OPACITY_BOUNDS.default
  },
  sketching: {
    gridVisible: true,
    snapEnabled: true,
    geometrySnapEnabled: true,
    inferenceEnabled: true,
    linearSnap: 1,
    angleSnap: 15,
    snapTolerancePx: 10,
    relationGlyphs: 'selected',
    hiddenRelationGlyphs: []
  },
  files: {
    cloudAutosave: true,
    cloudAutosaveDelaySeconds: CLOUD_AUTOSAVE_DELAY_BOUNDS.default,
    unitlessImportUnits: 'ask',
    // Millimetres, what every export wrote before the unit became a choice.
    exportUnits: 'mm'
  },
  collaboration: {
    enabled: true
  },
  assistant: {
    enabled: false,
    credentialSource: 'deployment',
    provider: 'openrouter',
    baseUrl: '',
    model: 'openai/gpt-6-luna',
    reasoningEffort: 'high',
    maxOutputTokens: 32_000,
    timeoutMs: 120_000,
    customInstructions: ''
  },
  experiments: {
    directManipulation: true
  },
  keymap: {
    overrides: {}
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

/** Fixed lifetime from createdAt (Unix seconds), including links minted before this policy. */
export const PROJECT_SHARE_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ProjectShareLinkSummary {
  shareLinkId: string;
  projectId: string;
  mode: ProjectShareLinkMode;
  /** Unix seconds; access expires at createdAt + PROJECT_SHARE_LINK_TTL_SECONDS. */
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

/** The save revision reason a "Keep this device's version" choice records. */
export const KEPT_LOCAL_VERSION_REASON = 'Kept this device’s version';

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
      /** Explicit user choice after preserving the other copy; fenced by baseVersion. */
      conflictResolution?: 'keep-local';
      /**
       * With `keep-local`: the save revision the browser appended to
       * `document` (ADR-024 Phase 1). Without it the room mints one, the
       * pre-Phase 1 contract kept for one release.
       */
      savedRevisionId?: string;
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
   * resolved document differs from what the sender submitted (canonical
   * source aliases or a room-minted kept version), because the resolved state
   * is broadcast to every *other* socket and would otherwise never reach the
   * sender.
   */
  | { type: 'ack'; version: number; document?: ProjectDocument }
  /**
   * Refuses a submission. `document` is the room's latest. `base` is present
   * when the submission descends from an older room version that the room
   * still holds: the sender merges base, latest and its own document in the
   * browser and resubmits against `document.version` (ADR-024 Phase 1).
   */
  | { type: 'conflict'; document: ProjectDocument; base?: ProjectDocument }
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

/**
 * Largest request body a cloud document write may send: the document ceiling
 * and 1 MiB of request envelope, plus room for a browser-split write
 * (ADR-024 Phase 1), whose payloads travel gzip-compressed and base64-encoded
 * — for bytes gzip cannot shrink, a third larger than inside the document,
 * plus gzip framing. The document ceiling still applies once it is hydrated.
 */
export const MAX_CLOUD_PROJECT_WRITE_BYTES =
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES +
  1024 * 1024 +
  Math.ceil((MAX_CLOUD_PROJECT_DOCUMENT_BYTES * 1.01) / 3);

/** Account limits include projects in the recycle bin until hard deletion. */
export const MAX_ACCOUNT_PROJECTS = 100;
/** Stored R2 project documents and externalized source assets per owner. */
export const MAX_ACCOUNT_PROJECT_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

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
  entitlements?: AccountEntitlements;
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
export const toSketchReferenceAnnotationId = (
  value: string
): SketchReferenceAnnotationId => value as SketchReferenceAnnotationId;
export const toShaprImportId = (value: string): ShaprImportId =>
  value as ShaprImportId;
export const toSketchCompositeId = (value: string): SketchCompositeId =>
  value as SketchCompositeId;

/**
 * The colour every solid is drawn in until someone chooses another (design
 * review G2, 11 Oct 2026). One neutral steel, so a part does not change
 * colour with each operation that rebuilds it, and the signal colours keep
 * their meanings: the accent for selection, {@link PREVIEW_BODY_COLOR} for
 * geometry not yet applied. It is a shade darker than the quiet-stage
 * design's neutral (#b0b6cb), which the key light washed out on top faces so
 * that a selected one barely lifted. The viewport stage is dark in both
 * themes, so one value serves both.
 */
export const DEFAULT_BODY_COLOR = '#99a0b2';

/**
 * What a live command preview draws its result body in: the hue of the web
 * chrome's `--color-preview` (#48cd8f), softened to the shaded mint of the
 * quiet-stage face-offset design so a whole body in it does not shout. No
 * body colour offered by default sits near it (`BODY_COLOR_PRESETS`), so
 * the hue alone says "not applied yet".
 */
export const PREVIEW_BODY_COLOR = '#79c7a9';

/**
 * Body colours the appearance picker offers: the neutral default, a darker
 * graphite and a spread of hues, none of them near
 * {@link PREVIEW_BODY_COLOR}. Each is darker than the selection tint, so a
 * picked face on any of them is drawn brighter, never duller.
 */
export const BODY_COLOR_PRESETS: readonly string[] = [
  DEFAULT_BODY_COLOR,
  '#6b7280',
  '#e1a948',
  '#fb923c',
  '#e5534b',
  '#f472b6',
  '#a78bfa',
  '#5f8fe8',
  '#5fb3e8'
];

/**
 * Set beside {@link BODY_COLOR_METADATA_KEY} when a person chose the colour.
 * Bodies are still stamped with their feature's colour when they are made
 * (documents written before G2 all carry one), so without this mark a chosen
 * colour that happens to equal that stamp could not be told from it.
 */
export const BODY_COLOR_CHOSEN_METADATA_KEY = 'colorChosen' as const;

/**
 * The colour a feature kind stamps on the body it makes, and the kind's
 * legend colour. Bodies are no longer DRAWN in it (`bodyDisplayColor`).
 * Changing a value here turns that kind's existing stamps into colours that
 * read as chosen, so a stamp must stay what it was when it was written.
 */
export const FEATURE_COLORS: Record<FeatureKind, string> = {
  primitive: '#e1a948',
  sketch: '#e1a948',
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
  'imported-mesh': '#7aa3ff',
  'datum-plane': '#9aa5b8',
  'datum-axis': '#9aa5b8'
};

export const featureColor = (kind: FeatureKind): string =>
  FEATURE_COLORS[kind] ?? FEATURE_COLORS.primitive;

/**
 * The colour a body's own metadata asks for, or null when it asks for none:
 * no colour stored, or only the stamp its feature wrote when it made the
 * body. A colour marked chosen ({@link BODY_COLOR_CHOSEN_METADATA_KEY}) is
 * always kept; an unmarked colour other than the stamp was chosen before the
 * mark existed (an older appearance pick, a demo finish) and is kept too.
 * With no feature kind to name the stamp, only a marked colour counts.
 *
 * Deliberately small: this runs in the exact-kernel chunk, which sits at its
 * bundle budget. A stamp is compared as written, since `featureColor` writes
 * every stamp as the same lower-case literal.
 */
export function chosenBodyColor(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  featureKind?: FeatureKind
): string | null {
  const stored = metadata?.[BODY_COLOR_METADATA_KEY];
  return typeof stored === 'string' &&
    stored &&
    (metadata[BODY_COLOR_CHOSEN_METADATA_KEY] === true ||
      (featureKind && stored !== featureColor(featureKind)))
    ? stored
    : null;
}

/** The colour a body is drawn in: its chosen colour, or the neutral default. */
export function bodyDisplayColor(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
  featureKind?: FeatureKind
): string {
  return chosenBodyColor(metadata, featureKind) ?? DEFAULT_BODY_COLOR;
}

/** Reading a unitless import: ask, the project's units, or a fixed unit. */
export type UnitlessImportUnits = 'ask' | 'document' | UnitSystem;

export const UNITLESS_IMPORT_UNITS: readonly UnitlessImportUnits[] = [
  'ask',
  'document',
  'mm',
  'cm',
  'm',
  'inch'
];

/** The unit an export writes: the project's own, or a fixed one. */
export type ExportUnits = 'document' | UnitSystem;

export const EXPORT_UNITS: readonly ExportUnits[] = [
  'document',
  'mm',
  'cm',
  'm',
  'inch'
];

/** The concrete unit an export preference names for one document. */
export function resolveExportUnits(
  preference: ExportUnits,
  documentUnits: UnitSystem
): UnitSystem {
  return preference === 'document' ? documentUnits : preference;
}

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
