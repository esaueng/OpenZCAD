import type { UnitSystem } from '@openzcad/shared';
import type {
  Measurement,
  MeasurementDimension,
  MeasurementDisplayOptions,
  MeasurementKind,
  MeasurementQuality,
  MeasurementStatus,
  MeasurementTarget,
  RadialDisplay
} from './measurements';
import {
  MEASUREMENT_RECORD_MAX_ITEMS,
  MEASUREMENT_RECORD_VERSION,
  type StoredMeasurementRecord
} from './measurementRecord';
export {
  buildMeasurementRecord,
  MEASUREMENT_RECORD_MAX_ITEMS,
  MEASUREMENT_RECORD_VERSION,
  persistableMeasurement,
  type StoredMeasurementRecord
} from './measurementRecord';

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

const UNITS: readonly UnitSystem[] = ['mm', 'cm', 'm', 'inch'];
const RADIAL: readonly RadialDisplay[] = ['diameter', 'radius'];
const KINDS: readonly MeasurementKind[] = [
  'edge-length',
  'edge-total',
  'diameter',
  'face-area',
  'body',
  'distance',
  'angle'
];
const QUALITIES: readonly MeasurementQuality[] = [
  'exact-analytic',
  'exact-kernel',
  'tessellated',
  'sampled',
  'unavailable'
];
const STATUSES: readonly MeasurementStatus[] = [
  'current',
  'stale',
  'unresolved'
];
const DIMENSIONS: readonly MeasurementDimension[] = [
  'length',
  'area',
  'volume',
  'angle'
];
const TARGET_KINDS: readonly MeasurementTarget['kind'][] = [
  'body',
  'face',
  'edge'
];
const TARGET_SEMANTICS: readonly MeasurementTarget['semantic'][] = [
  'body-center',
  'face-center',
  'circle-center',
  'edge-midpoint',
  'pick'
];
const REASONS = ['body-missing', 'not-found', 'ambiguous'] as const;
const ANGLE_CONVENTIONS = [
  'between-normals',
  'dihedral',
  'included',
  'acute',
  'line-to-plane'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function parseVector(
  value: unknown
): { x: number; y: number; z: number } | null {
  if (!isRecord(value)) {
    return null;
  }
  const { x, y, z } = value;
  return typeof x === 'number' &&
    Number.isFinite(x) &&
    typeof y === 'number' &&
    Number.isFinite(y) &&
    typeof z === 'number' &&
    Number.isFinite(z)
    ? { x, y, z }
    : null;
}

function parseTarget(value: unknown): MeasurementTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  const { bodyId, bodyName, kind, label, semantic, quality } = value;
  if (
    typeof bodyId !== 'string' ||
    bodyId.length === 0 ||
    typeof bodyName !== 'string' ||
    !isOneOf(kind, TARGET_KINDS) ||
    typeof label !== 'string' ||
    !isOneOf(semantic, TARGET_SEMANTICS) ||
    !isOneOf(quality, QUALITIES)
  ) {
    return null;
  }

  const target: MeasurementTarget = {
    bodyId: bodyId as MeasurementTarget['bodyId'],
    bodyName,
    kind,
    label,
    semantic,
    quality
  };
  if (value.topologyId !== undefined) {
    if (typeof value.topologyId !== 'string') return null;
    target.topologyId = value.topologyId;
  }
  if (value.hash !== undefined) {
    if (typeof value.hash !== 'number' || !Number.isFinite(value.hash)) {
      return null;
    }
    target.hash = value.hash;
  }
  if (value.reference !== undefined) {
    if (!isRecord(value.reference)) return null;
    // The kernel resolver validates the versioned reference's full integrity
    // before using lineage or fallback. This boundary only ensures an attacker
    // cannot hand that resolver a primitive.
    target.reference =
      value.reference as unknown as MeasurementTarget['reference'];
  }
  for (const field of ['point', 'direction'] as const) {
    if (value[field] === undefined) continue;
    const vector = parseVector(value[field]);
    if (!vector) return null;
    target[field] = vector;
  }
  if (value.endpoints !== undefined) {
    if (!Array.isArray(value.endpoints) || value.endpoints.length !== 2) {
      return null;
    }
    const first = parseVector(value.endpoints[0]);
    const second = parseVector(value.endpoints[1]);
    if (!first || !second) return null;
    target.endpoints = [first, second];
  }
  return target;
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
  const {
    id,
    kind,
    label,
    result,
    quality,
    status,
    targets,
    sourceRevision,
    sourceUnit,
    visible
  } = value;
  if (
    typeof id !== 'string' ||
    !isOneOf(kind, KINDS) ||
    typeof label !== 'string' ||
    !isOneOf(quality, QUALITIES) ||
    !isOneOf(status, STATUSES) ||
    !Array.isArray(targets) ||
    !isRecord(result) ||
    typeof result.value !== 'number' ||
    !Number.isFinite(result.value) ||
    !isOneOf(result.dimension, DIMENSIONS) ||
    typeof sourceRevision !== 'number' ||
    !Number.isInteger(sourceRevision) ||
    sourceRevision < 0 ||
    !isOneOf(sourceUnit, UNITS) ||
    typeof visible !== 'boolean'
  ) {
    return null;
  }
  const parsedTargets = targets.map(parseTarget);
  if (parsedTargets.some((target) => target === null)) {
    return null;
  }

  const parsedResult: Measurement['result'] = {
    value: result.value,
    dimension: result.dimension
  };
  if (result.components !== undefined) {
    const components = parseVector(result.components);
    if (!components) return null;
    parsedResult.components = components;
  }
  if (result.secondary !== undefined) {
    if (
      !isRecord(result.secondary) ||
      typeof result.secondary.label !== 'string' ||
      typeof result.secondary.value !== 'number' ||
      !Number.isFinite(result.secondary.value) ||
      !isOneOf(result.secondary.dimension, DIMENSIONS)
    ) {
      return null;
    }
    parsedResult.secondary = {
      label: result.secondary.label,
      value: result.secondary.value,
      dimension: result.secondary.dimension
    };
  }

  const parsed: Measurement = {
    id,
    kind,
    label,
    targets: parsedTargets as MeasurementTarget[],
    result: parsedResult,
    quality,
    status,
    sourceRevision,
    sourceUnit,
    visible
  };
  if (value.renamed !== undefined) {
    if (typeof value.renamed !== 'boolean') return null;
    parsed.renamed = value.renamed;
  }
  if (value.note !== undefined) {
    if (typeof value.note !== 'string') return null;
    parsed.note = value.note;
  }
  if (value.reason !== undefined) {
    if (!isOneOf(value.reason, REASONS)) return null;
    parsed.reason = value.reason;
  }
  if (value.angleConvention !== undefined) {
    if (!isOneOf(value.angleConvention, ANGLE_CONVENTIONS)) return null;
    parsed.angleConvention = value.angleConvention;
  }
  // `annotation` and unknown fields are deliberately not copied. Annotation is
  // derived world-space geometry, the largest term in the payload, and the
  // next refresh rebuilds it from these validated targets.
  return parsed;
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
    !Number.isInteger(version) ||
    version < 1 ||
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
