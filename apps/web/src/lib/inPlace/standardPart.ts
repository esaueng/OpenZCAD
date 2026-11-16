import {
  STANDARD_PART_KINDS,
  STANDARD_SCREW_HEADS,
  millimetresPerUnit,
  standardPartDefaultLengthMm,
  standardPartDesignation,
  standardPartHasLength,
  standardPartMinimumLengthMm,
  standardPartGeometry,
  standardPartSizes,
  type FeatureData,
  type ParametricVector3,
  type StandardPartChoice,
  type StandardPartKind,
  type StandardPartSize,
  type StandardPartSystem,
  type StandardScrewHead,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import type {
  InPlacePanelState,
  InPlaceToolSpec,
  OptionSpec,
  PlanePick
} from './tools';

/**
 * M17 (schema v68): the Standard part command. Pick a flat face or a plane
 * and the part stands where it was clicked: a screw, threaded insert or
 * dowel pin goes into the face, a nut, washer or bearing sits on it. Kind,
 * head, system and size are Options; a screw's or dowel pin's length is a
 * handle along its axis, from the face.
 */

/** A standard part's fields, as {@link InPlaceRequest} carries them. */
export type StandardPartRequest = Omit<
  Extract<FeatureData, { featureKind: 'standard-part' }>,
  'featureKind'
>;

const KIND_LABELS: Record<StandardPartKind, string> = {
  screw: 'Screw',
  nut: 'Nut',
  washer: 'Washer',
  insert: 'Threaded insert',
  dowel: 'Dowel pin',
  bearing: 'Ball bearing'
};

const HEAD_LABELS: Record<StandardScrewHead, string> = {
  socket: 'Socket head',
  hex: 'Hex head',
  countersunk: 'Countersunk'
};

/** Whether a part of this kind goes into the face it is placed on. */
export function standardPartGoesIn(kind: StandardPartKind): boolean {
  return kind === 'screw' || kind === 'insert' || kind === 'dowel';
}

/** The size option a kind, head and system read their size from. */
export function standardPartSizeOptionId(
  kind: StandardPartKind,
  system: StandardPartSystem,
  head: StandardScrewHead = 'socket'
): string {
  return `size-${system}-${kind === 'screw' ? `screw-${head}` : kind}`;
}

/** The kind, head and system the options choose. */
function chosenRow(options: Readonly<Record<string, string>>): {
  partKind: StandardPartKind;
  system: StandardPartSystem;
  head?: StandardScrewHead;
} {
  const partKind = (
    STANDARD_PART_KINDS.includes(options.partKind as StandardPartKind)
      ? options.partKind
      : 'screw'
  ) as StandardPartKind;
  const system: StandardPartSystem = options.system === 'ansi' ? 'ansi' : 'iso';
  const head = STANDARD_SCREW_HEADS.includes(options.head as StandardScrewHead)
    ? (options.head as StandardScrewHead)
    : 'socket';
  return { partKind, system, ...(partKind === 'screw' ? { head } : {}) };
}

/** The catalogue row the options choose, size included. */
export function standardPartChoice(
  options: Readonly<Record<string, string>>
): StandardPartChoice {
  const row = chosenRow(options);
  const sizes = standardPartSizes(row.partKind, row.system, row.head);
  const chosen =
    options[standardPartSizeOptionId(row.partKind, row.system, row.head)];
  const size =
    chosen && (sizes as readonly string[]).includes(chosen)
      ? chosen
      : defaultSize(sizes);
  return { ...row, size };
}

/** The middle-of-the-range default: M6 or 1/4 where the table has it. */
function defaultSize(sizes: readonly string[]): string {
  for (const preferred of ['M6', '1/4', '6', '608', 'R4', 'M3', '#6']) {
    if (sizes.includes(preferred)) return preferred;
  }
  return sizes[Math.floor(sizes.length / 2)]!;
}

const SIZE_OPTIONS: OptionSpec[] = (['iso', 'ansi'] as const).flatMap(
  (system) =>
    STANDARD_PART_KINDS.flatMap((kind) =>
      (kind === 'screw' ? STANDARD_SCREW_HEADS : [undefined]).map(
        (head): OptionSpec => {
          const sizes = standardPartSizes(kind, system, head);
          return {
            id: standardPartSizeOptionId(kind, system, head),
            label: kind === 'bearing' ? 'Bearing' : 'Size',
            choices: sizes.map((size) => ({
              value: size,
              label:
                kind === 'dowel'
                  ? system === 'iso'
                    ? `Ø${size}`
                    : `Ø${size}"`
                  : size
            })),
            initial: defaultSize(sizes),
            when: (state: InPlacePanelState) => {
              const row = chosenRow(state.options);
              return (
                row.partKind === kind &&
                row.system === system &&
                (kind !== 'screw' || row.head === head)
              );
            }
          };
        }
      )
    )
);

/** The length a row is offered at first, in document units. */
function defaultLength(choice: StandardPartChoice, units: UnitSystem): number {
  const millimetres = standardPartDefaultLengthMm(choice);
  return millimetres === undefined
    ? 20
    : Number((millimetres / millimetresPerUnit(units)).toPrecision(12));
}

/** Where the part stands: the picked point and the way it goes. */
function placement(
  plane: PlanePick | null,
  kind: StandardPartKind
): { origin: Vector3; axis: Vector3 } | null {
  if (!plane || plane.kind === 'datum') return null;
  const n = plane.normal;
  const length = Math.hypot(n.x, n.y, n.z);
  if (!(length > 0)) return null;
  const sign = standardPartGoesIn(kind) ? -1 : 1;
  return {
    origin: plane.origin,
    // `|| 0` stores a zero component as 0, never −0.
    axis: {
      x: (sign * n.x) / length || 0,
      y: (sign * n.y) / length || 0,
      z: (sign * n.z) / length || 0
    }
  };
}

function vectorOf(v: Vector3): ParametricVector3 {
  return { x: v.x, y: v.y, z: v.z };
}

export const standardPartSpec: InPlaceToolSpec = {
  id: 'standard-part',
  title: 'Standard part',
  profileMode: 'none',
  wantsPlane: true,
  planeAtClick: true,
  wantsAxis: false,
  wantsPath: false,
  values: [
    {
      id: 'length',
      label: 'Length',
      unit: 'length',
      initial: 16,
      min: 0,
      exclusive: 'min',
      note: 'Under the head; a countersunk screw’s includes its head',
      when: (state) => standardPartHasLength(chosenRow(state.options).partKind)
    }
  ],
  options: [
    {
      id: 'partKind',
      label: 'Part',
      choices: STANDARD_PART_KINDS.map((kind) => ({
        value: kind,
        label: KIND_LABELS[kind]
      })),
      initial: 'screw'
    },
    {
      id: 'head',
      label: 'Head',
      choices: STANDARD_SCREW_HEADS.map((head) => ({
        value: head,
        label: HEAD_LABELS[head]
      })),
      initial: 'socket',
      when: (state) => chosenRow(state.options).partKind === 'screw'
    },
    {
      id: 'system',
      label: 'Standard',
      choices: [
        { value: 'iso', label: 'ISO metric' },
        { value: 'ansi', label: 'ANSI inch' }
      ],
      initial: 'iso'
    },
    ...SIZE_OPTIONS
  ],
  layout: [
    {
      boxed: true,
      compact: true,
      items: [
        'partKind',
        'head',
        'system',
        ...SIZE_OPTIONS.map((option) => option.id),
        'length'
      ]
    }
  ],
  summary: (state) => {
    const choice = standardPartChoice(state.options);
    return standardPartDesignation(
      choice,
      standardPartHasLength(choice.partKind) ? state.numbers.length : undefined
    );
  },
  defaults(_slots, ctx, _numbers, options) {
    const choice = standardPartChoice(options ?? {});
    return { length: defaultLength(choice, ctx.units ?? 'mm') };
  },
  refuseValue(valueId, value, _values, _slots, context) {
    if (valueId !== 'length' || !context?.options) return null;
    const choice = standardPartChoice(context.options);
    if (!standardPartHasLength(choice.partKind)) return null;
    const units = context.units ?? 'mm';
    const minimum =
      standardPartMinimumLengthMm(standardPartGeometry(choice)) /
      millimetresPerUnit(units);
    return value > minimum
      ? null
      : `This size must be longer than ${Number(minimum.toPrecision(4))} ${units}`;
  },
  hint(slots, options) {
    if (!slots.plane) return 'Click a flat face or a plane to place the part';
    if (slots.plane.kind === 'datum') {
      return 'Pick a ghost plane or flat face instead';
    }
    const choice = standardPartChoice(options ?? {});
    return standardPartHasLength(choice.partKind)
      ? 'Drag the length · choose the size in Options'
      : 'Choose the size in Options';
  },
  ready: (slots, options) =>
    placement(slots.plane, standardPartChoice(options ?? {}).partKind) !== null,
  request(slots, values, options, ctx) {
    const choice = standardPartChoice(options);
    const at = placement(slots.plane, choice.partKind);
    if (!at) return null;
    // An edited part keeps its stored placement, expressions and all,
    // until another plane is picked.
    const saved =
      ctx.saved?.featureKind === 'standard-part' &&
      slots.plane?.kind === 'saved' &&
      standardPartGoesIn(ctx.saved.partKind) ===
        standardPartGoesIn(choice.partKind)
        ? ctx.saved
        : null;
    return {
      tool: 'standard-part',
      part: {
        partKind: choice.partKind,
        system: choice.system,
        size: choice.size as StandardPartSize,
        ...(choice.head ? { head: choice.head } : {}),
        ...(standardPartHasLength(choice.partKind)
          ? {
              length: values.length ?? defaultLength(choice, ctx.units ?? 'mm')
            }
          : {}),
        origin: saved ? { ...saved.origin } : vectorOf(at.origin),
        axis: saved ? { ...saved.axis } : vectorOf(at.axis),
        ...(saved?.xDirection ? { xDirection: { ...saved.xDirection } } : {})
      }
    };
  },
  handles(slots, _values, _ctx, options) {
    const choice = standardPartChoice(options);
    const at = placement(slots.plane, choice.partKind);
    if (!at || !standardPartHasLength(choice.partKind)) return [];
    const { origin, axis } = at;
    return [
      {
        valueId: 'length',
        kind: 'linear',
        key: `standard-part:${origin.x}:${origin.y}:${origin.z}:${axis.x}:${axis.y}:${axis.z}`,
        params: { origin, direction: axis }
      }
    ];
  }
};

/**
 * An edited part's options and its saved plane: the plane's normal is the
 * face's, so a part that goes into its face stored the opposite axis.
 */
export function standardPartEditSeed(
  data: Extract<FeatureData, { featureKind: 'standard-part' }>,
  evaluate: (value: ParametricVector3[keyof ParametricVector3]) => number | null
): { options: Record<string, string>; plane: PlanePick | null } {
  const options: Record<string, string> = {
    partKind: data.partKind,
    system: data.system,
    ...(data.head ? { head: data.head } : {}),
    [standardPartSizeOptionId(data.partKind, data.system, data.head)]: data.size
  };
  const resolved = (vector: ParametricVector3) => {
    const x = evaluate(vector.x);
    const y = evaluate(vector.y);
    const z = evaluate(vector.z);
    return x === null || y === null || z === null ? null : { x, y, z };
  };
  const origin = resolved(data.origin);
  const axis = resolved(data.axis);
  if (!origin || !axis) return { options, plane: null };
  const sign = standardPartGoesIn(data.partKind) ? -1 : 1;
  const text = (vector: ParametricVector3) => ({
    x: String(vector.x),
    y: String(vector.y),
    z: String(vector.z)
  });
  return {
    options,
    plane: {
      kind: 'saved',
      origin,
      normal: {
        x: sign * axis.x || 0,
        y: sign * axis.y || 0,
        z: sign * axis.z || 0
      },
      fields: { origin: text(data.origin), normal: text(data.axis) }
    }
  };
}
