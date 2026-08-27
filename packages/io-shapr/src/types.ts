export type ShaprEvidence = 'observed' | 'inferred' | 'proven';
export type ShaprMigrationStatus =
  'proven' | 'candidate' | 'unsupported' | 'ambiguous';

export interface ShaprSchemaTuple {
  workspaceSchemaVersion: number;
  schemaVersion: number;
  historyVersion: number;
  projectVersion: number;
}

export interface ShaprVector2 {
  x: number;
  y: number;
}

export interface ShaprVector3 {
  x: number;
  y: number;
  z: number;
}

export interface ShaprSketchFrame {
  origin: ShaprVector3;
  normal: ShaprVector3;
  uDirection: ShaprVector3;
}

interface ShaprSketchCurveBase {
  sourceCurveId: number;
  evidence: ShaprEvidence;
}

export type ShaprSketchCurve =
  | (ShaprSketchCurveBase & {
      kind: 'line';
      start: ShaprVector2;
      end: ShaprVector2;
    })
  | (ShaprSketchCurveBase & {
      kind: 'circle';
      center: ShaprVector2;
      radius: number;
    })
  | (ShaprSketchCurveBase & {
      kind: 'bspline';
      controlPoints: ShaprVector2[];
      knots: number[];
      multiplicities: number[];
      weights: number[];
      degree: number;
      periodic: boolean;
    })
  | (ShaprSketchCurveBase & {
      kind: 'unknown';
      sourceType: number | null;
      reason: string;
    });

export interface ShaprSketchConstraintCandidate {
  sourceConstraintId: string;
  sourceType: number | null;
  status: ShaprMigrationStatus;
  numericCandidates: number[];
  referencedCurveIds: number[];
  diagnostic: string;
}

export interface ShaprSketchIR {
  sourceSketchId: number;
  name: string;
  hidden: boolean;
  frame: ShaprSketchFrame;
  curves: ShaprSketchCurve[];
  constraints: ShaprSketchConstraintCandidate[];
}

export type ShaprOperationKind =
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

export interface ShaprOperationIR {
  sourceNodeId: number;
  sourceType: number;
  name: string;
  token: string;
  kind: ShaprOperationKind;
  status: ShaprMigrationStatus;
  propertyNodeIds: number[];
  numericCandidates: number[];
  diagnostic: string;
}

export interface ShaprOpaqueGeometrySummary {
  importedBodyCount: number;
  importedPrototypeCount: number;
  revisionBlockCount: number;
  revisionDeltaCount: number;
  importedPrototypeBytes: number;
  revisionBlockBytes: number;
  revisionDeltaBytes: number;
  parasolidVersions: string[];
}

export interface ShaprImportDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface ShaprImportIR {
  format: 'openzcad-shapr-ir';
  version: 1;
  schema: ShaprSchemaTuple;
  schemaAdapter: 'workspace-269';
  units: {
    source: 'metre-candidate';
    evidence: 'inferred';
    documentScaleCandidate: 1000;
  };
  archive: {
    bytes: number;
    entries: number;
    workspaceBytes: number;
    checksumSha256: string;
  };
  historyNodeCount: number;
  sketches: ShaprSketchIR[];
  operations: ShaprOperationIR[];
  opaqueGeometry: ShaprOpaqueGeometrySummary;
  diagnostics: ShaprImportDiagnostic[];
  omittedPrivateData: string[];
}

export interface ShaprDatabaseRow {
  [column: string]: unknown;
}

export interface ShaprDatabase {
  all(sql: string): ShaprDatabaseRow[];
  close(): void;
}
