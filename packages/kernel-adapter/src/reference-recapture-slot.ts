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
 * scope, so a re-capture claims it synchronously, before its first await,
 * for its whole computation, and a second caller is told it is busy. The
 * exact build loop reports each feature boundary, so every lookup is
 * attributed to the feature whose build made it. Its caller must also
 * keep every other adapter in the realm idle meanwhile: phase 5 must run it
 * on the geometry worker's serial build queue (tests build sequentially).
 */
import type { SketchProfile } from '@openzcad/geometry';
import type { BlendOrientationReport } from './blend-orientation';
import type { RemusKernel } from './remus-runtime';
import type {
  BodyId,
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
  /**
   * The native orientation of an asymmetric blend's edges, reported by the
   * edge-modifier build (`blend-orientation.ts`) once its edges resolve.
   */
  noteBlendOrientation?(report: BlendOrientationReport): void;
  /**
   * A measured body's solids and its face handles in `topology.faces`
   * order, reported by the exact measurement while its kernel still holds
   * them. The geometry oracle compares the faces whose area is a
   * tessellation estimate, which cannot be compared across units by area
   * (`units-reference-recapture.ts`).
   */
  noteBodyFaces?(
    bodyId: BodyId,
    kernel: RemusKernel,
    solids: readonly number[],
    faces: readonly number[]
  ): void;
}

let claimed = false;
let active: ReferenceRecaptureHooks | null = null;
let feature: string | null = null;

/** The installed hooks, or null outside a re-capture build. */
export function referenceRecaptureHooks(): ReferenceRecaptureHooks | null {
  return active;
}

/**
 * The feature whose build is running, as the exact build loop reports it
 * (null between features). Re-capture keys every lookup by it, so a stored
 * identity is matched and verified from its own feature's lookup and never
 * credited with another feature's lookup of an equal hash.
 */
export function referenceRecaptureFeature(): string | null {
  return feature;
}

/** Called by the exact build loop at each feature boundary. */
export function noteReferenceRecaptureFeature(featureId: string | null): void {
  if (active) feature = featureId;
}

/** Exclusive ownership of the slot for one whole re-capture. */
export interface ReferenceRecaptureClaim {
  /** Runs `run` with `hooks` installed (one build). */
  build<T>(hooks: ReferenceRecaptureHooks, run: () => Promise<T>): Promise<T>;
  release(): void;
}

/**
 * Claims the slot synchronously, or returns null when another re-capture
 * holds it. Claiming before the first `await` is what lets a concurrent
 * caller be told it is busy instead of failing in the middle of a build.
 */
export function claimReferenceRecapture(): ReferenceRecaptureClaim | null {
  if (claimed) return null;
  claimed = true;
  let released = false;
  return {
    async build(hooks, run) {
      if (released || active)
        throw new Error('The stored-unit re-capture slot is not held.');
      active = hooks;
      feature = null;
      try {
        return await run();
      } finally {
        active = null;
        feature = null;
      }
    },
    release() {
      if (released) return;
      released = true;
      claimed = false;
    }
  };
}
