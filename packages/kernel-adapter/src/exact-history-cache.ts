/**
 * Incremental prefix rebuild cache: digests, snapshots, and the checkpoint
 * table types behind `syncDocument`'s restore-and-replay path.
 *
 * `syncDocument` used to rebuild the whole history in a throwaway kernel on
 * every call. The adapter now keeps ONE long-lived history kernel and takes a
 * kernel checkpoint plus a JS-state snapshot after every feature. The next
 * sync digests the incoming feature list, restores the longest prefix whose
 * digests still match, and replays only the edited suffix. The kernel
 * guarantees this is sound: handles allocated before a checkpoint stay valid
 * after `restore`, and handles allocated after it are permanently retired,
 * never reused for a different entity.
 *
 * Export, mesh-quality, and sketch-solve methods keep their own throwaway
 * kernels: they are rare, and sharing the history kernel with them would put
 * its checkpoints one bug away from corruption.
 */
import {
  expressionIdentifiers,
  findSketch,
  getParameterScope,
  keyableImportedNodeData
} from '@openzcad/document-core';
import type { FeatureNode, ProjectDocument, SketchId } from '@openzcad/shared';
import type { BodyId } from '@openzcad/shared';
import type {
  ExactBuildResult,
  ExactShape,
  MeasuredShape
} from './exact-types';
import { bezierProfileEdgesEnabled } from './profile-bezier-edges';

/**
 * Retained checkpoints are full `Topology` arena clones (the kernel
 * copy-on-writes the arena at the first mutation after each checkpoint), so
 * the cap bounds wasm-heap retention. A document with more features than
 * this rebuilds from scratch every sync, exactly as before the cache.
 */
export const MAX_HISTORY_CHECKPOINTS = 32;

/**
 * Deterministic serializer for history-cache digests: keys sorted,
 * `undefined`-valued properties dropped. The same canonical form the
 * worker's whole-document rebuild cache uses, with the same accepted
 * non-injectivity: `{a: undefined}` and `{}` digest identically, which
 * matches how optional feature fields are read.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        if (record[key] !== undefined) {
          sorted[key] = record[key];
        }
      }
      return sorted;
    }
    return entry;
  });
}

/**
 * Every SketchId mentioned anywhere in a feature's data, at any depth. Sweep
 * paths, loft sections, and region profiles all carry `sketchId` keys, so a
 * structural walk stays correct when a new feature kind adds one.
 */
function collectSketchIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSketchIds(entry, into);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'sketchId' && typeof entry === 'string') {
        into.add(entry);
      } else {
        collectSketchIds(entry, into);
      }
    }
  }
}

/**
 * Everything outside a feature's own node that `build` reads for it and that
 * is not already part of the scope digest: the parameter values and referenced sketch nodes
 * (objects, constraints, and the plane ref that may attach to an upstream
 * face). Upstream body state needs no digesting — it is determined by the
 * earlier features, whose own digests guard it.
 */
export function historyFeatureDigest(
  document: ProjectDocument,
  feature: FeatureNode,
  index: number,
  scope: Record<string, number> = getParameterScope(document).scope
): string {
  const sketchIds = new Set<string>();
  collectSketchIds(feature.data, sketchIds);
  const sketches = [...sketchIds].sort().map((sketchId) => {
    const sketch = findSketch(document, sketchId as SketchId);
    if (!sketch) {
      return null;
    }
    // The objects live in their own nodes: `objectIds` alone would keep a
    // radius edit invisible to the digest and serve stale geometry.
    return {
      sketch,
      objects: sketch.objectIds.map(
        (objectId) => document.nodes[objectId] ?? null
      )
    };
  });
  // The feature node of an imported mesh or STEP carries its whole payload
  // inline, so this used to serialise it in full on every cache miss —
  // measured at 100,000 triangles, 111 ms for a 7.5-million-character digest,
  // and 243 ms at the 200,000 import cap. The same reduction the rebuild
  // cache's key uses keeps the digest exactly as content-sensitive at
  // constant size, and sharing it is what keeps the two from drifting apart.
  return stableJson({
    index,
    feature: {
      ...feature,
      data: keyableImportedNodeData(feature.data)
    },
    sketches,
    // STEP imports read their payload, selection and document units, but
    // never the parameter scope, and a split whose plane is all literals reads
    // nothing from it either. Preserve those expensive checkpoints when a
    // downstream dimension changes. A direct edit reads exactly the resolved
    // values its own expressions name. All other builders conservatively
    // depend on the entire resolved scope, including transitive parameters.
    scope: digestScope(feature, scope)
  });
}

/**
 * The part of the resolved scope a feature's build can read: nothing for a
 * literal-only feature, the named values for one whose expressions are all
 * visible right here, and the whole scope otherwise. Resolved values already
 * carry their transitive dependencies, so naming just the referenced
 * parameters keeps the digest exactly as change-sensitive as the build.
 */
function digestScope(
  feature: FeatureNode,
  scope: Record<string, number>
): Record<string, number | null> | undefined {
  const expressions = directEditExpressions(feature);
  if (expressions) {
    const names = [
      ...new Set(
        expressions.flatMap((expression) => expressionIdentifiers(expression))
      )
    ].sort();
    if (!names.length) return undefined;
    return Object.fromEntries(names.map((name) => [name, scope[name] ?? null]));
  }
  return readsParameterScope(feature) ? scope : undefined;
}

/**
 * Every string a direct edit stores, wherever it sits in the operation. Null
 * for any other feature kind. Enumerating the parametric fields by name was
 * tried first and missed one (`newRadius`), which silently served a stale
 * blend after its parameter moved; reading every string instead can only
 * over-include (a surface class such as "torus" digests as a parameter that
 * does not exist), never miss an expression.
 */
function directEditExpressions(feature: FeatureNode): string[] | null {
  const { data } = feature;
  if (data.featureKind !== 'direct-edit') return null;
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object')
      Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(data.operation);
  return strings;
}

/**
 * Whether building this feature can read a parameter value. Only the kinds
 * whose every parametric field is visible right here are exempted when those
 * fields are all literals; anything touching a sketch, a face reference or a
 * derived profile stays conservative.
 */
function readsParameterScope(feature: FeatureNode): boolean {
  const { data } = feature;
  const literal = (value: unknown) => typeof value === 'number';
  const literalVector = (value: { x: unknown; y: unknown; z: unknown }) =>
    literal(value.x) && literal(value.y) && literal(value.z);
  switch (data.featureKind) {
    case 'imported-step':
      return false;
    case 'split':
      return (
        !literalVector(data.plane.origin) || !literalVector(data.plane.normal)
      );
    case 'primitive':
      return !Object.values(data.dimensions).every(literal);
    case 'transform':
      return (
        !literalVector(data.transform.translation) ||
        !literalVector(data.transform.rotationDeg) ||
        !(data.transform.scale === undefined || literal(data.transform.scale))
      );
    case 'boolean':
      return !(data.activeWhen === undefined || literal(data.activeWhen));
    default:
      return true;
  }
}

/**
 * Anything that feeds every feature equally: the scope errors
 * (seeded into warnings before the first feature), the unit system, and the
 * one module-level build mode (`setBezierProfileEdges` flips how text
 * profiles convert without touching the document). Parameter values belong
 * in feature digests so parameter-independent imports can survive an edit.
 */
export function historyScopeDigest(document: ProjectDocument): string {
  const { errors } = getParameterScope(document);
  return stableJson({
    units: document.units,
    errors,
    bezierProfileEdges: bezierProfileEdgesEnabled()
  });
}

/**
 * Structural copy of the JS half of a build. Container objects are copied;
 * leaf values (v5 references, witnesses, diagnostics, plane bases, import
 * diagnostics) are shared — every producer treats them as immutable, and the
 * lineage maps' number keys are kernel handles that the checkpoint contract
 * keeps valid for the prefix that produced them.
 */
export function cloneBuildState(result: ExactBuildResult): ExactBuildResult {
  const shapes = new Map<BodyId, ExactShape>();
  for (const [bodyId, shape] of result.shapes) {
    shapes.set(bodyId, {
      solids: [...shape.solids],
      ...(shape.lineage
        ? {
            lineage: {
              faceReferences: new Map(shape.lineage.faceReferences),
              edgeReferences: new Map(shape.lineage.edgeReferences),
              diagnostics: [...shape.lineage.diagnostics]
            }
          }
        : {})
    });
  }
  return {
    shapes,
    sketchBases: new Map(result.sketchBases),
    consumed: new Set(result.consumed),
    importedStepDiagnostics: new Map(result.importedStepDiagnostics),
    meshBodies: new Set(result.meshBodies),
    partialRevolveBodies: new Set(result.partialRevolveBodies),
    warnings: [...result.warnings],
    // Copied with the warnings they attribute. A snapshot that carried the
    // strings without their attribution would leave every cached rebuild —
    // which is the common case — falling back to matching feature names, and
    // the gate would go on mistaking a suppression for a failure exactly
    // where it does most of its work.
    featureWarnings: result.featureWarnings.map((entry) => ({ ...entry })),
    referenceRepairs: [...result.referenceRepairs]
  };
}

export interface HistoryCheckpointEntry {
  digest: string;
  /** Kernel checkpoint index; equals this entry's position in the table. */
  checkpointId: number;
  /** Post-feature JS state, isolated from later in-place mutation. */
  snapshot: ExactBuildResult;
}

/**
 * One body's cached measure-pass output, keyed by the solid handles that
 * produced it. Handle identity is a proof of unchanged geometry: the kernel
 * never reuses a retired handle for a different entity, and every adapter
 * path that changes a body's geometry allocates new solids (the single
 * `transformSolid` in-place mutation runs on a diagnostic-probe copy that
 * never reaches `result.shapes`). Same handles across syncs ⟹ same solids
 * ⟹ same measurement.
 *
 * The `MeasuredShape` alone is cached — never the warnings or the
 * `BodyRepresentation` wrapper. Names, colors, and diagnostics can change
 * without the geometry changing, so everything derived from them is
 * recomputed each sync from the cached measurement, which is the expensive
 * part.
 */
export interface MeasuredBodyCacheEntry {
  /** `shape.solids.join(',')` — the handle-identity key. */
  solidKey: string;
  /** Whether the cached measure ran with strict union validation. */
  strict: boolean;
  /** Whether exact imported-feature proofs were collected with the topology. */
  recognizedImportedFeatures: boolean;
  /**
   * Total face-handle count across the body's solids at cache time. A cheap
   * paranoia probe re-checks it before serving a hit, so an in-place kernel
   * mutation (which the invariant above forbids) fails loudly as a miss
   * instead of silently serving a stale mesh.
   */
  faceHandleCount: number;
  /** Approximate retained bytes (mesh buffers), for the byte budget. */
  bytes: number;
  measured: MeasuredShape;
}

/** Approximate retained bytes of one measurement's dominant buffers. */
export function measuredShapeBytes(measured: MeasuredShape): number {
  return measured.vertices.byteLength + measured.indices.byteLength;
}

/** Telemetry for tests and tuning; not part of the derived state. */
export interface RebuildCacheEvent {
  kind: 'full-rebuild' | 'prefix-restore';
  /** Features replayed by this sync (total on a full rebuild). */
  replayed: number;
  /** Features restored from the cache (0 on a full rebuild). */
  restored: number;
  /** Bodies tessellated and measured by this sync. */
  remeasured: number;
  /** Bodies whose measurement was served from the per-body cache. */
  reusedMeasurements: number;
}
