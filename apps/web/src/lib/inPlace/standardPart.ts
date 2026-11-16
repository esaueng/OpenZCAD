import {
  STANDARD_PART_KINDS,
  STANDARD_SCREW_HEADS,
  millimetresPerUnit,
  standardPartChoiceOf,
  standardPartDefaultLength,
  standardPartDesignation,
  standardPartGoesIn,
  standardPartHasLength,
  standardPartInHole,
  standardPartHoleFields,
  standardPartMinimumLengthMm,
  standardPartGeometry,
  standardPartOnPlane,
  standardPartEditChoices,
  standardPartRow,
  standardPartSizeChoiceLists,
  standardPartSizeOptionId,
  type FeatureData,
  type FeatureId,
  type ParamValue,
  type ParametricVector3,
  type StandardPartInHole,
  type StandardPartKind,
  type StandardPartSize,
  type StandardScrewHead,
  type Vector3
} from '@openzcad/shared';
import type {
  InPlaceContext,
  InPlacePanelState,
  InPlaceRequest,
  InPlaceSlots,
  InPlaceToolSpec,
  OptionSpec,
  PlanePick
} from './tools';

/**
 * M17 (schema v69): the Standard part command. Pick a flat face or a plane
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

export { standardPartGoesIn, standardPartSizeOptionId };

const chosenRow = standardPartRow;
const defaultLength = standardPartDefaultLength;

/** The catalogue row the options choose, size included. */
export const standardPartChoice = standardPartChoiceOf;

const SIZE_OPTIONS: OptionSpec[] = standardPartSizeChoiceLists().map(
  ({ id, partKind, system, head, initial, choices }) => ({
    id,
    label: partKind === 'bearing' ? 'Bearing' : 'Size',
    choices,
    initial,
    when: (state: InPlacePanelState) => {
      const row = chosenRow(state.options);
      return (
        row.partKind === partKind &&
        row.system === system &&
        (partKind !== 'screw' || row.head === head)
      );
    }
  })
);

/** Where the part stands on a picked plane, and the way it goes. */
function placement(
  plane: PlanePick | null,
  kind: StandardPartKind
): { origin: Vector3; axis: Vector3 } | null {
  if (!plane || plane.kind === 'datum') return null;
  return standardPartOnPlane(plane.origin, plane.normal, kind);
}

function vectorOf(v: Vector3): ParametricVector3 {
  return { x: v.x || 0, y: v.y || 0, z: v.z || 0 };
}

/** M17 (schema v77): whether the options put the part into a hole. */
function intoHole(options: Readonly<Record<string, string>>): boolean {
  const kind = chosenRow(options).partKind;
  return options.place === 'hole' && (kind === 'screw' || kind === 'dowel');
}

/** A part going into a hole: the hole, the row it takes and where. */
export interface HoleInsertion extends StandardPartInHole {
  featureId: FeatureId;
  name: string;
}

/**
 * Where a part picked into a hole stands (`standardPartInHole`), from the
 * bore picked last, or an edited part's stored hole and placement. Null
 * until a bore is picked; a string says why the hole takes no such part.
 */
export function standardPartHoleInsertion(
  slots: Pick<InPlaceSlots, 'faces'>,
  options: Readonly<Record<string, string>>,
  ctx: Pick<InPlaceContext, 'holeFeature' | 'evaluate' | 'units' | 'saved'>
): HoleInsertion | string | null {
  const face = slots.faces.at(-1);
  const saved =
    ctx.saved?.featureKind === 'standard-part' ? ctx.saved : undefined;
  const featureId = face?.feature?.featureId ?? saved?.hole?.featureId;
  if (!featureId) return null;
  const hole = ctx.holeFeature?.(featureId);
  if (!hole) return 'Click the bore of a hole';
  const evaluate = (value: ParamValue) => ctx.evaluate?.(value) ?? null;
  const resolved = (v: ParametricVector3) => {
    const x = evaluate(v.x);
    const y = evaluate(v.y);
    const z = evaluate(v.z);
    return x === null || y === null || z === null ? null : { x, y, z };
  };
  const storedOrigin = saved?.hole ? resolved(saved.origin) : null;
  const storedAxis = saved?.hole ? resolved(saved.axis) : null;
  const inserted = standardPartInHole({
    options,
    hole: hole.data,
    entryNormal: hole.entryNormal,
    ...(face?.cylinder ? { bore: face.cylinder } : {}),
    ...(storedOrigin && storedAxis
      ? { stored: { origin: storedOrigin, axis: storedAxis } }
      : {}),
    units: ctx.units ?? 'mm',
    evaluate
  });
  return inserted === null || typeof inserted === 'string'
    ? inserted
    : { ...inserted, featureId, name: hole.name };
}

export const standardPartSpec: InPlaceToolSpec = {
  id: 'standard-part',
  title: 'Standard part',
  profileMode: 'none',
  wantsPlane: true,
  planeAtClick: true,
  // M17 (schema v77): Into a hole takes the bore a hole feature drilled.
  featureFaces: { optionId: 'place', value: 'hole' },
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
      id: 'place',
      label: 'Place',
      choices: [
        { value: 'face', label: 'On a face', tip: 'Where a face is clicked' },
        {
          value: 'hole',
          label: 'Into a hole',
          tip: 'In every bore of a hole, its size and length matched'
        }
      ],
      initial: 'face',
      when: (state) => {
        const kind = chosenRow(state.options).partKind;
        return kind === 'screw' || kind === 'dowel';
      }
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
      initial: 'iso',
      // A screw in a hole takes the hole's standard.
      when: (state) =>
        !(
          intoHole(state.options) &&
          chosenRow(state.options).partKind === 'screw'
        )
    },
    ...SIZE_OPTIONS.map((option): OptionSpec => ({
      ...option,
      // In a hole, the hole sets the size.
      when: (state) => !intoHole(state.options) && option.when!(state)
    }))
  ],
  layout: [
    {
      boxed: true,
      compact: true,
      items: [
        'partKind',
        'place',
        'head',
        'system',
        ...SIZE_OPTIONS.map((option) => option.id),
        'length'
      ]
    }
  ],
  summary: (state, units) => {
    if (intoHole(state.options)) {
      return 'Sized by the hole · length matched until dragged';
    }
    const choice = standardPartChoice(state.options);
    // The designation reads millimetres; the panel's length is in the
    // document's units.
    const length = state.numbers.length;
    return standardPartDesignation(
      choice,
      standardPartHasLength(choice.partKind) && length !== undefined
        ? length * millimetresPerUnit(units)
        : undefined
    );
  },
  defaults(slots, ctx, _numbers, options) {
    if (options && intoHole(options)) {
      const inserted = standardPartHoleInsertion(slots, options, ctx);
      if (
        inserted &&
        typeof inserted === 'object' &&
        typeof inserted.matchedLength === 'number'
      ) {
        return { length: inserted.matchedLength };
      }
    }
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
  hint(slots, options, ctx) {
    if (options && intoHole(options)) {
      const inserted = ctx
        ? standardPartHoleInsertion(slots, options, ctx)
        : null;
      if (inserted === null) return 'Click the bore of a hole';
      if (typeof inserted === 'string') return inserted;
      return typeof inserted.matchedLength === 'string'
        ? inserted.matchedLength
        : `In ${inserted.name} · drag the length to override the matched one`;
    }
    if (!slots.plane) return 'Click a flat face or a plane to place the part';
    if (slots.plane.kind === 'datum') {
      return 'Pick a ghost plane or flat face instead';
    }
    const choice = standardPartChoice(options ?? {});
    return standardPartHasLength(choice.partKind)
      ? 'Drag the length · choose the size in Options'
      : 'Choose the size in Options';
  },
  ready: (slots, options, ctx) => {
    if (options && intoHole(options)) {
      const inserted = ctx
        ? standardPartHoleInsertion(slots, options, ctx)
        : null;
      return inserted !== null && typeof inserted === 'object';
    }
    return (
      placement(slots.plane, standardPartChoice(options ?? {}).partKind) !==
      null
    );
  },
  request(slots, values, options, ctx) {
    if (intoHole(options)) return holeRequest(slots, values, options, ctx);
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
  handles(slots, _values, ctx, options) {
    const choice = standardPartChoice(options);
    const inserted = intoHole(options)
      ? standardPartHoleInsertion(slots, options, ctx)
      : null;
    const at =
      inserted !== null && typeof inserted === 'object'
        ? inserted
        : intoHole(options)
          ? null
          : placement(slots.plane, choice.partKind);
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
 * M17 (schema v77): the request for a part in a hole. Its row is the one
 * the hole takes; its length is stored only once set (dragged, typed, or
 * stored by an edit), and otherwise matched to the hole at every rebuild.
 */
function holeRequest(
  slots: InPlaceSlots,
  values: Record<string, ParamValue>,
  options: Record<string, string>,
  ctx: InPlaceContext
): InPlaceRequest | null {
  const inserted = standardPartHoleInsertion(slots, options, ctx);
  if (inserted === null || typeof inserted === 'string') return null;
  const saved =
    ctx.saved?.featureKind === 'standard-part' ? ctx.saved : undefined;
  const keeps =
    saved?.hole?.featureId === inserted.featureId && slots.faces.length === 0;
  const length =
    ctx.touched?.includes('length') && values.length !== undefined
      ? values.length
      : undefined;
  return {
    tool: 'standard-part',
    part: {
      ...standardPartHoleFields(inserted, length, keeps ? saved : undefined),
      ...(saved?.xDirection ? { xDirection: { ...saved.xDirection } } : {})
    }
  };
}

/**
 * An edited part's options and its saved plane: the plane's normal is the
 * face's, so a part that goes into its face stored the opposite axis.
 */
export function standardPartEditSeed(
  data: Extract<FeatureData, { featureKind: 'standard-part' }>,
  evaluate: (value: ParamValue) => number | null
): { options: Record<string, string>; plane: PlanePick | null } {
  const { options, plane } = standardPartEditChoices(data, evaluate);
  return { options, plane: plane ? { kind: 'saved', ...plane } : null };
}
