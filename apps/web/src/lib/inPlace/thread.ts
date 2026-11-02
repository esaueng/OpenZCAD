import {
  ISO_METRIC_COARSE_THREADS,
  UNIT_TO_MM,
  isoMetricThreadLabel,
  type FeatureData,
  type ParamValue,
  type ThreadProfile,
  type UnitSystem
} from '@openzcad/shared';
import type {
  HandleSpec,
  InPlaceContext,
  InPlacePanelState,
  InPlaceRequest,
  InPlaceSlots,
  InPlaceToolSpec,
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
const band = (state: InPlacePanelState) => state.options.span === 'band';
/** A chamfer needs the thread to reach the face's ends: the whole face only. */
const chamfered = (state: InPlacePanelState) =>
  !band(state) && (state.options.chamfer ?? 'both') !== 'none';

const THREAD_VALUES: readonly ValueSpec[] = [
  {
    id: 'majorDiameter',
    label: 'Major Ø',
    unit: 'length',
    initial: 6,
    min: 0,
    exclusive: true,
    note: 'The thread’s outer diameter: a bolt’s crest, a nut’s root',
    when: customSize
  },
  {
    id: 'pitch',
    label: 'Pitch',
    unit: 'length',
    initial: 1,
    min: 0,
    exclusive: true,
    note: 'Axial distance from one thread to the next',
    when: (state) => customSize(state) || custom(state)
  },
  {
    id: 'depth',
    label: 'Depth',
    unit: 'length',
    initial: 0.5,
    min: 0,
    exclusive: true,
    note: 'Crest to root, measured across the axis',
    when: custom
  },
  {
    id: 'crestWidth',
    label: 'Crest flat',
    unit: 'length',
    initial: 0.25,
    min: 0,
    note: 'Width of the flat on each crest; a printed crest narrower than a line prints sharp',
    when: custom
  },
  {
    id: 'lowerFlankAngleDeg',
    label: 'Lower flank',
    unit: 'angle',
    initial: 45,
    min: 0,
    max: 75,
    note: 'From the plane across the axis. Printed upright, a flank under 45° overhangs past 45°',
    when: custom
  },
  {
    id: 'upperFlankAngleDeg',
    label: 'Upper flank',
    unit: 'angle',
    initial: 45,
    min: 0,
    max: 75,
    note: 'The flank facing the face’s far end; 0° is square',
    when: custom
  },
  {
    id: 'clearance',
    label: 'Clearance',
    unit: 'length',
    initial: 0.1,
    min: 0,
    note: 'Radial gap to the mating thread: a boss’s thread shrinks, a bore’s grows',
    when: (state) => state.options.fit === 'custom'
  },
  {
    id: 'length',
    label: 'Length',
    unit: 'length',
    initial: 5,
    min: 0,
    exclusive: true,
    when: band
  },
  {
    id: 'offset',
    label: 'Offset',
    unit: 'length',
    initial: 0,
    min: 0,
    note: 'From the chosen end of the face to the thread',
    inOptions: true,
    when: band
  },
  {
    id: 'starts',
    label: 'Starts',
    unit: 'count',
    initial: 1,
    min: 1,
    max: 16,
    integer: true,
    note: 'Parallel threads; more starts advance faster per turn'
  },
  {
    id: 'phaseDeg',
    label: 'Start angle',
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
    note: 'The chamfer cone’s angle from the axis; 45° prints cleanly',
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
        label: 'Printable 45°',
        note: 'Both flanks at 45° print upright without support, with quarter-pitch flats instead of sharp crests. Mates with other printable threads, not ISO hardware.'
      },
      {
        value: 'iso-metric',
        label: 'ISO metric 60°',
        note: 'ISO 68-1: mates with standard bolts and nuts. Printed upright its flanks overhang 60°.'
      },
      {
        value: 'custom',
        label: 'Custom',
        note: 'Set the pitch, depth, crest flat and each flank'
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
        label: 'Fit the face',
        note: 'A boss keeps its diameter with the nearest ISO coarse pitch; a bore takes the size whose tap drill it is'
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
        label: 'Printed (0.1 mm)',
        note: 'A radial gap that lets printed parts turn freely'
      },
      {
        value: 'loose',
        label: 'Loose (0.2 mm)',
        note: 'For coarse layers, or a first-layer flare on a bolt’s head end'
      },
      {
        value: 'exact',
        label: 'Exact',
        note: 'Nominal size, for machined parts or a drawing'
      },
      { value: 'custom', label: 'Custom' }
    ],
    initial: 'print'
  },
  {
    id: 'span',
    label: 'Runs',
    choices: [
      { value: 'face', label: 'The whole face' },
      {
        value: 'band',
        label: 'Part of the face',
        note: 'The cylinder stays as it was beside the thread'
      }
    ],
    initial: 'face'
  },
  {
    id: 'anchor',
    label: 'From',
    when: band,
    choices: [
      { value: 'start', label: 'The face’s start' },
      { value: 'end', label: 'The face’s end' }
    ],
    initial: 'start'
  },
  {
    id: 'chamfer',
    label: 'Chamfer',
    when: (state) => !band(state),
    choices: [
      {
        value: 'both',
        label: 'Both ends',
        note: 'A cone tapers each end’s first turn out: no thin wedge to print, and a mating part starts easily'
      },
      { value: 'start', label: 'Face start' },
      { value: 'end', label: 'Face end' },
      { value: 'none', label: 'None' }
    ],
    initial: 'both'
  },
  {
    id: 'hand',
    label: 'Hand',
    choices: [
      { value: 'right', label: 'Right hand' },
      { value: 'left', label: 'Left hand' }
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

function threadLength(value: number, units: UnitSystem): string {
  return `${Math.round(value * 1000) / 1000} ${units}`;
}

/** What the choices come to: the callout and the fit, when they are known. */
export function threadSummary(
  state: InPlacePanelState,
  units: UnitSystem
): string | null {
  const parts: string[] = [];
  const iso = isoSize(state.options.size);
  if (iso) {
    parts.push(isoMetricThreadLabel(iso.nominal, iso.pitch));
  } else if (state.options.size === 'custom') {
    const major = state.numbers.majorDiameter ?? 6;
    const pitch = state.numbers.pitch ?? 1;
    parts.push(
      `Ø ${threadLength(major, units)} × ${threadLength(pitch, units)}`
    );
  }
  const starts = Math.round(state.numbers.starts ?? 1);
  if (starts > 1) parts.push(`${starts} starts`);
  if (state.options.hand === 'left') parts.push('Left hand');
  if (chamfered(state)) {
    const ends = state.options.chamfer ?? 'both';
    const angle = Math.round((state.numbers.chamferAngleDeg ?? 45) * 100) / 100;
    parts.push(
      ends === 'both'
        ? `Chamfered ${angle}°`
        : `Chamfered ${angle}° at the face ${ends}`
    );
  }
  const clearance =
    state.options.fit === 'custom'
      ? (state.numbers.clearance ?? 0)
      : fitClearance(state.options.fit, units);
  if (clearance > 0) {
    parts.push(`Clearance ${threadLength(clearance, units)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The Options a stored thread reads back as: an ISO size whose stored
 * diameter and pitch are that size's, a fit whose clearance is one of the
 * presets, a band when it stores a length.
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
  if (data.length !== undefined) {
    options.span = 'band';
    options.anchor = data.anchor ?? 'start';
  } else {
    options.span = 'face';
  }
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

/** The feature fields an in-place thread command stores. */
export function threadRequestFields(
  values: Readonly<Record<string, ParamValue>>,
  options: Readonly<Record<string, string>>,
  units: UnitSystem
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
  if (options.span === 'band') {
    fields.length = values.length ?? 5 / mm;
    const offset = values.offset;
    if (offset !== undefined && offset !== 0) fields.offset = offset;
    if (options.anchor === 'end') fields.anchor = 'end';
  }
  const phase = values.phaseDeg;
  if (phase !== undefined && phase !== 0) fields.phaseDeg = phase;
  // A chamfered end must reach the end of the face, so only a thread along
  // the whole face takes one.
  const chamfer =
    options.span === 'band' ? 'none' : (options.chamfer ?? 'both');
  if (chamfer === 'both' || chamfer === 'start') fields.chamferStart = true;
  if (chamfer === 'both' || chamfer === 'end') fields.chamferEnd = true;
  if (chamfer !== 'none') {
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
  layout: [
    {
      items: ['profile', 'size', 'majorDiameter', 'pitch', 'fit', 'clearance']
    },
    {
      items: [
        'span',
        'anchor',
        'length',
        'offset',
        'chamfer',
        'chamferAngleDeg'
      ]
    },
    {
      label: 'Form',
      items: ['depth', 'crestWidth', 'lowerFlankAngleDeg', 'upperFlankAngleDeg']
    },
    { label: 'More', collapsed: true, items: ['hand', 'starts', 'phaseDeg'] }
  ],
  summary: threadSummary,
  hint(slots: InPlaceSlots, options?: Record<string, string>) {
    if (slots.faces.length === 0) {
      return 'Pick a cylindrical face: a boss for a bolt’s thread, a bore for a nut’s';
    }
    return options?.span === 'band'
      ? 'Tap the length to type; the thread starts at the chosen end'
      : 'The thread runs the whole face · Enter to finish';
  },
  ready: (slots: InPlaceSlots) => slots.faces.length > 0,
  request(
    slots: InPlaceSlots,
    values: Record<string, ParamValue>,
    options: Record<string, string>,
    ctx: InPlaceContext
  ): InPlaceRequest | null {
    const face = slots.faces[0];
    if (!face) return null;
    return {
      tool: 'thread',
      thread: {
        targetBodyId: face.bodyId,
        faceHash: face.hash,
        ...(face.reference ? { faceReference: face.reference } : {}),
        ...threadRequestFields(values, options, ctx.units ?? 'mm')
      }
    };
  },
  handles(
    slots: InPlaceSlots,
    _values: Record<string, number>,
    _ctx: InPlaceContext,
    options: Record<string, string>
  ): HandleSpec[] {
    const face = slots.faces[0];
    const anchor = face?.point ?? face?.centroid ?? face?.center;
    if (!face || !anchor || options.span !== 'band') return [];
    return [
      {
        valueId: 'length',
        kind: 'chip',
        key: `thread:${face.bodyId}:${face.hash}:length`,
        params: { anchor }
      }
    ];
  }
};
