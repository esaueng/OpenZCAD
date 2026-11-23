/**
 * The seam I03 reference re-capture (plan §3.2) uses to observe, and during
 * a conversion translate, every persisted-reference lookup an exact build
 * makes. Three resolvers consult it:
 *
 * - `resolveTopologyReference` (schema-v5 and legacy witness-hash lookups);
 * - `faceHandlesByFingerprint` / `edgeHandlesByFingerprint` (legacy hashes
 *   in any of the ADR-011 and pre-ADR-011 schemes);
 * - region profile resolution (`regionFingerprint` / `profileId`).
 *
 * Nothing installs hooks outside `computeConversionReferenceMap`, and with
 * none installed every resolver behaves exactly as before. The slot is
 * realm-wide because the resolvers are free functions without an adapter in
 * scope, so a re-capture claims it exclusively for the length of its own
 * builds and refuses to start while another holds it. Its caller must also
 * keep every other adapter in the realm idle meanwhile: phase 5 must run it
 * on the geometry worker's serial build queue (tests build sequentially).
 */
import type { SketchProfile } from '@openzcad/geometry';
import type {
  EdgeWitnessV1,
  FaceWitnessV1,
  SketchRegionProfileReference,
  TopologyReferenceV5
} from '@openzcad/shared';
import type {
  LegacyTopologyHashReference,
  LineageAvailability,
  TopologyResolutionCandidate,
  TopologyResolutionResult
} from './topology-lineage';

/** How a stored legacy hash was computed, so a re-capture keeps its scheme. */
export type FingerprintScheme = 'witness' | 'fingerprint' | 'legacy';

/** What a fingerprint map can measure about the handles it holds. */
export interface FingerprintProbe {
  readonly kind: 'face' | 'edge';
  witnessOf(handle: number): FaceWitnessV1 | EdgeWitnessV1;
  hashOf(scheme: FingerprintScheme, handle: number): number;
}

export interface ReferenceRecaptureHooks {
  resolveTopology(
    reference: TopologyReferenceV5 | LegacyTopologyHashReference,
    candidates: readonly TopologyResolutionCandidate[],
    availability: LineageAvailability,
    resolve: (
      reference: TopologyReferenceV5 | LegacyTopologyHashReference
    ) => TopologyResolutionResult
  ): TopologyResolutionResult;
  /** Wraps a hash → handles map so each `get` can be observed or translated. */
  fingerprintMap(
    map: Map<number, number[]>,
    probe: FingerprintProbe
  ): Map<number, number[]>;
  resolveProfile<P extends SketchProfile>(
    reference: SketchRegionProfileReference,
    profiles: readonly P[],
    resolve: (reference: SketchRegionProfileReference) => P
  ): P;
}

let active: ReferenceRecaptureHooks | null = null;

/** The installed hooks, or null outside a re-capture. */
export function referenceRecaptureHooks(): ReferenceRecaptureHooks | null {
  return active;
}

/** Runs `run` with `hooks` installed; refuses to nest or overlap. */
export async function withReferenceRecapture<T>(
  hooks: ReferenceRecaptureHooks,
  run: () => Promise<T>
): Promise<T> {
  if (active)
    throw new Error(
      'A stored-unit reference re-capture is already running; run one at a time.'
    );
  active = hooks;
  try {
    return await run();
  } finally {
    active = null;
  }
}
