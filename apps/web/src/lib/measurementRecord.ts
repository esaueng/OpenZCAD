import type { Measurement, MeasurementDisplayOptions } from './measurements';

/**
 * Measurements that outlive the session that took them.
 *
 * They live beside the project document rather than inside it. Document
 * equality and the exact-rebuild cache both describe authored model content;
 * folding observations into either would manufacture divergence and replay
 * geometry for a view-only action.
 */

/** Bumped only when a stored record can no longer be read safely. */
export const MEASUREMENT_RECORD_VERSION = 1;

/** Bounds a future sync payload and rejects unbounded local records. */
export const MEASUREMENT_RECORD_MAX_ITEMS = 200;

export interface StoredMeasurementRecord {
  projectId: string;
  version: number;
  /** When this device last wrote it, for a human-readable sync decision. */
  updatedAt: string;
  measurements: Measurement[];
  display: MeasurementDisplayOptions;
}

/**
 * What actually gets written for one measurement.
 *
 * `annotation` is derived world-space geometry and most of the bytes. The next
 * refresh rebuilds it from the targets; the numeric result remains as the
 * receipt when those targets no longer resolve.
 */
export function persistableMeasurement(measurement: Measurement): Measurement {
  const { annotation: _annotation, ...rest } = measurement;
  return rest;
}

export function buildMeasurementRecord(
  projectId: string,
  measurements: readonly Measurement[],
  display: MeasurementDisplayOptions,
  updatedAt: string
): StoredMeasurementRecord {
  return {
    projectId,
    version: MEASUREMENT_RECORD_VERSION,
    updatedAt,
    measurements: measurements
      .slice(0, MEASUREMENT_RECORD_MAX_ITEMS)
      .map(persistableMeasurement),
    display
  };
}
