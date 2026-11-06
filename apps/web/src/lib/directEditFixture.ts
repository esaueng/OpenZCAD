import type {
  FeatureWarning,
  ProjectDocument,
  Vector3
} from '@openzcad/shared';

/**
 * One direct-edit attempt, in the form the refusal corpus replays.
 *
 * Captured by the interaction diagnostics log when a handle drag or exact
 * entry is refused (or, for comparison, lands), and authored by hand in
 * `test/direct-edit-corpus/` for the failure classes already known. Both
 * paths produce the same shape so a capture exported from the app can be
 * dropped into the corpus unchanged.
 */
export const DIRECT_EDIT_FIXTURE_FORMAT =
  'openzcad-direct-edit-fixture' as const;
/**
 * Version 2 adds the `feature-build` op. A version 1 file is still read:
 * every field it carries kept its meaning.
 */
export const DIRECT_EDIT_FIXTURE_FORMAT_VERSION = 2 as const;
export const DIRECT_EDIT_FIXTURE_READABLE_VERSIONS = [1, 2] as const;

/**
 * Interaction operations the corpus knows how to replay.
 *
 * `feature-build` is different in kind from the six gestures: its `document`
 * already CONTAINS the refused feature (as the last feature in history, with
 * everything after it trimmed), so replay is one rebuild judged by the shipped
 * feature gate. It is what a "Save reproduction" from a refusal writes, and it
 * covers every feature kind — booleans, modifiers, direct edits — alike.
 */
export type DirectEditFixtureOp =
  | 'offset-face'
  | 'resize-cylinder-radius'
  | 'edit-fillet'
  | 'remove-face-feature'
  | 'fillet'
  | 'chamfer'
  | 'feature-build';

export type DirectEditFixtureOutcome =
  'committed' | 'refused' | 'preview-failed' | 'preview-degraded';

/**
 * How the corpus finds the face again on a fresh rebuild. Hashes are recorded
 * for the record but never used to resolve: a captured hash is exactly the
 * thing that may have stopped resolving. Surface type, normal alignment, and
 * nearest vertex-mean `center` are what identify the face.
 */
export interface DirectEditFixtureFace {
  surfaceType: string;
  center: Vector3;
  normal?: Vector3;
  area?: number;
  hash?: number;
  /** Whether the pick carried a schema-v5 lineage reference. */
  hasReference: boolean;
}

export interface DirectEditFixtureEdge {
  /** Mean of the edge's sampled display points. */
  center: Vector3;
  length?: number;
  hash?: number;
  hasReference: boolean;
}

export interface DirectEditFixtureEdit {
  op: DirectEditFixtureOp;
  targetBodyId: string;
  face?: DirectEditFixtureFace;
  edges?: DirectEditFixtureEdge[];
  /** Offset distance, radius, or modifier size — whatever the op takes. */
  value: number;
  /** `feature-build` only: the refused feature, present in `document`. */
  featureId?: string;
  /** `feature-build` only: that feature's kind. */
  featureKind?: string;
  /** `feature-build` of a direct edit only: its operation kind. */
  operationKind?: string;
}

export interface DirectEditFixtureObservation {
  outcome: DirectEditFixtureOutcome;
  /** The sentence the user saw. */
  message?: string;
  /** Kernel text behind the disclosure, when there was any. */
  detail?: string;
  lineage: 'semantic' | 'hash-only';
  /** Feature kind that produced the target body, when the rebuild says. */
  producingFeatureKind?: string;
  /** Feature kinds in history order, before the edit. */
  upstreamFeatureKinds: string[];
  documentVersion: number;
  /** `FeatureWarning.kind` of the refusal, when the rebuild attributed it. */
  warningKind?: FeatureWarning['kind'];
  /** The kernel's own classification of the refusal, when it gave one. */
  kernelRefusal?: FeatureWarning['kernelRefusal'];
  timings?: {
    /** Exact preview rebuild durations during the gesture, in ms. */
    previewMs?: number[];
    /** Commit-time validation rebuild, in ms. */
    validateMs?: number;
    degraded?: boolean;
  };
}

export interface DirectEditFixture {
  format: typeof DIRECT_EDIT_FIXTURE_FORMAT;
  formatVersion: (typeof DIRECT_EDIT_FIXTURE_READABLE_VERSIONS)[number];
  /** Kebab-case, unique; the corpus uses it as the file stem. */
  name: string;
  capturedAt: string;
  origin: 'captured' | 'authored';
  kernel: {
    adapter: 'remus';
    packageVersion: string;
    sourceCommit: string;
  };
  /**
   * The document BEFORE the edit, sanitized like a project diagnostic bundle:
   * no account or cloud identity, no revisions, checkpoints, assets, or
   * derived meshes. Null when the document carries imported geometry, whose
   * source metadata is not sanitized here.
   */
  document: ProjectDocument | null;
  documentOmitted?: 'imported-source';
  edit: DirectEditFixtureEdit;
  observed: DirectEditFixtureObservation;
}
