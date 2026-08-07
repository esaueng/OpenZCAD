import type { UnitSystem } from '@openzcad/shared';
import type {
  Measurement,
  MeasurementDisplayOptions,
  RadialDisplay
} from './measurements';

/**
 * Measurements that outlive the session that took them.
 *
 * They belong to a project, not to a tab: someone who measures a part, closes
 * the laptop, and comes back to check a figure should find it. But they must
 * NOT go into `ProjectDocument`. `syncComparableDocument` exempts only
 * `{ownerUserId, version, derived}`, so anything else written there makes an
 * otherwise-identical project read `diverged` and manufactures recovery
 * copies; and the document is what `canonicalProjectContentKey` hashes, so
 * every measurement would invalidate the exact rebuild cache and force a full
 * replay of the model's history.
 *
 * So this is a sibling record, keyed by project, in its own store — the same
 * reasoning that gave shelf state, sync baselines, thumbnails and summaries
 * each their own: they answer different questions, and folding one into
 * another makes it a lie on the far side.
 */

/**
 * Bumped only when a stored record can no longer be read by the parser below.
 * A reader that meets a HIGHER version refuses rather than guessing — see
 * {@link parseStoredMeasurements}.
 */
export const MEASUREMENT_RECORD_VERSION = 1;

/**
 * Caps, chosen so a full record stays small enough to hand to a sync route
 * later without a second conversation about size.
 *
 * `MEASUREMENT_LIMIT` in `measurements.ts` already refuses a fifty-first
 * measurement in the session. These are the belt to that brace: a record that
 * arrives over-long from another device, or from a future version, is
 * truncated on READ rather than trusted, because the alternative is a
 * malformed record wedging the app open at a project it cannot load.
 */
export const MEASUREMENT_RECORD_MAX_ITEMS = 200;

export interface StoredMeasurementRecord {
  projectId: string;
  version: number;
  /** When this device last wrote it, for a human-readable sync decision. */
  updatedAt: string;
  measurements: Measurement[];
  display: MeasurementDisplayOptions;
}

const UNITS: readonly UnitSystem[] = ['mm', 'cm', 'm', 'inch'];
const RADIAL: readonly RadialDisplay[] = ['diameter', 'radius'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDisplay(value: unknown): MeasurementDisplayOptions | null {
  if (!isRecord(value)) {
    return null;
  }
  const unit = value.unit;
  const precision = value.precision;
  const radialDisplay = value.radialDisplay;
  if (
    typeof unit !== 'string' ||
    !UNITS.includes(unit as UnitSystem) ||
    typeof precision !== 'number' ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 6 ||
    typeof radialDisplay !== 'string' ||
    !RADIAL.includes(radialDisplay as RadialDisplay)
  ) {
    return null;
  }
  return {
    unit: unit as UnitSystem,
    precision,
    radialDisplay: radialDisplay as RadialDisplay
  };
}

/**
 * A stored measurement, checked far enough to be safe to render.
 *
 * Not checked exhaustively: the fields that decide what appears on screen are
 * validated, and everything the resolver re-derives on the next rebuild is
 * carried through. A measurement whose target no longer resolves is a state
 * the app already handles and shows honestly, so a stale reference is not a
 * reason to discard the row — it is the row doing its job.
 */
function parseMeasurement(value: unknown): Measurement | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, kind, label, result, quality, status, targets } = value;
  if (
    typeof id !== 'string' ||
    typeof kind !== 'string' ||
    typeof label !== 'string' ||
    typeof quality !== 'string' ||
    typeof status !== 'string' ||
    !Array.isArray(targets) ||
    !isRecord(result) ||
    typeof result.value !== 'number' ||
    !Number.isFinite(result.value) ||
    typeof result.dimension !== 'string'
  ) {
    return null;
  }
  // `annotation` is deliberately absent from what is written, so it is absent
  // here: it is pure derived geometry, the largest term in the payload, and
  // the next refresh rebuilds it from the resolved targets anyway.
  return value as unknown as Measurement;
}

/**
 * Reads a stored record, or returns null.
 *
 * A record written by a NEWER version is refused rather than partially read.
 * The alternative is a device on an older build silently dropping fields it
 * did not understand and then writing the truncated version back — which
 * turns a forward-compatible format into data loss on the device that had the
 * complete copy.
 */
export function parseStoredMeasurements(
  value: unknown
): StoredMeasurementRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const { projectId, version, updatedAt, measurements, display } = value;
  if (
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    typeof version !== 'number' ||
    version > MEASUREMENT_RECORD_VERSION ||
    typeof updatedAt !== 'string' ||
    !Array.isArray(measurements)
  ) {
    return null;
  }
  const parsedDisplay = parseDisplay(display);
  if (!parsedDisplay) {
    return null;
  }
  const parsed: Measurement[] = [];
  for (const entry of measurements) {
    if (parsed.length >= MEASUREMENT_RECORD_MAX_ITEMS) {
      break;
    }
    const measurement = parseMeasurement(entry);
    // One malformed row does not condemn the rest. The row is gone either way;
    // discarding forty-nine good measurements alongside it is the worse of the
    // two losses.
    if (measurement) {
      parsed.push(measurement);
    }
  }
  return {
    projectId,
    version,
    updatedAt,
    measurements: parsed,
    display: parsedDisplay
  };
}

/**
 * What actually gets written for one measurement.
 *
 * `annotation` is dropped: it is world-space line geometry recomputed from the
 * targets on every refresh, and it is most of the bytes. `result` is kept
 * whole, value included, so a row whose geometry has since vanished can still
 * show what it last read — which is the difference between a record and a
 * receipt.
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
