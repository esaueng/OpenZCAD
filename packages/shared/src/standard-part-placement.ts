/**
 * M17: where a standard part stands and which row it is, from a tool's
 * choices and picks: on a picked plane, or (schema v74) in a picked bore of
 * an M01 hole, sized and length-matched by the hole. Pure: the Standard
 * part command reads it, and the kernel build shares its fit rule
 * (`standardHoleFit`).
 */
import type {
  FeatureData,
  FeatureId,
  ParamValue,
  UnitSystem,
  Vector3
} from './index';
import { holeStandardDiameterMm } from './hole-standards';
import { millimetresPerUnit } from './index';
import {
  STANDARD_PART_KINDS,
  STANDARD_SCREW_HEADS,
  matchedStandardLengthMm,
  standardHoleFit,
  standardPartDefaultLengthMm,
  standardPartForHole,
  standardPartSizes,
  type StandardPartChoice,
  type StandardPartKind,
  type StandardPartSize,
  type StandardPartSystem,
  type StandardScrewHead
} from './standard-parts';

/** Whether a part of this kind goes into the face it is placed on. */
export function standardPartGoesIn(kind: StandardPartKind): boolean {
  return kind === 'screw' || kind === 'insert' || kind === 'dowel';
}

/** The size choice a kind, head and system read their size from. */
export function standardPartSizeOptionId(
  kind: StandardPartKind,
  system: StandardPartSystem,
  head: StandardScrewHead = 'socket'
): string {
  return `size-${system}-${kind === 'screw' ? `screw-${head}` : kind}`;
}

/** The kind, head and system a set of choices names, defaults filled in. */
export function standardPartRow(options: Readonly<Record<string, string>>): {
  partKind: StandardPartKind;
  system: StandardPartSystem;
  head?: StandardScrewHead;
} {
  const partKind = STANDARD_PART_KINDS.includes(
    options.partKind as StandardPartKind
  )
    ? (options.partKind as StandardPartKind)
    : 'screw';
  const system: StandardPartSystem = options.system === 'ansi' ? 'ansi' : 'iso';
  const head = STANDARD_SCREW_HEADS.includes(options.head as StandardScrewHead)
    ? (options.head as StandardScrewHead)
    : 'socket';
  return { partKind, system, ...(partKind === 'screw' ? { head } : {}) };
}

/** The middle-of-the-range default: M6 or 1/4 where the table has it. */
export function standardPartDefaultSize(sizes: readonly string[]): string {
  for (const preferred of ['M6', '1/4', '6', '608', 'R4', 'M3', '#6']) {
    if (sizes.includes(preferred)) return preferred;
  }
  return sizes[Math.floor(sizes.length / 2)]!;
}

/** The catalogue row a set of choices names, size included. */
export function standardPartChoiceOf(
  options: Readonly<Record<string, string>>
): StandardPartChoice {
  const row = standardPartRow(options);
  const sizes = standardPartSizes(row.partKind, row.system, row.head);
  const chosen =
    options[standardPartSizeOptionId(row.partKind, row.system, row.head)];
  const size =
    chosen && (sizes as readonly string[]).includes(chosen)
      ? chosen
      : standardPartDefaultSize(sizes);
  return { ...row, size };
}

/** The length a row is offered at first, in document units. */
export function standardPartDefaultLength(
  choice: StandardPartChoice,
  units: UnitSystem
): number {
  const millimetres = standardPartDefaultLengthMm(choice);
  return millimetres === undefined
    ? 20
    : Number((millimetres / millimetresPerUnit(units)).toPrecision(12));
}

/** A direction with no −0 component, so a stored zero reads 0. */
function clean(v: Vector3): Vector3 {
  return { x: v.x || 0, y: v.y || 0, z: v.z || 0 };
}

/**
 * Where a part placed on a plane stands: at the picked point, going into
 * the plane (a screw, insert or dowel pin) or standing on it.
 */
export function standardPartOnPlane(
  origin: Vector3,
  normal: Vector3,
  kind: StandardPartKind
): { origin: Vector3; axis: Vector3 } | null {
  const length = Math.hypot(normal.x, normal.y, normal.z);
  if (!(length > 0)) return null;
  const sign = standardPartGoesIn(kind) ? -1 : 1;
  return {
    origin,
    axis: clean({
      x: (sign * normal.x) / length,
      y: (sign * normal.y) / length,
      z: (sign * normal.z) / length
    })
  };
}

/** A part going into a hole: the row the hole takes and where it stands. */
export interface StandardPartInHole {
  choice: StandardPartChoice;
  origin: Vector3;
  axis: Vector3;
  /** The matched length in document units, or why none fits. */
  matchedLength: number | string;
}

/**
 * Where a part picked into a hole stands, read from the picked bore: its
 * axis runs into the hole's entry face (`entryNormal`, outward), its seat is
 * the bore's end nearer that face, and its length below the seat is the
 * bore's. Without a picked bore it keeps `stored` and no length is matched.
 * A string says why the hole takes no such part.
 */
export function standardPartInHole(input: {
  options: Readonly<Record<string, string>>;
  hole: Extract<FeatureData, { featureKind: 'hole' }>;
  entryNormal: Vector3 | null;
  bore?: { axisStart: Vector3; axisEnd: Vector3; axialLength?: number };
  stored?: { origin: Vector3; axis: Vector3 };
  units: UnitSystem;
  evaluate(value: ParamValue): number | null;
}): StandardPartInHole | string | null {
  const row = standardPartRow(input.options);
  if (row.partKind !== 'screw' && row.partKind !== 'dowel') {
    return 'Only a screw or a dowel pin goes into a hole';
  }
  const mm = millimetresPerUnit(input.units);
  const { hole, bore } = input;
  let place: { origin: Vector3; axis: Vector3 } | null = null;
  let boreMm: number | null = null;
  if (bore && input.entryNormal) {
    const n = input.entryNormal;
    const size = Math.hypot(n.x, n.y, n.z) || 1;
    const height = (p: Vector3) => (p.x * n.x + p.y * n.y + p.z * n.z) / size;
    place = {
      origin:
        height(bore.axisStart) >= height(bore.axisEnd)
          ? bore.axisStart
          : bore.axisEnd,
      axis: clean({ x: -n.x / size, y: -n.y / size, z: -n.z / size })
    };
    boreMm =
      (bore.axialLength ??
        Math.hypot(
          bore.axisEnd.x - bore.axisStart.x,
          bore.axisEnd.y - bore.axisStart.y,
          bore.axisEnd.z - bore.axisStart.z
        )) * mm;
  } else if (input.stored) {
    place = input.stored;
  }
  if (!place) return null;
  const diameter = hole.standard
    ? holeStandardDiameterMm(hole.standard)
    : (input.evaluate(hole.diameter) ?? Number.NaN) * mm;
  const tapped =
    hole.tapped?.length === undefined
      ? null
      : input.evaluate(hole.tapped.length);
  const fit = standardHoleFit(
    hole,
    diameter,
    boreMm ?? Number.NaN,
    tapped === null ? undefined : tapped * mm
  );
  const choice = standardPartForHole(row.partKind, fit, row.system, row.head);
  if (typeof choice === 'string') return choice;
  const matched =
    boreMm === null
      ? 'The stored length stands until the bore is picked again'
      : matchedStandardLengthMm(choice, fit);
  return {
    choice,
    ...place,
    matchedLength:
      typeof matched === 'string'
        ? matched
        : Number((matched / mm).toPrecision(12))
  };
}

/** One size choice list: the sizes a kind, head and system offer. */
export interface StandardPartSizeChoices {
  id: string;
  partKind: StandardPartKind;
  system: StandardPartSystem;
  head?: StandardScrewHead;
  initial: string;
  choices: { value: string; label: string }[];
}

/** Every size choice list, one per kind, head and system. */
export function standardPartSizeChoiceLists(): StandardPartSizeChoices[] {
  return (['iso', 'ansi'] as const).flatMap((system) =>
    STANDARD_PART_KINDS.flatMap((partKind) =>
      (partKind === 'screw' ? STANDARD_SCREW_HEADS : [undefined]).map(
        (head) => {
          const sizes = standardPartSizes(partKind, system, head);
          return {
            id: standardPartSizeOptionId(partKind, system, head),
            partKind,
            system,
            ...(head ? { head } : {}),
            initial: standardPartDefaultSize(sizes),
            choices: sizes.map((size) => ({
              value: size,
              label:
                partKind === 'dowel'
                  ? system === 'iso'
                    ? `Ø${size}`
                    : `Ø${size}"`
                  : size
            }))
          };
        }
      )
    )
  );
}

/**
 * An edited part's choices, and the plane it was placed on: the plane's
 * normal is the face's, so a part that goes into its face stored the
 * opposite axis. The plane is null where its numbers do not resolve.
 */
export function standardPartEditChoices(
  data: Extract<FeatureData, { featureKind: 'standard-part' }>,
  evaluate: (value: ParamValue) => number | null
): {
  options: Record<string, string>;
  plane: {
    origin: Vector3;
    normal: Vector3;
    fields: {
      origin: { x: string; y: string; z: string };
      normal: { x: string; y: string; z: string };
    };
  } | null;
} {
  const options: Record<string, string> = {
    partKind: data.partKind,
    ...(data.hole ? { place: 'hole' } : {}),
    system: data.system,
    ...(data.head ? { head: data.head } : {}),
    [standardPartSizeOptionId(data.partKind, data.system, data.head)]: data.size
  };
  const resolved = (vector: {
    x: ParamValue;
    y: ParamValue;
    z: ParamValue;
  }) => {
    const x = evaluate(vector.x);
    const y = evaluate(vector.y);
    const z = evaluate(vector.z);
    return x === null || y === null || z === null ? null : { x, y, z };
  };
  const origin = resolved(data.origin);
  const axis = resolved(data.axis);
  if (!origin || !axis) return { options, plane: null };
  const sign = standardPartGoesIn(data.partKind) ? -1 : 1;
  const text = (vector: { x: ParamValue; y: ParamValue; z: ParamValue }) => ({
    x: String(vector.x),
    y: String(vector.y),
    z: String(vector.z)
  });
  return {
    options,
    plane: {
      origin,
      normal: clean({ x: sign * axis.x, y: sign * axis.y, z: sign * axis.z }),
      fields: { origin: text(data.origin), normal: text(data.axis) }
    }
  };
}

/**
 * The fields a part inserted into a hole stores: the row the hole takes,
 * a length only once one is set (else it is matched at every rebuild), and
 * where it stood when inserted (`stored`, as written, when it is kept).
 */
export function standardPartHoleFields(
  inserted: StandardPartInHole & { featureId: FeatureId },
  length: ParamValue | undefined,
  stored?: Pick<
    Extract<FeatureData, { featureKind: 'standard-part' }>,
    'origin' | 'axis' | 'xDirection'
  >
): Omit<Extract<FeatureData, { featureKind: 'standard-part' }>, 'featureKind'> {
  const { choice } = inserted;
  return {
    partKind: choice.partKind,
    system: choice.system,
    size: choice.size as StandardPartSize,
    ...(choice.head ? { head: choice.head } : {}),
    ...(length !== undefined ? { length } : {}),
    origin: stored ? { ...stored.origin } : clean(inserted.origin),
    axis: stored ? { ...stored.axis } : clean(inserted.axis),
    ...(stored?.xDirection ? { xDirection: { ...stored.xDirection } } : {}),
    hole: { featureId: inserted.featureId }
  };
}
