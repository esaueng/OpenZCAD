import {
  ISO_METRIC_COARSE_THREADS,
  UNIT_TO_MM,
  isoMetricThreadLabel,
  type FeatureData,
  type ParamValue,
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

const custom = (state: InPlacePanelState) => state.options.profile === 'custom';
const customSize = (state: InPlacePanelState) =>
  state.options.size === 'custom';
const chamfered = (state: InPlacePanelState) =>
  (state.options.chamfer ?? 'both') !== 'none';

/**
 * Whether a thread's two ends stand on the ends of its face: `near` the one
 * it starts at, `far` the other. This is where the span reaches, not how
 * its length is stored: a length held as given (an expression, a stored
 * one) can reach the far end all the same.
 */
export interface ThreadReach {
  near: boolean;
  far: boolean;
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
  return {
    near: offset !== undefined && Math.abs(offset) <= snap,
    far:
      !held ||
      (face !== null &&
        offset !== undefined &&
        length !== undefined &&
        offset + length >= face.length - snap)
  };
}

/**
 * The ends of the face that take their chamfer. A chamfer's cone is built
 * into an end standing on the face's end plane, so only an end the thread
 * reaches takes one: a thread that stops short keeps the one where it
 * starts and stops plain, and one set off from its starting end is plain
 * there.
 */
export function threadChamferedEnds(
  chamfer: string | undefined,
  from: ThreadAnchor,
  reach: ThreadReach
): { start: boolean; end: boolean } {
  const wanted = chamfer ?? 'both';
  const reached = (end: ThreadAnchor) =>
    from === end ? reach.near : reach.far;
  return {
    start: (wanted === 'both' || wanted === 'start') && reached('start'),
    end: (wanted === 'both' || wanted === 'end') && reached('end')
  };
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
    length,
    radius: cylinder.radius,
    radial
  };
}

/** The stored thread being edited, if this command edits one. */
function savedThread(ctx: Pick<InPlaceContext, 'saved'> | undefined) {
  return ctx?.saved?.featureKind === 'thread' ? ctx.saved : null;
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
  return savedThread(ctx)?.anchor ?? 'start';
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
  ctx?: InPlaceContext
): boolean {
  return lengthIsExplicit(threadFace(face), values, numbers, {
    ...(ctx?.touched ? { touched: ctx.touched } : {}),
    ...(ctx?.saved ? { saved: ctx.saved } : {})
  });
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
  context: Pick<InPlaceValueContext, 'touched' | 'saved'>
): boolean {
  const saved = context.saved?.featureKind === 'thread' ? context.saved : null;
  if (saved?.length !== undefined && held.length === saved.length) {
    return true;
  }
  if (!context.touched?.includes('length')) return false;
  if (typeof held.length === 'string') return true;
  if (!geometry) return true;
  const reach = geometry.length - Math.max(numbers.offset ?? 0, 0);
  return (numbers.length ?? reach) < reach - tolerance(geometry.length);
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
    when: (state) => state.options.fit === 'custom'
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
    label: 'Chamfer angle',
    unit: 'angle',
    initial: 45,
    min: 0,
    max: 90,
    exclusive: true,
    inOptions: true,
    note: 'Cone angle from the axis',
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
    initial: 'auto'
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
    initial: 'print'
  },
  {
    id: 'chamfer',
    label: 'Chamfer',
    // Kept only at an end the thread runs to: one that stops short keeps
    // the one where it starts (see `threadChamferedEnds`).
    choices: [
      {
        value: 'both',
        label: 'Both',
        tip: 'Taper both ends: no thin wedge to print, and mating parts start easily'
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
  return mm / UNIT_TO_MM[units];
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
  // Without a face, every end asked for counts as chamfered.
  let anyChamfer = chamfered(state);
  if (geometry) {
    if ((state.options.size ?? 'auto') === 'auto') {
      parts.push(`Sized from the Ø${round(2 * geometry.radius)} ${units} face`);
    }
    const offset = state.numbers.offset ?? 0;
    const reach = geometry.length - offset;
    const length = state.numbers.length ?? reach;
    const face = round(geometry.length);
    // A length held as given (an expression, a stored one) is stored as
    // written; what it reads as, and which ends chamfer, is where it
    // reaches.
    const held = lengthIsExplicit(
      geometry,
      { ...state.numbers, ...state.raws },
      state.numbers,
      context ?? { touched: ['length'] }
    );
    const reached = threadReach({ held, offset, length, face: geometry });
    const ends = threadChamferedEnds(
      state.options.chamfer,
      threadAnchor(
        slots?.faces[0],
        context?.saved ? { saved: context.saved } : undefined
      ),
      reached
    );
    anyChamfer = ends.start || ends.end;
    parts.push(
      !reached.far
        ? `Threads ${round(length)} of ${face} ${units}, ${
            anyChamfer ? 'plain where it stops' : 'ends plain'
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
    if (angle !== 45) parts.push(`Chamfer ${angle}°`);
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
  const mm = UNIT_TO_MM[units];
  const number = (value: ParamValue | undefined) =>
    value === undefined ? null : evaluate(value);
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  const options: Record<string, string> = { profile: data.profile };
  const major = number(data.majorDiameter);
  const pitch = number(data.pitch);
  if (data.majorDiameter === undefined) {
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
  options.fit =
    data.clearance !== undefined && typeof data.clearance !== 'number'
      ? 'custom'
      : (preset ?? 'custom');
  // Its extent and end are not options: the stored length and anchor go
  // back as values and the face's end (see `threadIsPartial`).
  options.hand = data.hand ?? 'right';
  options.chamfer =
    data.chamferStart && data.chamferEnd
      ? 'both'
      : data.chamferStart
        ? 'start'
        : data.chamferEnd
          ? 'end'
          : 'none';
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
  const profile: ThreadProfile =
    options.profile === 'iso-metric' || options.profile === 'custom'
      ? options.profile
      : 'printable';
  const fields: Omit<
    ThreadRequest,
    'targetBodyId' | 'faceHash' | 'faceReference'
  > = { profile };
  const iso = isoSize(options.size);
  const mm = UNIT_TO_MM[units];
  if (iso) {
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
  const clearance =
    options.fit === 'custom'
      ? (values.clearance ?? 0)
      : fitClearance(options.fit, units);
  if (clearance !== 0) fields.clearance = clearance;
  const starts = values.starts;
  if (starts !== undefined && starts !== 1) fields.starts = starts;
  if (options.hand === 'left') fields.hand = 'left';
  const partial = extent.partial === true;
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
  const ends = threadChamferedEnds(
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
  if (ends.start) fields.chamferStart = true;
  if (ends.end) fields.chamferEnd = true;
  if (fields.chamferStart || fields.chamferEnd) {
    const angle = values.chamferAngleDeg;
    if (angle !== undefined && angle !== 45) fields.chamferAngleDeg = angle;
  }
  return fields;
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
      items: ['profile', 'size', 'majorDiameter', 'pitch', 'fit', 'clearance']
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
  refuseValue(valueId, value, values, slots, context) {
    // A typed length or offset that would carry the thread past the face's
    // far end is refused: only a length that reaches the end exactly runs
    // the whole face, and an offset never quietly shortens a length set.
    const geometry = threadFace(slots?.faces[0]);
    if (!geometry) return null;
    const round = (number: number) => Math.round(number * 1e6) / 1e6;
    const slack = tolerance(geometry.length);
    if (valueId === 'length') {
      const reach = geometry.length - Math.max(values.offset ?? 0, 0);
      return value > reach + slack
        ? `a thread here runs at most ${round(reach)}, to the face's far end.`
        : null;
    }
    if (valueId === 'offset') {
      if (value >= geometry.length - slack) {
        return `the face is only ${round(geometry.length)} long.`;
      }
      // A length held as given (set short, stored by an edit, or an
      // expression) is never quietly shortened by a larger offset.
      const length = values.length;
      if (
        length !== undefined &&
        lengthIsExplicit(
          geometry,
          heldValues(values, context),
          values,
          context ?? {}
        ) &&
        value + length > geometry.length + slack
      ) {
        const most = round(Math.max(geometry.length - length, 0));
        const raw = context?.raws?.length;
        return raw !== undefined
          ? `the length is ${raw} (${round(length)}), so the offset can be at most ${most}; change the length too.`
          : `with the length at ${round(length)}, the offset can be at most ${most}.`;
      }
    }
    return null;
  },
  carries(valueId, value, values, slots, context) {
    // A thread that runs to the far end keeps running there as its offset
    // moves: its length follows, as an untouched one does by default. A
    // length held as given stays as it is (an offset that would overshoot
    // it is refused instead).
    if (valueId !== 'offset') return null;
    const geometry = threadFace(slots.faces[0]);
    if (
      !geometry ||
      lengthIsExplicit(
        geometry,
        heldValues(values, context),
        values,
        context ?? {}
      )
    ) {
      return null;
    }
    return { length: Math.max(geometry.length - Math.max(value, 0), 0) };
  },
  defaults(slots, _ctx, numbers): Record<string, number> {
    // Until its end is dragged, the thread runs the rest of the face.
    const geometry = threadFace(slots.faces[0]);
    if (!geometry) return {};
    return { length: Math.max(geometry.length - (numbers.offset ?? 0), 0) };
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
    for (const id of ['length', 'offset']) {
      const number = resolved(id);
      if (number !== undefined) all[id] = number;
    }
    const from = threadAnchor(face, ctx);
    const geometry = threadFace(face);
    return {
      tool: 'thread',
      thread: {
        targetBodyId: face.bodyId,
        faceHash: face.hash,
        ...(face.reference ? { faceReference: face.reference } : {}),
        ...threadRequestFields(values, options, ctx.units ?? 'mm', {
          partial: threadIsPartial(face, values, all, ctx),
          from,
          ...(savedThread(ctx)?.anchor === undefined
            ? {}
            : { storedAnchor: savedThread(ctx)!.anchor! }),
          ...(all.offset === undefined ? {} : { offset: all.offset }),
          ...(all.length === undefined ? {} : { length: all.length }),
          ...(geometry
            ? { face: { length: geometry.length, radius: geometry.radius } }
            : {})
        })
      }
    };
  },
  handles(
    slots: InPlaceSlots,
    values: Record<string, number>,
    ctx: InPlaceContext
  ): HandleSpec[] {
    const face = slots.faces[0];
    if (!face) return [];
    const geometry = threadFace(face);
    if (!geometry) {
      // No cylinder to stand an arrow on: a stored partial thread's length
      // is still a chip on the face.
      const anchor = face.point ?? face.centroid ?? face.center;
      return anchor && savedThread(ctx)?.length !== undefined
        ? [
            {
              valueId: 'length',
              kind: 'chip',
              key: `thread:${face.bodyId}:${face.hash}:length`,
              params: { anchor }
            }
          ]
        : [];
    }
    // One arrow on the thread's free end, sliding along the face from the
    // end it starts at: drag it short of the far end for a partial thread.
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
        valueId: 'length',
        kind: 'linear',
        key: [
          'thread',
          face.bodyId,
          face.hash,
          'length',
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
