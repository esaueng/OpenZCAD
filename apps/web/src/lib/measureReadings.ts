import type {
  BodyRepresentation,
  TopologySelection,
  UnitSystem
} from '@openzcad/shared';
import type { PickSnap } from '@openzcad/viewport';
import type {
  FormattedMeasurement,
  Measurement,
  MeasurementTarget
} from './measurements';
import type { MeasurePointKind } from './measurePointKinds';
/**
 * The measurement module's shape. A type-only namespace import is erased at
 * build time, so this module stays eager and tiny while the solver it drives
 * stays in its own lazily loaded chunk.
 */
import type * as MeasurementModule from './measurements';

type Vector3 = { x: number; y: number; z: number };

/**
 * One click while Measure is on: what was hit, where, and the snap glyph
 * the pointer showed. Readings are derived from these on demand, so a pick
 * never commits to one interpretation of itself.
 */
export interface MeasurePick {
  selection: TopologySelection;
  point?: Vector3;
  snap?: PickSnap;
}

/**
 * What a pick session can read. The first two describe a single pick (or a
 * Shift+Click run of edges); the rest relate two picks. These are the old
 * dock's modes, now offered side by side instead of chosen up front.
 */
export type MeasureReadingKind =
  | 'single'
  | 'edge-total'
  | 'parallel'
  | 'central'
  | 'distance'
  | 'maximum'
  | 'angle';

export interface MeasureReading {
  kind: MeasureReadingKind;
  /** What the reading is, shown above or beside its value. */
  title: string;
  measurement: Measurement;
}

/** A reading with its figure already formatted for the current display. */
export interface FormattedMeasureReading extends MeasureReading {
  formatted: FormattedMeasurement;
}

/** What the Measure card shows: the picks, by name, and what they read. */
export interface MeasureSessionView {
  first: { label: string } | null;
  second: { label: string } | null;
  readings: FormattedMeasureReading[];
  /** The reading shown large, and the one Keep records. */
  primary: FormattedMeasureReading | null;
  distanceRefusal: string | null;
}

export interface MeasureReadingsInput {
  /** Picks resolve against what the viewport draws, previews included. */
  bodies: Record<string, BodyRepresentation>;
  /** The bodies on screen, which the entity distances read geometry from. */
  viewerBodies: readonly BodyRepresentation[];
  revision: number;
  units: UnitSystem;
  /** M13: the point a Distance reading records from each pick. */
  pointKind: MeasurePointKind;
}

export interface MeasureReadings {
  readings: MeasureReading[];
  /**
   * Why a Distance reading is missing when the chosen point kind could not be
   * found on a pick. Other readings simply do not apply to some pairs, and
   * listing every inapplicable one would bury the ones that do.
   */
  distanceRefusal: string | null;
}

/**
 * The order two-pick readings are offered in, most specific first. A gap
 * between parallel faces is what someone picking two parallel faces is
 * after; a center-to-target distance beats a plain point-to-point one when a
 * circle is involved; the farthest span and the angle are supporting facts.
 */
const PAIR_ORDER: readonly Exclude<
  MeasureReadingKind,
  'single' | 'edge-total'
>[] = ['parallel', 'central', 'distance', 'maximum', 'angle'];

const PAIR_TITLES: Record<(typeof PAIR_ORDER)[number], string> = {
  parallel: 'Parallel distance',
  central: 'Central distance',
  distance: 'Distance',
  maximum: 'Maximum distance',
  angle: 'Angle'
};

/** Whether two picks name the same entity of the same body. */
export function samePickEntity(first: MeasurePick, second: MeasurePick) {
  const a = first.selection;
  const b = second.selection;
  return (
    a.bodyId === b.bodyId &&
    a.kind === b.kind &&
    (a.kind === 'body' || a.topologyId === b.topologyId)
  );
}

/**
 * The target a Distance reading records for a pick. A pick the snap locked
 * onto records the point the glyph named; a chosen point kind records that
 * point or nothing; anything else uses the selection's own derivation.
 */
export function distanceTarget(
  api: typeof MeasurementModule,
  body: BodyRepresentation,
  pick: MeasurePick,
  pointKind: MeasurePointKind
): MeasurementTarget | null {
  const { selection, point, snap } = pick;
  if (pointKind !== 'auto') {
    // A glyph names its own edge: the pick records that edge's point, which
    // must land where the glyph stood, never a point of whatever the ray
    // happened to hit beside it.
    if (snap?.source && point) {
      const target = api.pointKindTarget(
        body,
        api.snapSourceSelection(body, snap.source),
        pointKind,
        point,
        snap.source.role
      );
      return api.pointKindAgrees(body, target, point) ? target : null;
    }
    return api.pointKindTarget(body, selection, pointKind, point);
  }
  const snapped =
    snap?.source && point
      ? api.measurementTargetFromSnap(body, snap.source, point)
      : null;
  return (
    snapped ??
    api.measurementTargetFromSelection(body, selection, point, 'distance')
  );
}

/** The single-pick reading: length, diameter, area or volume. */
function singleReading(
  api: typeof MeasurementModule,
  input: MeasureReadingsInput,
  pick: MeasurePick
): MeasureReading | null {
  const body = input.bodies[pick.selection.bodyId];
  if (!body) return null;
  const measurement = api.createSmartMeasurement(
    body,
    pick.selection,
    pick.point,
    input.revision,
    input.units
  );
  return measurement
    ? { kind: 'single', title: singleTitle(measurement), measurement }
    : null;
}

function singleTitle(measurement: Measurement): string {
  switch (measurement.kind) {
    case 'edge-length':
      return 'Length';
    case 'diameter':
      return 'Diameter';
    case 'face-area':
      return 'Area';
    case 'body':
      return 'Volume';
    default:
      return 'Measurement';
  }
}

/**
 * The name a pick goes by in the session card: the snapped point when a snap
 * named one, otherwise the entity itself.
 */
export function pickLabel(
  api: typeof MeasurementModule,
  input: MeasureReadingsInput,
  pick: MeasurePick
): string | null {
  const body = input.bodies[pick.selection.bodyId];
  if (!body) return null;
  if (pick.snap?.source || input.pointKind !== 'auto') {
    const target = distanceTarget(api, body, pick, input.pointKind);
    if (target) return target.label;
  }
  return (
    api.measurementTargetFromSelection(
      body,
      pick.selection,
      pick.point,
      'smart'
    )?.label ??
    distanceTarget(api, body, pick, input.pointKind)?.label ??
    null
  );
}

/** Whether a pick has anything to measure at all, alone or against another. */
export function pickIsMeasurable(
  api: typeof MeasurementModule,
  input: MeasureReadingsInput,
  pick: MeasurePick
): boolean {
  const body = input.bodies[pick.selection.bodyId];
  if (!body) return false;
  return (
    singleReading(api, input, pick) !== null ||
    Boolean(distanceTarget(api, body, pick, input.pointKind)?.point) ||
    Boolean(
      api.measurementTargetFromSelection(
        body,
        pick.selection,
        pick.point,
        'angle'
      )?.direction
    )
  );
}

function pairReading(
  api: typeof MeasurementModule,
  input: MeasureReadingsInput,
  kind: (typeof PAIR_ORDER)[number],
  first: MeasurePick,
  second: MeasurePick
): MeasureReading | { refused: string } | null {
  const firstBody = input.bodies[first.selection.bodyId];
  const secondBody = input.bodies[second.selection.bodyId];
  if (!firstBody || !secondBody) return null;
  let measurement: Measurement | { refused: string } | null;
  if (kind === 'distance') {
    const a = distanceTarget(api, firstBody, first, input.pointKind);
    const b = distanceTarget(api, secondBody, second, input.pointKind);
    if (!a?.point || !b?.point) {
      return input.pointKind === 'auto'
        ? null
        : {
            refused:
              api.pointKindFailure(
                input.pointKind,
                (a?.point ? second : first).selection.kind
              ) ?? `No ${input.pointKind} on that pick.`
          };
    }
    measurement = api.createDistanceMeasurement(
      a,
      b,
      input.revision,
      input.units
    );
  } else {
    // The entity distances store their picks as Distance does; the geometry
    // they measure is read from the topology at measure time. Angle needs
    // directions, which a snapped point does not carry.
    const purpose = kind === 'angle' ? 'angle' : 'distance';
    const a = api.measurementTargetFromSelection(
      firstBody,
      first.selection,
      first.point,
      purpose
    );
    const b = api.measurementTargetFromSelection(
      secondBody,
      second.selection,
      second.point,
      purpose
    );
    if (!a?.point || !b?.point) return null;
    measurement =
      kind === 'angle'
        ? api.createAngleMeasurement(a, b, input.revision, input.units)
        : api.createEntityDistanceMeasurement(
            kind,
            [...input.viewerBodies],
            a,
            b,
            input.revision,
            input.units
          );
  }
  if (!measurement) return null;
  if ('refused' in measurement) return measurement;
  return { kind, title: PAIR_TITLES[kind], measurement };
}

/** Two readings that would print the same figure; the second adds nothing. */
function duplicates(first: Measurement, second: Measurement): boolean {
  if (first.result.dimension !== second.result.dimension) return false;
  const scale = Math.max(
    Math.abs(first.result.value),
    Math.abs(second.result.value),
    1
  );
  return Math.abs(first.result.value - second.result.value) <= scale * 1e-9;
}

/**
 * Every reading the picks support, most useful first. One pick reads as
 * itself (or, after a Shift+Click run, as the run's total length); two picks
 * read as every relation between them that holds, each figure listed once.
 */
export function measureReadings(
  api: typeof MeasurementModule,
  input: MeasureReadingsInput,
  picks: {
    first: MeasurePick | null;
    second: MeasurePick | null;
    edgeRun: readonly TopologySelection[];
  }
): MeasureReadings {
  const { first, second, edgeRun } = picks;
  if (!first) return { readings: [], distanceRefusal: null };
  if (!second) {
    const readings: MeasureReading[] = [];
    if (edgeRun.length >= 2) {
      const total = api.createEdgeTotalMeasurement(
        [...input.viewerBodies],
        edgeRun,
        input.revision,
        input.units
      );
      if (total) {
        readings.push({
          kind: 'edge-total',
          title: `Total length · ${edgeRun.length} edges`,
          measurement: total
        });
      }
    }
    const single = singleReading(api, input, first);
    if (single) readings.push(single);
    return { readings, distanceRefusal: null };
  }
  const readings: MeasureReading[] = [];
  let distanceRefusal: string | null = null;
  for (const kind of PAIR_ORDER) {
    const reading = pairReading(api, input, kind, first, second);
    if (!reading) continue;
    if ('refused' in reading) {
      if (kind === 'distance') distanceRefusal = reading.refused;
      continue;
    }
    if (
      readings.some((earlier) =>
        duplicates(earlier.measurement, reading.measurement)
      )
    ) {
      continue;
    }
    readings.push(reading);
  }
  return { readings, distanceRefusal };
}
