/**
 * Measure real Remus import.step documents and imported-body edits against
 * recorded baselines: full warnings, body and topology counts, physical volume,
 * surface types, witness/lineage digests, import validation and STEP roundtrips.
 * Re-export and reimport also expose writer defects such as lost cavities.
 */

import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyRepresentation,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';

/** Minimal adapter surface needed by the geometry measurements. */
export interface MeasurableAdapter {
  readonly kind: string;
  syncDocument(document: ProjectDocument): Promise<DerivedState>;
  exportStep(document: ProjectDocument, bodyIds: string[]): Promise<string>;
  inspectStep(
    data: string | ArrayBuffer
  ): Promise<{ solid: boolean; valid: boolean; volume: number }>;
}

const CORPUS_USER = toUserId('user_parity_corpus');

export interface RoundTripReport {
  status:
    | 'ok'
    | 'skipped-no-body'
    | 'export-threw'
    | 'reimport-threw'
    | 'reimport-refused';
  error?: string;
  warnings?: string[];
  /** |v2 - v1| / max(|v1|, 1e-12). Zero for an exact writer/reader pair. */
  volumeRelativeDelta?: number;
  faceCountDelta?: number;
  edgeCountDelta?: number;
  /**
   * Top-level solids the re-exported file declares. The K0.2 metric: a
   * multi-solid import that re-exports as one solid has lost bodies.
   */
  exportedSolidCount?: number;
  /** True when the re-export still carries a `BREP_WITH_VOIDS`. */
  exportedVoids?: boolean;
}

export interface CorpusMeasurement {
  /** `imported` = at least one exportable body; `refused` = warnings, no body. */
  status: 'imported' | 'refused' | 'threw';
  /** Every warning the sync produced, verbatim and in order. */
  warnings: string[];
  /** Present only when `syncDocument` threw outright. */
  error?: string;
  bodyCount: number;
  volume: number;
  faceCount: number;
  edgeCount: number;
  /** Edges the kernel marks as parameterization seams rather than features. */
  seamEdgeCount: number;
  /** Histogram of `FaceGeometry.surfaceType`; `unknown` when unpopulated. */
  surfaceTypes: Record<string, number>;
  /** Faces/edges publishing a schema-v5 persistent reference (K0.6). */
  witnessedFaces: number;
  witnessedEdges: number;
  /** Sorted unique `reference.lineageName` values across faces and edges. */
  lineageNames: string[];
  /** FNV-1a over the sorted face/edge hash sets — the topology witness fold. */
  faceHashDigest: string;
  edgeHashDigest: string;
  bbox: number[] | null;
  /** `inspectStep`, the pre-import validity probe the app shows users. */
  inspect:
    { solid: boolean; valid: boolean; volume: number } | { error: string };
  roundTrip: RoundTripReport;
}

/** Build the one-feature `import.step` document the app would build. */
export function importDocument(
  stepText: string,
  sourceName: string
): { document: ProjectDocument; bodyId: string } {
  const manager = new CommandManager(
    createProjectDocument(`Corpus · ${sourceName}`, CORPUS_USER, 'mm')
  );
  const ids = createBodyFeatureIds();
  manager.execute(
    commandFactories.importStep({
      name: 'Imported',
      artifactId: `artifact_corpus_${sourceName}`,
      sourceName,
      stepText,
      ids
    })
  );
  return { document: manager.document, bodyId: ids.bodyId };
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function digestOf(values: number[]): string {
  return values.length === 0
    ? 'empty'
    : fnv1a([...values].sort((a, b) => a - b).join(','));
}

function exportableBodies(derived: DerivedState): BodyRepresentation[] {
  return derived.exportableBodyIds
    .map((bodyId) => derived.bodyRepresentations[bodyId])
    .filter((body): body is BodyRepresentation => body !== undefined);
}

/** Top-level solids a STEP text declares. */
export function declaredSolidCount(step: string): number {
  return (step.match(/\b(?:MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS)\s*\(/g) ?? [])
    .length;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Aggregate {
  volume: number;
  faceCount: number;
  edgeCount: number;
  seamEdgeCount: number;
  surfaceTypes: Record<string, number>;
  witnessedFaces: number;
  witnessedEdges: number;
  lineageNames: string[];
  faceHashes: number[];
  edgeHashes: number[];
  bbox: number[] | null;
}

function aggregate(bodies: BodyRepresentation[]): Aggregate {
  const surfaceTypes: Record<string, number> = {};
  const lineageNames = new Set<string>();
  const faceHashes: number[] = [];
  const edgeHashes: number[] = [];
  let volume = 0;
  let faceCount = 0;
  let edgeCount = 0;
  let seamEdgeCount = 0;
  let witnessedFaces = 0;
  let witnessedEdges = 0;
  let bbox: number[] | null = null;

  for (const body of bodies) {
    volume += body.volume;
    faceCount += body.faceCount;
    const min = body.bbox.min;
    const max = body.bbox.max;
    const extent = [min.x, min.y, min.z, max.x, max.y, max.z];
    bbox = bbox
      ? [
          Math.min(bbox[0]!, extent[0]!),
          Math.min(bbox[1]!, extent[1]!),
          Math.min(bbox[2]!, extent[2]!),
          Math.max(bbox[3]!, extent[3]!),
          Math.max(bbox[4]!, extent[4]!),
          Math.max(bbox[5]!, extent[5]!)
        ]
      : extent;

    for (const face of body.topology?.faces ?? []) {
      faceHashes.push(face.hash);
      const type = face.geometry?.surfaceType ?? 'unknown';
      surfaceTypes[type] = (surfaceTypes[type] ?? 0) + 1;
      if (face.reference) {
        witnessedFaces += 1;
        lineageNames.add(face.reference.lineageName);
      }
    }
    for (const edge of body.topology?.edges ?? []) {
      edgeCount += 1;
      edgeHashes.push(edge.hash);
      if (edge.displayRole === 'seam') {
        seamEdgeCount += 1;
      }
      if (edge.reference) {
        witnessedEdges += 1;
        lineageNames.add(edge.reference.lineageName);
      }
    }
  }

  return {
    volume,
    faceCount,
    edgeCount,
    seamEdgeCount,
    surfaceTypes,
    witnessedFaces,
    witnessedEdges,
    lineageNames: [...lineageNames].sort(),
    faceHashes,
    edgeHashes,
    bbox
  };
}

const REFUSED: Omit<
  CorpusMeasurement,
  'status' | 'warnings' | 'inspect' | 'roundTrip'
> = {
  bodyCount: 0,
  volume: 0,
  faceCount: 0,
  edgeCount: 0,
  seamEdgeCount: 0,
  surfaceTypes: {},
  witnessedFaces: 0,
  witnessedEdges: 0,
  lineageNames: [],
  faceHashDigest: 'empty',
  edgeHashDigest: 'empty',
  bbox: null
};

/**
 * Measure one derived state, then round-trip the same document through the
 * same adapter.
 */
async function measureDerived(
  adapter: MeasurableAdapter,
  document: ProjectDocument,
  derived: DerivedState,
  sourceName: string
): Promise<Omit<CorpusMeasurement, 'inspect'>> {
  const bodies = exportableBodies(derived);
  if (bodies.length === 0) {
    return {
      ...REFUSED,
      status: 'refused',
      warnings: [...derived.warnings],
      roundTrip: { status: 'skipped-no-body' }
    };
  }

  const stats = aggregate(bodies);
  const measurement: Omit<CorpusMeasurement, 'inspect'> = {
    status: 'imported',
    warnings: [...derived.warnings],
    bodyCount: bodies.length,
    volume: stats.volume,
    faceCount: stats.faceCount,
    edgeCount: stats.edgeCount,
    seamEdgeCount: stats.seamEdgeCount,
    surfaceTypes: stats.surfaceTypes,
    witnessedFaces: stats.witnessedFaces,
    witnessedEdges: stats.witnessedEdges,
    lineageNames: stats.lineageNames,
    faceHashDigest: digestOf(stats.faceHashes),
    edgeHashDigest: digestOf(stats.edgeHashes),
    bbox: stats.bbox,
    roundTrip: { status: 'skipped-no-body' }
  };

  let exported: string;
  try {
    exported = await adapter.exportStep(document, derived.exportableBodyIds);
  } catch (error) {
    measurement.roundTrip = {
      status: 'export-threw',
      error: errorText(error)
    };
    return measurement;
  }

  const reexport = {
    exportedSolidCount: declaredSolidCount(exported),
    exportedVoids: /BREP_WITH_VOIDS/.test(exported)
  };

  let reimported: DerivedState;
  try {
    const roundTripDocument = importDocument(
      exported,
      `${sourceName}.roundtrip`
    ).document;
    reimported = await adapter.syncDocument(roundTripDocument);
  } catch (error) {
    measurement.roundTrip = {
      status: 'reimport-threw',
      error: errorText(error),
      ...reexport
    };
    return measurement;
  }

  const roundTripBodies = exportableBodies(reimported);
  if (roundTripBodies.length === 0) {
    measurement.roundTrip = {
      status: 'reimport-refused',
      warnings: [...reimported.warnings],
      ...reexport
    };
    return measurement;
  }

  const after = aggregate(roundTripBodies);
  measurement.roundTrip = {
    status: 'ok',
    warnings: [...reimported.warnings],
    volumeRelativeDelta:
      Math.abs(after.volume - stats.volume) /
      Math.max(Math.abs(stats.volume), 1e-12),
    faceCountDelta: after.faceCount - stats.faceCount,
    edgeCountDelta: after.edgeCount - stats.edgeCount,
    ...reexport
  };
  return measurement;
}

/** Import one STEP text through one adapter and reduce it to a record. */
export async function measureStepFile(
  adapter: MeasurableAdapter,
  stepText: string,
  sourceName: string
): Promise<CorpusMeasurement> {
  let inspect: CorpusMeasurement['inspect'];
  try {
    inspect = await adapter.inspectStep(stepText);
  } catch (error) {
    inspect = { error: errorText(error) };
  }

  const { document } = importDocument(stepText, sourceName);
  let derived: DerivedState;
  try {
    derived = await adapter.syncDocument(document);
  } catch (error) {
    return {
      ...REFUSED,
      status: 'threw',
      warnings: [],
      error: errorText(error),
      inspect,
      roundTrip: { status: 'skipped-no-body' }
    };
  }
  return {
    ...(await measureDerived(adapter, document, derived, sourceName)),
    inspect
  };
}

/** Measure an already-built document (the import-modeling scenarios). */
export async function measureDocument(
  adapter: MeasurableAdapter,
  document: ProjectDocument,
  sourceName: string
): Promise<Omit<CorpusMeasurement, 'inspect'>> {
  let derived: DerivedState;
  try {
    derived = await adapter.syncDocument(document);
  } catch (error) {
    return {
      ...REFUSED,
      status: 'threw',
      warnings: [],
      error: errorText(error),
      roundTrip: { status: 'skipped-no-body' }
    };
  }
  return measureDerived(adapter, document, derived, sourceName);
}
