/**
 * Shared shapes passed between the exact adapter's modules: the per-body
 * kernel handle bundle, the whole-document build result, and import
 * diagnostics. Types only — no runtime code — so any module may import them
 * without creating a cycle.
 */
import type { PlaneBasis, Vec3 } from '@openzcad/geometry';
import type {
  BodyId,
  BodyMassProperties,
  BodyTopology,
  EdgeReferenceRepair,
  SketchId
} from '@openzcad/shared';
import type { TriangleMeshClosure } from './boolean-result-validation';
import type { RemusLineageState } from './remus-lineage';

export interface ExactShape {
  /** A body can contain several independent solids, as with a pattern. */
  solids: number[];
  /** Exact, handle-bound schema-v5 references plus fail-closed diagnostics. */
  lineage?: RemusLineageState;
}

/** What the K0.6 import validator found on one `imported-step` feature. */
export interface ImportedStepDiagnostics {
  /** Solids the file declared, before any were rejected. */
  declaredSolidCount: number;
  /** Reasons for each solid dropped as not being a closed manifold shell. */
  rejections: string[];
  /** Reasons for each solid kept but failing strict validation. */
  flagged: string[];
}

export interface ExactBuildResult {
  shapes: Map<BodyId, ExactShape>;
  sketchBases: Map<SketchId, PlaneBasis>;
  consumed: Set<BodyId>;
  /**
   * Per-body import validation, recorded where the import happens rather than
   * re-derived later: it describes the file the user opened, not whatever the
   * body became after the features layered on top of it.
   */
  importedStepDiagnostics: Map<BodyId, ImportedStepDiagnostics>;
  /**
   * Bodies whose geometry originates in an imported mesh, directly or through
   * a derived feature. Their shells are source-file facets rather than
   * analytic surfaces, which is what makes booleans against them a typed
   * refusal instead of a silently poor result.
   */
  meshBodies: Set<BodyId>;
  /**
   * Bodies swept by a revolve below a full turn, directly or through a
   * derived feature. Recorded at the sweep rather than re-derived later
   * because it is what makes an edge-modifier refusal on a wedge explainable
   * instead of a bare "try a smaller radius" that is false at every radius.
   */
  partialRevolveBodies: Set<BodyId>;
  warnings: string[];
  /**
   * Legacy hash-only edge modifiers whose rebuild proved a v5 reference for
   * every selected edge. Surfaced through DerivedState so the app can persist
   * the upgrade while the stored hashes still resolve.
   */
  referenceRepairs: EdgeReferenceRepair[];
}

export interface MeasuredShape {
  vertices: number[];
  indices: number[];
  topology: BodyTopology;
  faceCount: number;
  volume: number;
  massProperties?: BodyMassProperties;
  valid: boolean;
  strictValid: boolean;
  meshClosure: TriangleMeshClosure | null;
  bbox: {
    min: Vec3;
    max: Vec3;
  };
}
