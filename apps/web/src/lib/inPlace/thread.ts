import {
  ISO_METRIC_COARSE_THREADS,
  PIPE_THREAD_SIZES,
  millimetresPerUnit,
  isPipeThreadSize,
  isoMetricThreadLabel,
  pipeThreadForFace,
  pipeThreadLabel,
  pipeThreadOnFace,
  pipeThreadSpec,
  threadSpanOnFace,
  type FeatureData,
  type ParamValue,
  type PipeThreadStandard,
  type ThreadAnchor,
  type ThreadProfile,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import type {
  FacePick,
  HandleSpec,
  InPlaceContext,
  InPlacePanelState,
  InPlaceRequest,
  InPlaceSlots,
  InPlaceToolSpec,
  InPlaceValueContext,
  OptionSpec,
  ValueSpec
} from './tools';

/** A thread feature's fields, as {@link InPlaceRequest} carries them. */
export type ThreadRequest = Omit<
  Extract<FeatureData, { featureKind: 'thread' }>,
  'featureKind'
>;

/**
 * A printed fit's radial clearance, in millimetres: the gap each side of a
 * mating thread. FDM parts mate at about 0.1 mm; loose leaves room for
 * coarse layers or elephant's foot.
 */
const FIT_CLEARANCE_MM = { exact: 0, print: 0.1, loose: 0.2 } as const;

/** The ISO size choices, as `M6` and so on, keyed by their option value. */
const ISO_SIZES = ISO_METRIC_COARSE_THREADS.map((size) => ({
  value: `M${size.nominal}`,
  size
}));

function isoSize(option: string | undefined) {
  return ISO_SIZES.find((entry) => entry.value === option)?.size ?? null;
}

/** Schema v57: the pipe standard a profile choice stands for, if any. */
function pipeStandard(profile: string | undefined): PipeThreadStandard | null {
  return profile === 'npt' || profile === 'bspt' ? profile : null;
}

const pipe = (state: InPlacePanelState) =>
  pipeStandard(state.options.profile) !== null;
const custom = (state: InPlacePanelState) => state.options.profile === 'custom';
const customSize = (state: InPlacePanelState) =>
  !pipe(state) && state.options.size === 'custom';
const chamfered = (state: InPlacePanelState) =>
  (state.options.chamfer ?? 'both') !== 'none';
/** The fit row a profile reads: a pipe thread's starts exact. */
const fitOption = (options: Readonly<Record<string, string>>) =>
  pipeStandard(options.profile) ? options.pipeFit : options.fit;

/**
 * Whether a thread's two ends stand on the ends of its face: `near` the one
 * it starts at, `far` the other. This is where the span reaches, not how
 * its length is stored: a length held as given (an expression, a stored
 * one) can reach the far end all the same.
 */
export interface ThreadReach {
  near: boolean;
  far: boolean;
  /**
   * Where the end could not be resolved: not known to stop short either,
   * so it takes no runout. Absent is known.
   */
  nearUnknown?: true;
  farUnknown?: true;
}

/**
 * Where a span reaches along its face, from its resolved offset and length.
 * The slack is the kernel's own, within which a span snaps to an end of the
 * face (the adapter's `threadChamfersShortOfFace` uses the same). A length
 * that follows the offset to the far end (`held` false) reaches it by
 * construction. What cannot be resolved (an expression with no value yet, a
 * face that published no cylinder) reaches nothing it is not known to.
 */
export function threadReach(span: {
  /** The length is stored as given, rather than following the offset. */
  held: boolean;
  /** Resolved; undefined where it does not resolve. */
  offset: number | undefined;
  length: number | undefined;
  face: Pick<ThreadFace, 'length' | 'radius'> | null;
}): ThreadReach {
  const { held, offset, length, face } = span;
  const snap = face ? 1e-9 * Math.max(face.length, face.radius) : 0;
  const farKnown =
    !held || (face !== null && offset !== undefined && length !== undefined);
  return {
    near: offset !== undefined && Math.abs(offset) <= snap,
    far:
      !held ||
      (face !== null &&
        offset !== undefined &&
        length !== undefined &&
        offset + length >= face.length - snap),
    ...(offset === undefined ? { nearUnknown: true as const } : {}),
    ...(farKnown ? {} : { farUnknown: true as const })
  };
}

/**
 * The ends of the face that take their chamfer. A chamfer's cone is built
 * into an end standing on the face's end plane, so only an end the thread
 * reaches takes one; an end that stops short runs out instead (see
 * {@link threadEndFinishes}).
 */
export function threadChamferedEnds(
  chamfer: string | undefined,
  from: ThreadAnchor,
  reach: ThreadReach
): { start: boolean; end: boolean } {
  const ends = threadEndFinishes(chamfer, from, reach);
  return { start: ends.start === 'chamfer', end: ends.end === 'chamfer' };
}

/**
 * How each end asked for (`chamfer`: both, start, end or none) is finished
 * (schema v57): chamfered where the thread reaches that end of the face,
 * run out where it stops short of it, so the groove fades into the collar
 * instead of ending in a full-depth wedge. An end whose reach does not
 * resolve stays plain, as before runouts.
 */
export function threadEndFinishes(
  chamfer: string | undefined,
  from: ThreadAnchor,
  reach: ThreadReach
): { start?: 'chamfer' | 'runout'; end?: 'chamfer' | 'runout' } {
  const wanted = chamfer ?? 'both';
  const reached = (end: ThreadAnchor) =>
    from === end ? reach.near : reach.far;
  const unknown = (end: ThreadAnchor) =>
    from === end ? reach.nearUnknown : reach.farUnknown;
  const finish = (end: ThreadAnchor) =>
    wanted !== 'both' && wanted !== end
      ? undefined
      : reached(end)
        ? 'chamfer'
        : unknown(end)
          ? undefined
          : 'runout';
  const start = finish('start');
  const end = finish('end');
  return {
    ...(start ? { start } : {}),
    ...(end ? { end } : {})
  };
}

/**
 * Boss or bore, as the pick reads it from the body's mesh (see
 * `cylinderFaceIsBoss`). Null where the mesh could not say; the build reads
 * the solid itself and is the one that decides.
 */
export function threadFaceKnownKind(
  face: FacePick | undefined
): 'external' | 'internal' | null {
  const boss = face?.cylinder?.boss;
  return boss === undefined ? null : boss ? 'external' : 'internal';
}

/** {@link threadFaceKnownKind}, taking a boss where the pick cannot say. */
export function threadFaceKind(
  face: FacePick | undefined
): 'external' | 'internal' {
  return threadFaceKnownKind(face) ?? 'external';
}

/**
 * Schema v57: the pipe size a pipe thread takes on this face, the stored
 * size or the face's nearest, in millimetres.
 */
function pipeSpecFor(
  standard: PipeThreadStandard,
  size: string | undefined,
  face: FacePick | undefined,
  units: UnitSystem
) {
  if (isPipeThreadSize(size)) return pipeThreadSpec(standard, size);
  const geometry = threadFace(face);
  return geometry
    ? pipeThreadForFace(
        standard,
        threadFaceKind(face),
        2 * geometry.radius * millimetresPerUnit(units)
      )
    : null;
}

/**
 * Schema v57: the length a pipe thread takes until it is dragged, by the
 * adapter's own rule: measured from the fitting face, as the standards
 * measure it, the band ends where the standard's thread ends, within the
 * face, and no further than its crest can go before it meets the cylinder;
 * the offset moves its start, not that end.
 */
export function pipeThreadDefaultLength(
  standard: PipeThreadStandard,
  size: string | undefined,
  face: FacePick | undefined,
  units: UnitSystem,
  clearance: number,
  offset: number
): number | null {
  const geometry = threadFace(face);
  if (!geometry) return null;
  // The build's own resolution (`pipeThreadOnFace`).
  const { end } = pipeThreadOnFace({
    standard,
    size: isPipeThreadSize(size) ? size : undefined,
    kind: threadFaceKind(face),
    radius: geometry.radius,
    faceLength: geometry.length,
    clearance,
    mm: millimetresPerUnit(units)
  });
  return Math.max(end - Math.max(offset, 0), 0);
}

/**
 * A picked cylinder as a thread reads it: its two ends on the axis, the unit
 * axis from start to end, its length and radius, and a direction across the
 * axis toward where it was clicked (any one, unclicked). Null when the face
 * published no cylinder.
 */
export interface ThreadFace {
  start: Vector3;
  end: Vector3;
  axis: Vector3;
  length: number;
  radius: number;
  radial: Vector3;
}

const sub = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
const along = (a: Vector3, d: Vector3, t: number): Vector3 => ({
  x: a.x + d.x * t,
  y: a.y + d.y * t,
  z: a.z + d.z * t
});
const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;

export function threadFace(face: FacePick | undefined): ThreadFace | null {
  const cylinder = face?.cylinder;
  if (!cylinder || !(cylinder.radius > 0)) return null;
  const span = sub(cylinder.axisEnd, cylinder.axisStart);
  const length = Math.hypot(span.x, span.y, span.z);
  if (!(length > 0)) return null;
  const axis = { x: span.x / length, y: span.y / length, z: span.z / length };
  const across = (direction: Vector3): Vector3 | null => {
    const off = along(direction, axis, -dot(direction, axis));
    const size = Math.hypot(off.x, off.y, off.z);
    return size > 1e-9
      ? { x: off.x / size, y: off.y / size, z: off.z / size }
      : null;
  };
  const clicked = face.point
    ? across(sub(face.point, cylinder.axisStart))
    : null;
  // Unclicked (an edit), any direction across the axis.
  const radial =
    clicked ??
    across(
      Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
    )!;
  return {
    start: cylinder.axisStart,
    end: cylinder.axisEnd,
    axis,
    // The kernel's own length where the pick carries it, as the build reads.
    length: cylinder.axialLength ?? length,
    radius: cylinder.radius,
    radial
  };
}

/** Which value holds a span's length: a thread's, or gear teeth's. */
export type SpanLengthId = 'length' | 'faceWidth';

/**
 * The stored extent of the span being edited: a thread's, or that of gear
 * teeth on a body (schema v55, whose length is their `faceWidth`).
 */
function savedSpan(
  saved: InPlaceValueContext['saved']
): { length?: ParamValue; anchor?: ThreadAnchor } | null {
  if (saved?.featureKind === 'thread') {
    return { length: saved.length, anchor: saved.anchor };
  }
  if (saved?.featureKind === 'gear' && saved.targetBodyId !== undefined) {
    return { length: saved.faceWidth, anchor: saved.anchor };
  }
  return null;
}

/**
 * Which end of the face the thread starts at: the end nearer the click on
 * it. An edit not clicked again keeps the end it stores.
 */
export function threadAnchor(
  face: FacePick | undefined,
  ctx?: Pick<InPlaceContext, 'saved'>
): ThreadAnchor {
  const geometry = threadFace(face);
  if (geometry && face?.point && !face.savedPosition) {
    const t = dot(sub(face.point, geometry.start), geometry.axis);
    return t > geometry.length / 2 ? 'end' : 'start';
  }
  return savedSpan(ctx?.saved)?.anchor ?? 'start';
}

/** Lengths this close to the face's are the whole face. */
const tolerance = (length: number) => 1e-6 * Math.max(1, length);

/**
 * Whether the thread stops short of the face: its dragged (or typed) end
 * falls short of the face's far end. Until its end is moved it runs the
 * whole face, from its offset; a stored partial thread whose length is
 * untouched stays one, even where it happens to reach the end.
 */
export function threadIsPartial(
  face: FacePick | undefined,
  values: Readonly<Record<string, ParamValue>>,
  numbers: Readonly<Record<string, number>>,
  ctx?: InPlaceContext,
  id: SpanLengthId = 'length'
): boolean {
  return lengthIsExplicit(
    threadFace(face),
    values,
    numbers,
    {
      ...(ctx?.touched ? { touched: ctx.touched } : {}),
      ...(ctx?.saved ? { saved: ctx.saved } : {})
    },
    id
  );
}

/**
 * Whether the thread's length is held as given, rather than following the
 * offset to the face's far end. Held: a stored length an edit has left as
 * stored, a length typed as an expression (kept as written, wherever it
 * reaches), and a number dragged or typed short of the far end. Following:
 * an untouched length, and a number set right at the far end. `held` holds
 * a typed expression as its text.
 */
export function lengthIsExplicit(
  geometry: ThreadFace | null,
  held: Readonly<Record<string, ParamValue>>,
  numbers: Readonly<Record<string, number>>,
  context: Pick<InPlaceValueContext, 'touched' | 'saved'>,
  id: SpanLengthId = 'length'
): boolean {
  const stored = savedSpan(context.saved)?.length;
  if (stored !== undefined && held[id] === stored) {
    return true;
  }
  if (!context.touched?.includes(id)) return false;
  if (typeof held[id] === 'string') return true;
  if (!geometry) return true;
  const reach = geometry.length - Math.max(numbers.offset ?? 0, 0);
  return (numbers[id] ?? reach) < reach - tolerance(geometry.length);
}

/** The session's values with its typed expressions as their text. */
function heldValues(
  numbers: Readonly<Record<string, number>>,
  context: InPlaceValueContext | undefined
): Record<string, ParamValue> {
  return { ...numbers, ...(context?.raws ?? {}) };
}

// The length has its handle, the arrow on the thread's free end; every
// other number is typed in the Options panel, so each must be `inOptions`
// or its row never shows.
const THREAD_VALUES: readonly ValueSpec[] = [
  {
    id: 'majorDiameter',
    label: 'Diameter',
    unit: 'length',
    initial: 6,
    min: 0,
    exclusive: true,
    inOptions: true,
    note: 'Major diameter: a bolt’s crest, a nut’s root',
    when: customSize
  },
  {
    id: 'pitch',
    label: 'Pitch',
    unit: 'length',
    initial: 1,
    min: 0,
    exclusive: true,
    inOptions: true,
    note: 'Axial distance between threads',
    when: (state) => customSize(state) || custom(state)
  },
  {
    id: 'depth',
    label: 'Depth',
    unit: 'length',
    initial: 0.5,
    min: 0,
    exclusive: true,
    inOptions: true,
    note: 'Crest to root',
    when: custom
  },
  {
    id: 'crestWidth',
    label: 'Crest',
    unit: 'length',
    initial: 0.25,
    min: 0,
    inOptions: true,
    note: 'Flat width on each crest',
    when: custom
  },
  {
    id: 'lowerFlankAngleDeg',
    label: 'Lower flank',
    unit: 'angle',
    initial: 45,
    min: 0,
    max: 75,
    inOptions: true,
    note: 'From the plane across the axis; over 45° overhangs when printed upright',
    when: custom
  },
  {
    id: 'upperFlankAngleDeg',
    label: 'Upper flank',
    unit: 'angle',
    initial: 45,
    min: 0,
    max: 75,
    inOptions: true,
    note: 'Facing the face’s far end; 0° is square',
    when: custom
  },
  {
    id: 'clearance',
    label: 'Gap',
    unit: 'length',
    initial: 0.1,
    min: 0,
    inOptions: true,
    note: 'Radial gap to the mating part: a boss shrinks, a bore grows',
    when: (state) => fitOption(state.options) === 'custom'
  },
  {
    id: 'length',
    label: 'Length',
    unit: 'length',
    initial: 5,
    min: 0,
    exclusive: true,
    note: 'Drag the arrow short of the face’s end for a partial thread'
  },
  {
    id: 'offset',
    label: 'Offset',
    unit: 'length',
    initial: 0,
    min: 0,
    note: 'Gap before the thread, from the end it starts at',
    inOptions: true
  },
  {
    id: 'starts',
    label: 'Starts',
    unit: 'count',
    initial: 1,
    min: 1,
    max: 16,
    integer: true,
    inOptions: true,
    note: 'Parallel threads'
  },
  {
    id: 'phaseDeg',
    label: 'Rotation',
    unit: 'angle',
    initial: 0,
    inOptions: true,
    note: 'Where the thread starts around the axis'
  },
  {
    id: 'chamferAngleDeg',
    label: 'End angle',
    unit: 'angle',
    initial: 45,
    min: 0,
    max: 90,
    exclusive: true,
    inOptions: true,
    note: 'Chamfer or runout cone, from the axis',
    when: (state) => chamfered(state)
  }
];

const THREAD_OPTIONS: readonly OptionSpec[] = [
  {
    id: 'profile',
    label: 'Profile',
    choices: [
      {
        value: 'printable',
        label: 'Printable',
        tip: '45° flanks with flat crests: prints upright without support. Mates with other printable threads.'
      },
      {
        value: 'iso-metric',
        label: 'ISO',
        tip: 'ISO metric 60°: mates with standard bolts and nuts'
      },
      {
        value: 'custom',
        label: 'Custom',
        tip: 'Set the pitch, depth, crest and flanks'
      },
      {
        value: 'npt',
        label: 'NPT',
        tip: 'Tapered pipe thread, 60°, 1 in 16 (ASME B1.20.1). Starts at the fitting end: small on a boss, large in a bore.'
      },
      {
        value: 'bspt',
        label: 'BSPT',
        tip: 'Tapered pipe thread, 55°, 1 in 16: R on a boss, Rc in a bore (ISO 7-1). Rounded crests and roots are approximated by flats.'
      }
    ],
    initial: 'printable'
  },
  {
    id: 'size',
    label: 'Size',
    choices: [
      {
        value: 'auto',
        label: 'Auto',
        tip: 'From the face: a boss keeps its diameter, a bore takes the size it is the tap drill for'
      },
      ...ISO_SIZES.map(({ value, size }) => ({
        value,
        label: isoMetricThreadLabel(size.nominal, size.pitch)
      })),
      { value: 'custom', label: 'Custom' }
    ],
    initial: 'auto',
    when: (state) => !pipe(state)
  },
  {
    id: 'pipeSize',
    label: 'Size',
    choices: [
      {
        value: 'auto',
        label: 'Auto',
        tip: 'From the face: a boss takes the size of its pipe, a bore the size its diameter is drilled for'
      },
      ...PIPE_THREAD_SIZES.map((size) => ({ value: size, label: `${size}″` }))
    ],
    initial: 'auto',
    when: pipe
  },
  {
    id: 'fit',
    label: 'Fit',
    choices: [
      {
        value: 'print',
        label: 'Print',
        tip: '0.1 mm radial gap: printed parts turn freely'
      },
      {
        value: 'loose',
        label: 'Loose',
        tip: '0.2 mm radial gap: for coarse layers or elephant’s foot'
      },
      {
        value: 'exact',
        label: 'Exact',
        tip: 'No gap: nominal size, for machined parts or drawings'
      },
      { value: 'custom', label: 'Custom' }
    ],
    initial: 'print',
    when: (state) => !pipe(state)
  },
  {
    // A pipe thread mates with standard fittings, so it starts exact.
    id: 'pipeFit',
    label: 'Fit',
    choices: [
      {
        value: 'exact',
        label: 'Exact',
        tip: 'No gap: the standard size, to mate with metal fittings'
      },
      {
        value: 'print',
        label: 'Print',
        tip: '0.1 mm radial gap: printed parts turn freely'
      },
      {
        value: 'loose',
        label: 'Loose',
        tip: '0.2 mm radial gap: for coarse layers or elephant’s foot'
      },
      { value: 'custom', label: 'Custom' }
    ],
    initial: 'exact',
    when: pipe
  },
  {
    id: 'chamfer',
    label: 'Ends',
    // Chamfered at an end the thread runs to, run out where it stops short
    // (see `threadEndFinishes`).
    choices: [
      {
        value: 'both',
        label: 'Both',
        tip: 'Finish both ends: a chamfer where the thread reaches the face’s end, a runout where it stops short. No thin wedge to print, and mating parts start easily'
      },
      { value: 'start', label: 'Start' },
      { value: 'end', label: 'End' },
      { value: 'none', label: 'None' }
    ],
    initial: 'both'
  },
  {
    id: 'hand',
    label: 'Hand',
    choices: [
      { value: 'right', label: 'Right' },
      { value: 'left', label: 'Left' }
    ],
    initial: 'right'
  }
];

/** The radial clearance a fit choice stands for, in document units. */
function fitClearance(fit: string | undefined, units: UnitSystem): number {
  const mm =
    fit === 'loose'
      ? FIT_CLEARANCE_MM.loose
      : fit === 'exact'
        ? FIT_CLEARANCE_MM.exact
        : FIT_CLEARANCE_MM.print;
  return mm / millimetresPerUnit(units);
}

/**
 * The Options readout: what the picked face and the dragged end decide (the
 * size the face gives, how much of it is threaded), then what the folded
 * More rows come to where they leave their defaults.
 */
export function threadSummary(
  state: InPlacePanelState,
  units: UnitSystem = 'mm',
  slots?: Pick<InPlaceSlots, 'faces'>,
  context?: InPlaceValueContext
): string | null {
  const parts: string[] = [];
  const geometry = threadFace(slots?.faces[0]);
  const round = (value: number) => Math.round(value * 1000) / 1000;
  // Without a face, every end asked for counts as finished.
  let anyChamfer = chamfered(state);
  const standard = pipeStandard(state.options.profile);
  if (geometry) {
    if (standard) {
      const kind = threadFaceKnownKind(slots?.faces[0]);
      const spec = pipeSpecFor(
        standard,
        state.options.pipeSize,
        slots?.faces[0],
        units
      );
      if (!isPipeThreadSize(state.options.pipeSize)) {
        // Boss or bore decides the size; where the pick cannot say, the
        // build does.
        parts.push(
          spec && kind
            ? `${pipeThreadLabel(standard, spec.size, kind)} from the Ø${round(2 * geometry.radius)} ${units} face`
            : `Sized from the Ø${round(2 * geometry.radius)} ${units} face`
        );
      }
    } else if ((state.options.size ?? 'auto') === 'auto') {
      parts.push(`Sized from the Ø${round(2 * geometry.radius)} ${units} face`);
    }
    const offset = state.numbers.offset ?? 0;
    const reach = geometry.length - offset;
    const length = state.numbers.length ?? reach;
    const face = round(geometry.length);
    // A length held as given (an expression, a stored one) is stored as
    // written; what it reads as, and which ends chamfer, is where it
    // reaches.
    // A pipe thread always holds its length: its standard's, or dragged.
    const held =
      standard !== null ||
      lengthIsExplicit(
        geometry,
        { ...state.numbers, ...state.raws },
        state.numbers,
        context ?? { touched: ['length'] }
      );
    const reached = threadReach({ held, offset, length, face: geometry });
    const from = threadAnchor(
      slots?.faces[0],
      context?.saved ? { saved: context.saved } : undefined
    );
    const ends = threadEndFinishes(state.options.chamfer, from, reached);
    anyChamfer = ends.start !== undefined || ends.end !== undefined;
    const stop = ends[from === 'start' ? 'end' : 'start'];
    parts.push(
      !reached.far
        ? `Threads ${round(length)} of ${face} ${units}, ${
            stop === 'runout'
              ? 'runs out where it stops'
              : anyChamfer
                ? 'plain where it stops'
                : 'ends plain'
          }`
        : offset > 0
          ? `To end · Threads ${round(reach)} of ${face} ${units}`
          : `Threads the full ${face} ${units}`
    );
  }
  if (state.options.hand === 'left') parts.push('Left hand');
  const starts = Math.round(state.numbers.starts ?? 1);
  if (starts > 1) parts.push(`${starts} starts`);
  const phase = Math.round((state.numbers.phaseDeg ?? 0) * 100) / 100;
  if (phase !== 0) parts.push(`Rotated ${phase}°`);
  if (anyChamfer) {
    const angle = Math.round((state.numbers.chamferAngleDeg ?? 45) * 100) / 100;
    if (angle !== 45) parts.push(`Ends ${angle}°`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The Options a stored thread reads back as: an ISO size whose stored
 * diameter and pitch are that size's, a fit whose clearance is one of the
 * presets.
 */
export function threadEditOptions(
  data: ThreadRequest,
  evaluate: (value: ParamValue) => number | null,
  units: UnitSystem
): Record<string, string> {
  const mm = millimetresPerUnit(units);
  const number = (value: ParamValue | undefined) =>
    value === undefined ? null : evaluate(value);
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  const options: Record<string, string> = { profile: data.profile };
  const major = number(data.majorDiameter);
  const pitch = number(data.pitch);
  const standard = pipeStandard(data.profile);
  if (standard) {
    options.pipeSize = data.pipeSize ?? 'auto';
  } else if (data.majorDiameter === undefined) {
    options.size = 'auto';
  } else {
    const iso = ISO_SIZES.find(
      ({ size }) =>
        major !== null &&
        pitch !== null &&
        close(major * mm, size.nominal) &&
        close(pitch * mm, size.pitch)
    );
    options.size = iso?.value ?? 'custom';
  }
  const clearance = number(data.clearance) ?? 0;
  const preset = (['exact', 'print', 'loose'] as const).find((fit) =>
    close(clearance, fitClearance(fit, units))
  );
  options[standard ? 'pipeFit' : 'fit'] =
    data.clearance !== undefined && typeof data.clearance !== 'number'
      ? 'custom'
      : (preset ?? 'custom');
  // Its extent and end are not options: the stored length and anchor go
  // back as values and the face's end (see `threadIsPartial`).
  options.hand = data.hand ?? 'right';
  // A runout (schema v57) is the finish of an end that stops short.
  const start = data.chamferStart || data.runoutStart;
  const end = data.chamferEnd || data.runoutEnd;
  options.chamfer =
    start && end ? 'both' : start ? 'start' : end ? 'end' : 'none';
  return options;
}

/**
 * How much of the face a thread runs and from where, as the picks and the
 * dragged end decide (see {@link threadIsPartial}, {@link threadAnchor}).
 */
export interface ThreadExtent {
  /** It stops short of the face's far end: it stores its length. */
  partial?: boolean;
  /** The end of the face it starts at; absent is the start. */
  from?: ThreadAnchor;
  /**
   * The edited thread's stored `anchor`: written back as stored while the
   * thread still starts there, so an untouched edit keeps a stored `'start'`
   * and a legacy thread without one keeps the field absent.
   */
  storedAnchor?: ThreadAnchor;
  /** The offset as a number, where it resolves. */
  offset?: number;
  /** The length as a number, where it resolves. */
  length?: number;
  /** The face's length and radius, where it published a cylinder. */
  face?: Pick<ThreadFace, 'length' | 'radius'>;
}

/** The feature fields an in-place thread command stores. */
export function threadRequestFields(
  values: Readonly<Record<string, ParamValue>>,
  options: Readonly<Record<string, string>>,
  units: UnitSystem,
  extent: ThreadExtent = {}
): Omit<ThreadRequest, 'targetBodyId' | 'faceHash' | 'faceReference'> {
  const standard = pipeStandard(options.profile);
  const profile: ThreadProfile =
    standard ??
    (options.profile === 'iso-metric' || options.profile === 'custom'
      ? options.profile
      : 'printable');
  const fields: Omit<
    ThreadRequest,
    'targetBodyId' | 'faceHash' | 'faceReference'
  > = { profile };
  const iso = standard ? null : isoSize(options.size);
  const mm = millimetresPerUnit(units);
  if (standard) {
    // The pipe size sets the diameter and pitch; Auto leaves it to the face.
    if (isPipeThreadSize(options.pipeSize)) fields.pipeSize = options.pipeSize;
  } else if (iso) {
    fields.majorDiameter = iso.nominal / mm;
    fields.pitch = iso.pitch / mm;
  } else if (options.size === 'custom') {
    fields.majorDiameter = values.majorDiameter ?? 6 / mm;
    fields.pitch = values.pitch ?? 1 / mm;
  }
  if (profile === 'custom') {
    // A custom form needs its pitch even where the face sizes the diameter.
    fields.pitch ??= values.pitch ?? 1 / mm;
    fields.depth = values.depth ?? 0.5 / mm;
    fields.crestWidth = values.crestWidth ?? 0.25 / mm;
    fields.upperFlankAngleDeg = values.upperFlankAngleDeg ?? 45;
    fields.lowerFlankAngleDeg = values.lowerFlankAngleDeg ?? 45;
  }
  const fit = standard ? (options.pipeFit ?? 'exact') : options.fit;
  const clearance =
    fit === 'custom' ? (values.clearance ?? 0) : fitClearance(fit, units);
  if (clearance !== 0) fields.clearance = clearance;
  const starts = values.starts;
  if (starts !== undefined && starts !== 1) fields.starts = starts;
  if (options.hand === 'left') fields.hand = 'left';
  // A pipe thread stores its length: the standard's until it is dragged.
  const partial = extent.partial === true || standard !== null;
  if (partial) fields.length = values.length ?? 5 / mm;
  const offset = values.offset;
  const offsetStored = offset !== undefined && offset !== 0;
  if (offsetStored) fields.offset = offset;
  const from = extent.from ?? 'start';
  // The end it starts at is stored whenever it is the far one, a whole-face
  // thread's included: reopened, its arrow and any shortening start there.
  if (extent.storedAnchor !== undefined && extent.storedAnchor === from) {
    fields.anchor = from;
  } else if (from === 'end') {
    fields.anchor = 'end';
  }
  const phase = values.phaseDeg;
  if (phase !== undefined && phase !== 0) fields.phaseDeg = phase;
  // A chamfered end must reach the end of the face. Where the span reaches
  // is not how its length is stored: a held length (an expression, a
  // stored one) that reaches the far end keeps its chamfer there.
  const ends = threadEndFinishes(
    options.chamfer,
    from,
    threadReach({
      held: partial,
      // An offset left out is none; one that does not resolve is unknown.
      offset: offsetStored ? extent.offset : 0,
      length: extent.length,
      face: extent.face ?? null
    })
  );
  if (ends.start === 'chamfer') fields.chamferStart = true;
  if (ends.end === 'chamfer') fields.chamferEnd = true;
  if (ends.start === 'runout') fields.runoutStart = true;
  if (ends.end === 'runout') fields.runoutEnd = true;
  if (ends.start || ends.end) {
    const angle = values.chamferAngleDeg;
    if (angle !== undefined && angle !== 45) fields.chamferAngleDeg = angle;
  }
  return fields;
}

/**
 * The kind each finished end takes, a chamfer or (schema v57) a runout,
 * settled by the rule the build checks it by (`threadSpanOnFace`: the same
 * evaluated offset and length, the same arithmetic and the same snap),
 * never by comparing the edit with what it started from.
 *
 * - A runout the edited feature stores stays a runout (the kernel builds
 *   one at any end, a shoulder at the end of the face included, which the
 *   one Ends row could not otherwise express), unless the edit carries an
 *   end that stopped short of the face onto its end: then it is chamfered.
 * - Every other finished end is a chamfer where the span reaches that end
 *   of the face and a runout where it stops short, so a chamfer the build
 *   would refuse is never written.
 * - Where the span does not resolve (an expression with no value, a pipe
 *   thread left to its standard length), the panel's own reach stands.
 */
export function keepStoredEndKinds(
  thread: ThreadRequest,
  saved: FeatureData | undefined,
  face: Pick<ThreadFace, 'length' | 'radius'> | null,
  evaluate: ((value: ParamValue) => number | null) | undefined,
  /**
   * Boss or bore and the document's unit, which a pipe thread left to its
   * standard length is resolved by; without a known side it is not.
   */
  pipe?: { kind: 'external' | 'internal' | null; units: UnitSystem }
): ThreadRequest {
  const number = (value: ParamValue | undefined) =>
    value === undefined
      ? undefined
      : typeof value === 'number'
        ? value
        : (evaluate?.(value) ?? null);
  /** A thread's span as the build places it, or null where it cannot. */
  const spanOf = (data: ThreadRequest) => {
    const offset = number(data.offset) ?? 0;
    const typed = number(data.length);
    const standard = pipeStandard(data.profile);
    // An absent length is the rest of the face from the offset, as the
    // build reads it; a pipe thread's is its standard's, resolved as the
    // build resolves it.
    const clearance = number(data.clearance) ?? 0;
    const implicit = (): number | null => {
      if (!face || offset === null) return null;
      if (!standard) return face.length - offset;
      if (!pipe?.kind || clearance === null) return null;
      const { end } = pipeThreadOnFace({
        standard,
        size: data.pipeSize,
        kind: pipe.kind,
        radius: face.radius,
        faceLength: face.length,
        clearance,
        mm: millimetresPerUnit(pipe.units)
      });
      // One the offset leaves no length is refused by the build.
      return end - offset > 1e-9 * Math.max(end, 1) ? end - offset : null;
    };
    const length = typed === undefined ? implicit() : typed;
    return face &&
      offset !== null &&
      Number.isFinite(offset) &&
      length !== null &&
      Number.isFinite(length)
      ? threadSpanOnFace({
          offset,
          length,
          anchor: data.anchor ?? 'start',
          faceLength: face.length,
          radius: face.radius
        })
      : null;
  };
  const span = spanOf(thread);
  const stored = saved?.featureKind === 'thread' ? saved : undefined;
  const before = stored ? spanOf(stored) : null;
  const reaches = (on: typeof span, end: 'start' | 'end') =>
    on ? (end === 'start' ? on.reachesStart : on.reachesEnd) : null;
  const next: ThreadRequest = { ...thread };
  const keys = {
    start: { chamfer: 'chamferStart', runout: 'runoutStart' },
    end: { chamfer: 'chamferEnd', runout: 'runoutEnd' }
  } as const;
  for (const end of ['start', 'end'] as const) {
    const { chamfer, runout } = keys[end];
    if (!(next[chamfer] || next[runout])) continue;
    const now = reaches(span, end);
    // A stored runout stays one, unless the edit carries an end that
    // stopped short onto the face's end: then it is chamfered there.
    const kind = stored?.[runout]
      ? reaches(before, end) === false && now === true
        ? chamfer
        : runout
      : now === null
        ? next[chamfer]
          ? chamfer
          : runout
        : now
          ? chamfer
          : runout;
    delete next[chamfer];
    delete next[runout];
    next[kind] = true;
  }
  return next;
}

/**
 * An extent along a picked cylindrical face from one of its ends, `lengthId`
 * long after an `offset`: a thread's, or gear teeth's over part of a face
 * (schema v55). Until its end is dragged or typed short it runs the rest of
 * the face. `runs` begins the refusal for a length past the far end.
 */
export function faceSpan(lengthId: SpanLengthId, runs: string) {
  const explicit = (
    geometry: ThreadFace | null,
    values: Readonly<Record<string, number>>,
    context: InPlaceValueContext | undefined
  ) =>
    lengthIsExplicit(
      geometry,
      heldValues(values, context),
      values,
      context ?? {},
      lengthId
    );
  const behaviour: Pick<
    InPlaceToolSpec,
    'refuseValue' | 'carries' | 'defaults'
  > = {
    refuseValue(valueId, value, values, slots, context) {
      // A typed length or offset that would carry the span past the face's
      // far end is refused: only a length that reaches the end exactly runs
      // the whole face, and an offset never quietly shortens a length set.
      const geometry = threadFace(slots?.faces[0]);
      if (!geometry) return null;
      const round = (number: number) => Math.round(number * 1e6) / 1e6;
      const slack = tolerance(geometry.length);
      if (valueId === lengthId) {
        const reach = geometry.length - Math.max(values.offset ?? 0, 0);
        return value > reach + slack
          ? `${runs} at most ${round(reach)}, to the face's far end.`
          : null;
      }
      if (valueId === 'offset') {
        if (value >= geometry.length - slack) {
          return `the face is only ${round(geometry.length)} long.`;
        }
        // A length held as given (set short, stored by an edit, or an
        // expression) is never quietly shortened by a larger offset.
        const length = values[lengthId];
        if (
          length !== undefined &&
          explicit(geometry, values, context) &&
          value + length > geometry.length + slack
        ) {
          const most = round(Math.max(geometry.length - length, 0));
          const raw = context?.raws?.[lengthId];
          return raw !== undefined
            ? `the length is ${raw} (${round(length)}), so the offset can be at most ${most}; change the length too.`
            : `with the length at ${round(length)}, the offset can be at most ${most}.`;
        }
      }
      return null;
    },
    carries(valueId, value, values, slots, context) {
      // A span that runs to the far end keeps running there as its offset
      // moves: its length follows, as an untouched one does by default. A
      // length held as given stays as it is (an offset that would overshoot
      // it is refused instead).
      if (valueId !== 'offset') return null;
      const geometry = threadFace(slots.faces[0]);
      if (!geometry || explicit(geometry, values, context)) return null;
      return {
        [lengthId]: Math.max(geometry.length - Math.max(value, 0), 0)
      };
    },
    defaults(slots, _ctx, numbers): Record<string, number> {
      // Until its end is dragged, the span runs the rest of the face.
      const geometry = threadFace(slots.faces[0]);
      if (!geometry) return {};
      return {
        [lengthId]: Math.max(geometry.length - (numbers.offset ?? 0), 0)
      };
    }
  };
  return {
    behaviour,
    /** How much of the face the span runs, and from which end. */
    extent(
      face: FacePick,
      values: Readonly<Record<string, ParamValue>>,
      ctx: InPlaceContext,
      numbers?: Readonly<Record<string, number>>
    ): ThreadExtent {
      const resolved = (id: string) => {
        const number = numbers?.[id];
        if (number !== undefined) return number;
        const value = values[id];
        return typeof value === 'number'
          ? value
          : value === undefined
            ? undefined
            : (ctx.evaluate?.(value) ?? undefined);
      };
      const all: Record<string, number> = {};
      for (const id of [lengthId, 'offset']) {
        const number = resolved(id);
        if (number !== undefined) all[id] = number;
      }
      const storedAnchor = savedSpan(ctx.saved)?.anchor;
      const geometry = threadFace(face);
      return {
        partial: threadIsPartial(face, values, all, ctx, lengthId),
        from: threadAnchor(face, ctx),
        ...(storedAnchor === undefined ? {} : { storedAnchor }),
        ...(all.offset === undefined ? {} : { offset: all.offset }),
        ...(all[lengthId] === undefined ? {} : { length: all[lengthId] }),
        ...(geometry
          ? { face: { length: geometry.length, radius: geometry.radius } }
          : {})
      };
    },
    /**
     * One arrow on the span's free end, sliding along the face from the end
     * it starts at: drag it short of the far end to stop the span there.
     */
    arrow(
      face: FacePick | undefined,
      values: Record<string, number>,
      ctx: InPlaceContext,
      key: string
    ): HandleSpec[] {
      if (!face) return [];
      const geometry = threadFace(face);
      if (!geometry) {
        // No cylinder to stand an arrow on: a stored partial span's length
        // is still a chip on the face.
        const anchor = face.point ?? face.centroid ?? face.center;
        return anchor && savedSpan(ctx.saved)?.length !== undefined
          ? [
              {
                valueId: lengthId,
                kind: 'chip',
                key: `${key}:${face.bodyId}:${face.hash}:${lengthId}`,
                params: { anchor }
              }
            ]
          : [];
      }
      const from = threadAnchor(face, ctx);
      const direction =
        from === 'end'
          ? { x: -geometry.axis.x, y: -geometry.axis.y, z: -geometry.axis.z }
          : geometry.axis;
      const offset = Math.max(values.offset ?? 0, 0);
      const reach = Math.max(geometry.length - offset, 0);
      const base = from === 'end' ? geometry.end : geometry.start;
      const origin = along(
        along(base, direction, offset),
        geometry.radial,
        geometry.radius
      );
      const round = (value: number) => Math.round(value * 1e6) / 1e6;
      return [
        {
          valueId: lengthId,
          kind: 'linear',
          key: [
            key,
            face.bodyId,
            face.hash,
            lengthId,
            from,
            round(offset),
            round(geometry.length),
            round(geometry.radial.x),
            round(geometry.radial.y),
            round(geometry.radial.z)
          ].join(':'),
          params: { origin, direction },
          max: reach
        }
      ];
    }
  };
}

const threadSpan = faceSpan('length', 'a thread here runs');

/**
 * Schema v57: the length a pipe thread takes at `offset` until it is
 * dragged, or null for any other profile (or a face with no cylinder).
 */
function pipeDefault(
  options: Readonly<Record<string, string>>,
  face: FacePick | undefined,
  units: UnitSystem,
  numbers: Readonly<Record<string, number>>,
  offset: number
): number | null {
  const standard = pipeStandard(options.profile);
  if (!standard) return null;
  const fit = options.pipeFit ?? 'exact';
  return pipeThreadDefaultLength(
    standard,
    options.pipeSize,
    face,
    units,
    fit === 'custom' ? (numbers.clearance ?? 0) : fitClearance(fit, units),
    offset
  );
}

export const threadSpec: InPlaceToolSpec = {
  id: 'thread',
  title: 'Thread',
  profileMode: 'none',
  faceMode: 'one',
  faceFilter: 'cylindrical',
  wantsAxis: false,
  wantsPath: false,
  values: THREAD_VALUES,
  options: THREAD_OPTIONS,
  // Compact: numbers pair up two to a row, so each pair is listed together.
  layout: [
    {
      label: 'Thread',
      compact: true,
      boxed: true,
      items: [
        'profile',
        'size',
        'pipeSize',
        'majorDiameter',
        'pitch',
        'fit',
        'pipeFit',
        'clearance'
      ]
    },
    {
      label: 'Length',
      compact: true,
      boxed: true,
      items: ['length', 'offset', 'chamfer']
    },
    {
      label: 'Form',
      compact: true,
      boxed: true,
      items: ['depth', 'crestWidth', 'lowerFlankAngleDeg', 'upperFlankAngleDeg']
    },
    {
      label: 'More',
      collapsed: true,
      compact: true,
      items: ['hand', 'starts', 'phaseDeg', 'chamferAngleDeg']
    }
  ],
  summary: threadSummary,
  ...threadSpan.behaviour,
  defaults(slots, ctx, numbers, options = {}) {
    const span = threadSpan.behaviour.defaults!(slots, ctx, numbers);
    // Schema v57: a pipe thread runs its standard's length until dragged.
    const length = pipeDefault(
      options,
      slots.faces[0],
      ctx.units ?? 'mm',
      numbers,
      numbers.offset ?? 0
    );
    return length === null ? span : { ...span, length };
  },
  carries(valueId, value, values, slots, context) {
    // An untouched pipe thread's length follows its offset by the pipe rule,
    // not to the face's far end: the band keeps ending where the standard's
    // thread (or the taper's reach) ends. Untouched means the user never set
    // it (an edit's stored length counts as set), whatever its value: a
    // length typed to the face's end is theirs, and follows the face's end
    // as any span's does (review #1458).
    const length =
      valueId === 'offset' && !context?.touched?.includes('length')
        ? pipeDefault(
            context?.options ?? {},
            slots.faces[0],
            context?.units ?? 'mm',
            values,
            value
          )
        : null;
    return length === null
      ? (threadSpan.behaviour.carries?.(
          valueId,
          value,
          values,
          slots,
          context
        ) ?? null)
      : { length };
  },
  hint(slots: InPlaceSlots) {
    const face = slots.faces[0];
    if (!face) {
      return 'Pick a cylindrical face or hole, near the end the thread starts at';
    }
    return threadFace(face)
      ? 'Drag the arrow to stop the thread short · Enter to finish'
      : 'Enter to finish';
  },
  ready: (slots: InPlaceSlots) => slots.faces.length > 0,
  request(
    slots: InPlaceSlots,
    values: Record<string, ParamValue>,
    options: Record<string, string>,
    ctx: InPlaceContext,
    numbers?: Record<string, number>
  ): InPlaceRequest | null {
    const face = slots.faces[0];
    if (!face) return null;
    return {
      tool: 'thread',
      thread: keepStoredEndKinds(
        {
          targetBodyId: face.bodyId,
          faceHash: face.hash,
          ...(face.reference ? { faceReference: face.reference } : {}),
          ...threadRequestFields(
            values,
            options,
            ctx.units ?? 'mm',
            threadSpan.extent(face, values, ctx, numbers)
          )
        },
        ctx.saved,
        threadFace(face),
        ctx.evaluate,
        { kind: threadFaceKnownKind(face), units: ctx.units ?? 'mm' }
      )
    };
  },
  handles(
    slots: InPlaceSlots,
    values: Record<string, number>,
    ctx: InPlaceContext
  ): HandleSpec[] {
    return threadSpan.arrow(slots.faces[0], values, ctx, 'thread');
  }
};
