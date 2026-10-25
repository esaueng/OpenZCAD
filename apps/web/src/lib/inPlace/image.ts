import type { PlaneBasis } from '@openzcad/geometry';
import {
  MAX_REFERENCE_IMAGE_EXTENT,
  MIN_REFERENCE_IMAGE_OPACITY,
  calibratedReferenceImageWidth,
  type ReferenceImage,
  type ReferenceImagePlane,
  type Vector3
} from '@openzcad/shared';
import type {
  HandleSpec,
  InPlaceContext,
  InPlaceSlots,
  InPlaceToolSpec
} from './tools';

/**
 * Placing a reference image in place (U09 phase 6). The picture is chosen
 * first; then a plane or flat face is picked and a click puts its centre
 * there. A corner handle scales it, a ring turns it, a principal plane's
 * offset slides it along the normal, and two clicks on the picture with the
 * real distance between them on a chip scale it to size. Nothing reaches
 * the document until Done, which adds the image as one undoable step.
 */

/** The picture being placed, and where. */
export interface ImageSlot {
  /** The picture as it was prepared: its id, bytes, pixel size and name. */
  record: ReferenceImage;
  /** The plane it lies on (a principal plane at offset 0); null until picked. */
  plane: ReferenceImagePlane | null;
  /** Its centre in the plane's (u, v) coordinates. */
  center: { u: number; v: number };
  /** Two-point scale picks, in the picture's pixels from its top-left. */
  calibration: { x: number; y: number }[];
}

/** A click the Image command takes: a plane picked, a point on it, or both. */
export interface ImagePlacement {
  plane?: ReferenceImagePlane;
  point?: Vector3;
}

const FINISH = 'Enter to finish · Esc cancels';

/**
 * The opacities Options offers: 100% down to 10% in tens, then the least
 * the record allows. The image card still sets any 5% step.
 */
const OPACITIES = [
  1,
  0.9,
  0.8,
  0.7,
  0.6,
  0.5,
  0.4,
  0.3,
  0.2,
  0.1,
  MIN_REFERENCE_IMAGE_OPACITY
];

function add(a: Vector3, b: Vector3, by = 1): Vector3 {
  return { x: a.x + b.x * by, y: a.y + b.y * by, z: a.z + b.z * by };
}

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function unit(vector: Vector3): Vector3 {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

/** The picture's height for a width, keeping its pixels' aspect. */
function heightFor(record: ReferenceImage, width: number): number {
  return (width * record.pixelHeight) / record.pixelWidth;
}

/**
 * The picture's frame in the world for the values shown: its centre (slid
 * `offset` along the normal) and its turned axes, as the viewport draws it.
 */
export function imageFrame(
  basis: PlaneBasis,
  center: { u: number; v: number },
  rotationDeg: number,
  offset: number
): { center: Vector3; xAxis: Vector3; yAxis: Vector3; normal: Vector3 } {
  const turn = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const along = (a: number, b: number): Vector3 =>
    add({ x: basis.u.x * a, y: basis.u.y * a, z: basis.u.z * a }, basis.v, b);
  const normal = unit(basis.normal);
  return {
    center: add(add(basis.origin, along(center.u, center.v)), normal, offset),
    xAxis: along(cos, sin),
    yAxis: along(-sin, cos),
    normal
  };
}

/** Whether the plane takes an offset: only a principal plane stores one. */
function offsets(plane: ReferenceImagePlane | null): boolean {
  return plane?.type === 'canonical';
}

function numbersOf(
  slots: InPlaceSlots,
  numbers: Record<string, number>
): { width: number; rotation: number; offset: number } {
  const image = slots.image;
  return {
    width: numbers.width ?? image?.record.width ?? 100,
    rotation: numbers.rotation ?? 0,
    offset: offsets(image?.plane ?? null) ? (numbers.offset ?? 0) : 0
  };
}

/** The calibration span in model units at `width`, or null without two picks. */
function spanAt(image: ImageSlot, width: number): number | null {
  const [first, second] = image.calibration;
  if (!first || !second) return null;
  const pixels = Math.hypot(second.x - first.x, second.y - first.y);
  return (pixels * width) / image.record.pixelWidth;
}

/** A world point on the picture, in its pixels from the top-left corner. */
function pixelOf(
  image: ImageSlot,
  frame: ReturnType<typeof imageFrame>,
  width: number,
  point: Vector3
): { x: number; y: number } {
  const local = add(point, frame.center, -1);
  const x = dot(local, frame.xAxis);
  const y = dot(local, frame.yAxis);
  return {
    x: (x / width + 0.5) * image.record.pixelWidth,
    y: (0.5 - y / heightFor(image.record, width)) * image.record.pixelHeight
  };
}

/** A picture pixel back in the world, for where a chip stands. */
function worldOf(
  image: ImageSlot,
  frame: ReturnType<typeof imageFrame>,
  width: number,
  pixel: { x: number; y: number }
): Vector3 {
  const x = (pixel.x / image.record.pixelWidth - 0.5) * width;
  const y =
    (0.5 - pixel.y / image.record.pixelHeight) * heightFor(image.record, width);
  return add(add(frame.center, frame.xAxis, x), frame.yAxis, y);
}

function samePlane(a: ReferenceImagePlane | null, b: ReferenceImagePlane) {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A click applied to the picture being placed. A new plane takes the
 * picture, centred where it was clicked (its origin without a point); a
 * point on its plane moves it there, or, while Options say so, is a
 * two-point scale pick on the picture.
 */
export function placeImage(
  image: ImageSlot,
  input: ImagePlacement,
  clicks: string | undefined,
  ctx: InPlaceContext,
  numbers: Record<string, number>
): ImageSlot {
  const plane =
    input.plane?.type === 'canonical'
      ? { ...input.plane, offset: 0 }
      : input.plane;
  if (plane && !samePlane(image.plane, plane)) {
    const basis = ctx.imagePlaneBasis?.(plane) ?? null;
    return {
      ...image,
      plane,
      center:
        basis && input.point
          ? centreAt(basis, input.point, ctx.linearSnap ?? null)
          : { u: 0, v: 0 },
      calibration: []
    };
  }
  const point = input.point;
  const basis = image.plane
    ? (ctx.imagePlaneBasis?.(image.plane) ?? null)
    : null;
  if (!point || !basis) return image;
  if (clicks === 'scale') {
    const shown = numbersOf({ image } as InPlaceSlots, numbers);
    const frame = imageFrame(basis, image.center, shown.rotation, shown.offset);
    const pixel = pixelOf(image, frame, shown.width, point);
    return {
      ...image,
      // A third click starts the pair over.
      calibration:
        image.calibration.length >= 2 ? [pixel] : [...image.calibration, pixel]
    };
  }
  return {
    ...image,
    center: centreAt(basis, point, ctx.linearSnap ?? null),
    // The scale picks were on the picture where it stood.
    calibration: []
  };
}

/**
 * A clicked point in the plane's (u, v), rounded to the sketch snap as a
 * clicked hole is, so a placement can be exact.
 */
function centreAt(
  basis: PlaneBasis,
  point: Vector3,
  snap: number | null
): { u: number; v: number } {
  const local = add(point, basis.origin, -1);
  const round = (value: number) =>
    snap && snap > 0
      ? Number((Math.round(value / snap) * snap).toPrecision(12))
      : value;
  return { u: round(dot(local, basis.u)), v: round(dot(local, basis.v)) };
}

/**
 * The plane a click lands on while the picture has one: its own plane,
 * slid by the offset shown. Null while a plane is still to be picked.
 */
export function imagePlacementPlane(
  slots: InPlaceSlots,
  options: Record<string, string>,
  ctx: InPlaceContext,
  numbers: Record<string, number>
): { origin: Vector3; normal: Vector3 } | null {
  const image = slots.image;
  if (!image?.plane || options.clicks === 'plane') return null;
  const basis = ctx.imagePlaneBasis?.(image.plane);
  if (!basis) return null;
  const shown = numbersOf(slots, numbers);
  const frame = imageFrame(basis, image.center, shown.rotation, shown.offset);
  return { origin: frame.center, normal: frame.normal };
}

export const referenceImage: InPlaceToolSpec = {
  id: 'reference-image',
  title: 'Image',
  profileMode: 'none',
  instant: true,
  wantsAxis: false,
  wantsPath: false,
  values: [
    {
      id: 'width',
      label: 'Width',
      unit: 'length',
      initial: 100,
      min: 1e-3,
      max: MAX_REFERENCE_IMAGE_EXTENT
    },
    {
      // Counter-clockwise about the plane normal, as the card's Rotation.
      id: 'rotation',
      label: 'Turn',
      unit: 'angle',
      initial: 0,
      min: -360,
      max: 360
    },
    {
      id: 'offset',
      label: 'Offset',
      unit: 'length',
      initial: 0,
      min: -MAX_REFERENCE_IMAGE_EXTENT,
      max: MAX_REFERENCE_IMAGE_EXTENT
    },
    {
      // The real distance between the two scale picks: setting it sets the
      // width that makes them that far apart.
      id: 'span',
      label: 'Distance',
      unit: 'length',
      initial: 1,
      min: 1e-6,
      max: MAX_REFERENCE_IMAGE_EXTENT
    }
  ],
  options: [
    {
      id: 'clicks',
      label: 'Clicks',
      choices: [
        { value: 'place', label: 'Move it' },
        { value: 'plane', label: 'Pick a plane' },
        { value: 'scale', label: 'Scale from 2 points' }
      ],
      initial: 'place'
    },
    {
      id: 'opacity',
      label: 'Opacity',
      choices: OPACITIES.map((opacity) => ({
        value: String(opacity),
        label: `${Math.round(opacity * 100)}%`
      })),
      initial: '0.6'
    }
  ],
  defaults(slots): Record<string, number> {
    const image = slots.image;
    return image ? { width: image.record.width } : {};
  },
  linked: {
    span: {
      read(slots, numbers) {
        const image = slots.image;
        return image ? spanAt(image, numbersOf(slots, numbers).width) : null;
      },
      write(slots, _numbers, value) {
        const image = slots.image;
        const [first, second] = image?.calibration ?? [];
        if (!image || !first || !second) return null;
        const width = calibratedReferenceImageWidth(
          image.record,
          first,
          second,
          value
        );
        return width === null ? null : { width };
      }
    }
  },
  hint(slots, options) {
    const image = slots.image;
    const name = image?.record.name ?? 'the picture';
    if (!image?.plane || options?.clicks === 'plane')
      return `Pick a plane or a flat face for ${name}`;
    if (options?.clicks === 'scale') {
      const picked = image.calibration.length;
      if (picked === 0) return 'Click the first of two points on the picture';
      if (picked === 1) return 'Click the second point on the picture';
      return `Tap the distance to type how far apart they really are · ${FINISH}`;
    }
    return `Click to move it · drag the corner to scale, the ring to turn · ${FINISH}`;
  },
  ready: (slots) => Boolean(slots.image?.plane),
  request(slots, _values, options, _ctx, numbers) {
    const image = slots.image;
    if (!image?.plane) return null;
    const shown = numbersOf(slots, numbers ?? {});
    const opacity = Number(options.opacity ?? image.record.opacity);
    return {
      tool: 'reference-image',
      image: {
        ...image.record,
        plane:
          image.plane.type === 'canonical'
            ? { ...image.plane, offset: shown.offset }
            : image.plane,
        center: { ...image.center },
        rotationDeg: shown.rotation,
        width: shown.width,
        opacity: Number.isFinite(opacity) ? opacity : image.record.opacity
      }
    };
  },
  handles(slots, values, ctx) {
    const image = slots.image;
    if (!image?.plane) return [];
    const basis = ctx.imagePlaneBasis?.(image.plane);
    if (!basis) return [];
    const shown = numbersOf(slots, values);
    const frame = imageFrame(basis, image.center, shown.rotation, shown.offset);
    const aspect = image.record.pixelHeight / image.record.pixelWidth;
    // Half the diagonal for a width of one: the corner handle sits on the
    // picture's corner at its width.
    const corner = add(
      {
        x: frame.xAxis.x * 0.5,
        y: frame.xAxis.y * 0.5,
        z: frame.xAxis.z * 0.5
      },
      frame.yAxis,
      aspect * 0.5
    );
    const reach = Math.hypot(corner.x, corner.y, corner.z);
    const placed = `${image.record.imageId}:${JSON.stringify(image.plane)}:${image.center.u}:${image.center.v}`;
    const handles: HandleSpec[] = [
      {
        valueId: 'width',
        kind: 'linear',
        key: `${placed}:${shown.rotation}:${shown.offset}:width`,
        params: { origin: frame.center, direction: unit(corner), scale: reach }
      },
      {
        valueId: 'rotation',
        kind: 'angle',
        key: `${placed}:${shown.offset}:${Math.round(shown.width * 1e3)}:rotation`,
        params: {
          center: frame.center,
          axis: frame.normal,
          startDirection: unit(basis.u),
          radius: shown.width * reach * 1.15
        }
      }
    ];
    if (offsets(image.plane)) {
      const base = imageFrame(basis, image.center, 0, 0);
      handles.push({
        valueId: 'offset',
        kind: 'linear',
        key: `${placed}:offset`,
        params: { origin: base.center, direction: frame.normal }
      });
    }
    const [first, second] = image.calibration;
    if (first && second) {
      const a = worldOf(image, frame, shown.width, first);
      const b = worldOf(image, frame, shown.width, second);
      handles.push({
        valueId: 'span',
        kind: 'chip',
        key: `${placed}:span:${first.x}:${first.y}:${second.x}:${second.y}`,
        params: {
          anchor: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
        }
      });
    }
    return handles;
  }
};
