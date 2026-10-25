import { describe, expect, it } from 'vitest';
import type { PlaneBasis } from '@openzcad/geometry';
import type {
  FeatureId,
  ReferenceImage,
  ReferenceImageId,
  ReferenceImagePlane
} from '@openzcad/shared';
import { imagePlacementPlane, placeImage, type ImageSlot } from './image';
import {
  IN_PLACE_TOOL_SPECS,
  type InPlaceContext,
  type InPlaceSlots
} from './tools';

const TOP: PlaneBasis = {
  origin: { x: 0, y: 0, z: 0 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 }
};
const RAISED: PlaneBasis = { ...TOP, origin: { x: 0, y: 0, z: 10 } };

const XY: ReferenceImagePlane = { type: 'canonical', plane: 'XY', offset: 0 };
const DATUM: ReferenceImagePlane = {
  type: 'datum',
  datumFeatureId: 'datum_1' as FeatureId
};

const CTX: InPlaceContext = {
  sketchViews: [],
  datumAxes: undefined,
  datumLabel: () => '',
  imagePlaneBasis: (plane) => (plane.type === 'datum' ? RAISED : TOP)
};

const RECORD: ReferenceImage = {
  imageId: 'image_1' as ReferenceImageId,
  name: 'Drawing',
  contentType: 'image/png',
  source: { checksumSha256: 'abc' },
  artifactId: 'artifact',
  pixelWidth: 200,
  pixelHeight: 100,
  plane: XY,
  center: { u: 0, v: 0 },
  rotationDeg: 0,
  width: 100,
  opacity: 0.6
} as unknown as ReferenceImage;

const UNPLACED: ImageSlot = {
  record: RECORD,
  plane: null,
  center: { u: 0, v: 0 },
  calibration: []
};

const SLOTS: InPlaceSlots = {
  profiles: [],
  axis: null,
  path: [],
  guide: [],
  faces: [],
  bodies: [],
  plane: null,
  refs: [],
  image: null
};

const spec = IN_PLACE_TOOL_SPECS['reference-image'];

describe('placing a picture', () => {
  it('waits for a plane, then centres it where the plane was clicked', () => {
    expect(spec.ready({ ...SLOTS, image: UNPLACED })).toBe(false);
    const placed = placeImage(
      UNPLACED,
      { plane: XY, point: { x: 12, y: -4, z: 0 } },
      'place',
      CTX,
      {}
    );
    expect(placed.plane).toEqual(XY);
    expect(placed.center).toEqual({ u: 12, v: -4 });
    expect(spec.ready({ ...SLOTS, image: placed }, {}, CTX)).toBe(true);
  });

  it('centres on the plane origin when the pick has no point', () => {
    const placed = placeImage(UNPLACED, { plane: DATUM }, 'place', CTX, {});
    expect(placed.center).toEqual({ u: 0, v: 0 });
  });

  it('is not ready on a plane that does not resolve, and says so', () => {
    const unresolved: InPlaceContext = {
      ...CTX,
      imagePlaneBasis: (plane) => (plane.type === 'datum' ? null : TOP)
    };
    const image = { ...UNPLACED, plane: DATUM };
    expect(spec.ready({ ...SLOTS, image }, {}, unresolved)).toBe(false);
    expect(spec.hint({ ...SLOTS, image }, {}, unresolved)).toMatch(
      /no longer resolves/
    );
    expect(spec.ready({ ...SLOTS, image }, {}, CTX)).toBe(true);
  });

  it('moves on a click on its plane, and drops scale picks taken where it stood', () => {
    const placed = placeImage(UNPLACED, { plane: XY }, 'place', CTX, {});
    const moved = placeImage(
      { ...placed, calibration: [{ x: 1, y: 1 }] },
      { point: { x: 5, y: 6, z: 0 } },
      'place',
      CTX,
      {}
    );
    expect(moved.center).toEqual({ u: 5, v: 6 });
    expect(moved.calibration).toEqual([]);
  });

  it('takes clicks as picture pixels while scaling, and a third starts over', () => {
    const placed = placeImage(UNPLACED, { plane: XY }, 'place', CTX, {});
    // 100 wide, 50 tall, centred on the origin: its top-left is (-50, 25).
    const first = placeImage(
      placed,
      { point: { x: -50, y: 25, z: 0 } },
      'scale',
      CTX,
      { width: 100 }
    );
    const second = placeImage(
      first,
      { point: { x: 0, y: 0, z: 0 } },
      'scale',
      CTX,
      { width: 100 }
    );
    expect(second.calibration).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 50 }
    ]);
    expect(second.center).toEqual({ u: 0, v: 0 });
    const third = placeImage(
      second,
      { point: { x: 50, y: -25, z: 0 } },
      'scale',
      CTX,
      { width: 100 }
    );
    expect(third.calibration).toEqual([{ x: 200, y: 100 }]);
  });

  it('measures the picks and sets the width from a real distance', () => {
    const image: ImageSlot = {
      ...UNPLACED,
      plane: XY,
      calibration: [
        { x: 0, y: 0 },
        { x: 100, y: 0 }
      ]
    };
    const link = spec.linked!.span!;
    // 100 of 200 pixels at width 100 is 50 apart.
    expect(link.read({ ...SLOTS, image }, { width: 100 })).toBe(50);
    expect(link.write({ ...SLOTS, image }, { width: 100 }, 25)).toEqual({
      width: 50
    });
    expect(
      link.write({ ...SLOTS, image: { ...image, calibration: [] } }, {}, 25)
    ).toBeNull();
  });

  it('adds the picture as placed, with a principal plane offset and the chosen opacity', () => {
    const image = placeImage(
      UNPLACED,
      { plane: XY, point: { x: 1, y: 2, z: 0 } },
      'place',
      CTX,
      {}
    );
    const request = spec.request(
      { ...SLOTS, image },
      {},
      { opacity: '0.4' },
      CTX,
      { width: 40, rotation: 30, offset: 3, span: 1 }
    );
    expect(request).toEqual({
      tool: 'reference-image',
      image: {
        ...RECORD,
        plane: { ...XY, offset: 3 },
        center: { u: 1, v: 2 },
        rotationDeg: 30,
        width: 40,
        opacity: 0.4
      }
    });
  });

  it('keeps a datum plane as it is: only a principal plane stores an offset', () => {
    const image = placeImage(UNPLACED, { plane: DATUM }, 'place', CTX, {});
    const request = spec.request({ ...SLOTS, image }, {}, {}, CTX, {
      width: 40,
      rotation: 0,
      offset: 3
    });
    expect(request).toMatchObject({ image: { plane: DATUM } });
    const handles = spec.handles({ ...SLOTS, image }, { width: 40 }, CTX, {});
    expect(handles.map((handle) => handle.valueId)).toEqual([
      'width',
      'rotation'
    ]);
  });

  it('stands the corner handle on the corner and the offset handle on the plane', () => {
    const image = placeImage(UNPLACED, { plane: XY }, 'place', CTX, {});
    const handles = spec.handles(
      { ...SLOTS, image },
      { width: 100, rotation: 0, offset: 7 },
      CTX,
      {}
    );
    const width = handles.find((handle) => handle.valueId === 'width');
    expect(width?.kind).toBe('linear');
    if (width?.kind !== 'linear') return;
    const reach = (width.params.scale ?? 1) * 100;
    const corner = {
      x: width.params.origin.x + width.params.direction.x * reach,
      y: width.params.origin.y + width.params.direction.y * reach
    };
    expect(corner.x).toBeCloseTo(50);
    expect(corner.y).toBeCloseTo(25);
    expect(width.params.origin.z).toBeCloseTo(7);
    const offset = handles.find((handle) => handle.valueId === 'offset');
    expect(offset).toMatchObject({
      kind: 'linear',
      params: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }
    });
  });

  it('arms a placement plane only once a plane is picked, and not while re-picking one', () => {
    expect(
      imagePlacementPlane({ ...SLOTS, image: UNPLACED }, {}, CTX, {})
    ).toBeNull();
    const image = placeImage(UNPLACED, { plane: DATUM }, 'place', CTX, {});
    expect(
      imagePlacementPlane({ ...SLOTS, image }, { clicks: 'place' }, CTX, {})
    ).toEqual({ origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: 1 } });
    expect(
      imagePlacementPlane({ ...SLOTS, image }, { clicks: 'plane' }, CTX, {})
    ).toBeNull();
  });
});
