import { toBodyId } from '@openzcad/shared';
import type {
  BodyRepresentation,
  DerivedState,
  FeatureNode,
  FeatureWarning,
  ProjectDocument
} from '@openzcad/shared';
import {
  kernelRefusedBucket,
  type KernelRefusalObservation
} from './analytics';

/**
 * WS3 harvest: notices a kernel refusal that a candidate rebuild introduced,
 * keeps the most recent one in memory so the user can explicitly save a
 * reproduction of it, and reports one opt-in aggregate count per new cell.
 *
 * Nothing here leaves the page on its own. The capture is session memory,
 * replaced by the next refusal, and only `track` (the consent-gated Glimpse
 * client) sends anything — and what it sends is the fixed-vocabulary bucket.
 */
export interface RefusalCapture {
  /** The candidate document whose rebuild refused (contains the feature). */
  document: ProjectDocument;
  warning: FeatureWarning;
  observation: KernelRefusalObservation;
}

export function isRefusingWarning(warning: FeatureWarning): boolean {
  return warning.kind === 'build-failed' || warning.kind === 'refusal';
}

/**
 * Refusals in `derived` that the baseline (the build on screen) did not
 * already have. A feature that was failing before this candidate is not a
 * new observation: re-reporting it on every rebuild would count one broken
 * feature once per keystroke.
 */
export function newRefusingWarnings(
  derived: Pick<DerivedState, 'featureWarnings'>,
  baseline: readonly FeatureWarning[]
): FeatureWarning[] {
  const known = new Set(
    baseline.filter(isRefusingWarning).map((warning) => warning.featureId)
  );
  return (derived.featureWarnings ?? []).filter(
    (warning) => isRefusingWarning(warning) && !known.has(warning.featureId)
  );
}

function featureNode(
  document: ProjectDocument,
  featureId: string
): FeatureNode | undefined {
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'feature' && node.featureId === featureId) return node;
  }
  return undefined;
}

/** Face hashes or edge hashes the feature picked, and the body it picked on. */
function topologyPick(feature: FeatureNode): {
  bodyId?: string;
  faceHash?: number;
  edgeHashes?: number[];
} {
  const data = feature.data as unknown as Record<string, unknown>;
  const bodyId =
    typeof data.targetBodyId === 'string' ? data.targetBodyId : undefined;
  if (data.featureKind === 'direct-edit') {
    const operation = data.operation as Record<string, unknown> | undefined;
    const faceHash = operation?.faceHash;
    return {
      ...(bodyId ? { bodyId } : {}),
      ...(typeof faceHash === 'number' ? { faceHash } : {})
    };
  }
  if (data.featureKind === 'fillet' || data.featureKind === 'chamfer') {
    const edgeHashes = Array.isArray(data.edgeHashes)
      ? data.edgeHashes.filter(
          (hash): hash is number => typeof hash === 'number'
        )
      : [];
    return { ...(bodyId ? { bodyId } : {}), edgeHashes };
  }
  return bodyId ? { bodyId } : {};
}

function topologyBody(
  bodyId: string | undefined,
  sources: readonly (Pick<DerivedState, 'bodyRepresentations'> | undefined)[],
  hashes: readonly number[]
): BodyRepresentation | undefined {
  if (!bodyId || hashes.length === 0) return undefined;
  for (const source of sources) {
    const body = source?.bodyRepresentations[toBodyId(bodyId)];
    const topology = body?.topology;
    if (
      topology &&
      hashes.every(
        (hash) =>
          topology.faces.some((face) => face.hash === hash) ||
          topology.edges.some((edge) => edge.hash === hash)
      )
    )
      return body;
  }
  return undefined;
}

/**
 * The surface-type signature of the pick, from topology the build already
 * published: the target face and the faces sharing an edge with it, or for an
 * edge modifier the faces its edges bound. Absent when it is not on hand —
 * this never asks the kernel for more.
 */
function surfaceSignature(
  feature: FeatureNode,
  sources: readonly (Pick<DerivedState, 'bodyRepresentations'> | undefined)[]
): Pick<KernelRefusalObservation, 'targetSurface' | 'neighbourSurfaces'> {
  const pick = topologyPick(feature);
  if (pick.faceHash !== undefined) {
    const body = topologyBody(pick.bodyId, sources, [pick.faceHash]);
    const topology = body?.topology;
    const face = topology?.faces.find((entry) => entry.hash === pick.faceHash);
    if (!topology || !face) return {};
    const neighbourHashes = new Set<number>();
    for (const edge of topology.edges) {
      const adjacent = edge.adjacentFaceHashes ?? [];
      if (!adjacent.includes(pick.faceHash)) continue;
      for (const hash of adjacent)
        if (hash !== pick.faceHash) neighbourHashes.add(hash);
    }
    return {
      targetSurface: face.geometry?.surfaceType ?? 'other',
      neighbourSurfaces: topology.faces
        .filter((entry) => neighbourHashes.has(entry.hash))
        .map((entry) => entry.geometry?.surfaceType ?? 'other')
    };
  }
  if (pick.edgeHashes && pick.edgeHashes.length > 0) {
    const body = topologyBody(pick.bodyId, sources, pick.edgeHashes);
    const topology = body?.topology;
    if (!topology) return {};
    const faceHashes = new Set(
      topology.edges
        .filter((edge) => pick.edgeHashes!.includes(edge.hash))
        .flatMap((edge) => edge.adjacentFaceHashes ?? [])
    );
    return {
      neighbourSurfaces: topology.faces
        .filter((face) => faceHashes.has(face.hash))
        .map((face) => face.geometry?.surfaceType ?? 'other')
    };
  }
  return {};
}

/**
 * The fields the analytics contract names, read off the refusing feature.
 * `sources` are the derived states to look the pick up in, most specific
 * first — the candidate's own rebuild, then the build the pick was made on.
 */
export function refusalObservation(
  document: ProjectDocument,
  warning: FeatureWarning,
  sources: readonly (Pick<DerivedState, 'bodyRepresentations'> | undefined)[]
): KernelRefusalObservation {
  const feature = featureNode(document, warning.featureId);
  const data = feature?.data;
  const refusal = warning.kernelRefusal;
  return {
    warningKind: warning.kind,
    ...(data ? { featureKind: data.featureKind } : {}),
    ...(data?.featureKind === 'direct-edit'
      ? { directEditKind: data.operation.kind }
      : {}),
    ...(refusal
      ? {
          family: refusal.family,
          category: refusal.category,
          code: refusal.code,
          ...(refusal.operation ? { kernelOperation: refusal.operation } : {})
        }
      : {}),
    ...(feature ? surfaceSignature(feature, sources) : {})
  };
}

export interface RefusalHarvesterOptions {
  /** Consent-gated sink; called at most once per document state and cell. */
  track(observation: KernelRefusalObservation): void;
  /** Called with each new capture, for a surface offering to save it. */
  onCapture?(capture: RefusalCapture): void;
  /** Called when the held capture is dropped. */
  onClear?(): void;
}

export interface RefusalHarvester {
  /**
   * Look at one candidate rebuild. Returns the capture when it introduced a
   * refusal. A rebuild that introduced none drops the held capture: the
   * latest attempt did not refuse, so a refusal still on screen is not the
   * one this would save, and offering it would mislabel the file.
   */
  observe(
    candidate: ProjectDocument,
    derived: DerivedState,
    baseline: {
      featureWarnings: readonly FeatureWarning[];
      derived?: Pick<DerivedState, 'bodyRepresentations'>;
    }
  ): RefusalCapture | null;
  latest(): RefusalCapture | null;
  /** Drops the held capture (a commit or project switch moved on from it). */
  clear(): void;
}

/** How many recent document-state/cell keys suppress a repeat count. */
const RECENT_KEYS = 64;

export function createRefusalHarvester(
  options: RefusalHarvesterOptions
): RefusalHarvester {
  let latest: RefusalCapture | null = null;
  const recent: string[] = [];
  const drop = () => {
    if (latest === null) return;
    latest = null;
    options.onClear?.();
  };
  return {
    observe(candidate, derived, baseline) {
      const fresh = newRefusingWarnings(derived, baseline.featureWarnings);
      const warning = fresh[0];
      if (!warning) {
        drop();
        return null;
      }
      const observation = refusalObservation(candidate, warning, [
        derived,
        baseline.derived
      ]);
      const capture: RefusalCapture = {
        document: candidate,
        warning,
        observation
      };
      latest = capture;
      // A drag previews many candidates of one edit, all built on the same
      // base, so they share a version: one count per base state and cell.
      // The key is page-local and never sent.
      const key = `${candidate.projectId}\u0000${candidate.version}\u0000${
        kernelRefusedBucket(observation) ?? ''
      }`;
      if (!recent.includes(key)) {
        recent.push(key);
        if (recent.length > RECENT_KEYS) recent.shift();
        options.track(observation);
      }
      options.onCapture?.(capture);
      return capture;
    },
    latest: () => latest,
    clear: drop
  };
}
