import { describe, expect, it } from 'vitest';
import {
  computeSketchRegions,
  regionAtPoint,
  type SketchRegionObject
} from '@openzcad/geometry';
import type { ParamValue } from '@openzcad/shared';

const resolve = (value: ParamValue): number =>
  typeof value === 'number' ? value : Number(value);

let nextId = 0;
function object(data: SketchRegionObject['data']): SketchRegionObject {
  nextId += 1;
  return { id: `obj_${nextId}`, data };
}

function circle(radius: number, centerX = 0, centerY = 0): SketchRegionObject {
  return object({ objectKind: 'circle', radius, centerX, centerY });
}

function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): SketchRegionObject {
  return object({ objectKind: 'line', x1, y1, x2, y2 });
}

function rectangle(
  width: number,
  height: number,
  centerX = 0,
  centerY = 0
): SketchRegionObject {
  return object({ objectKind: 'rectangle', width, height, centerX, centerY });
}

describe('computeSketchRegions', () => {
  it('finds the disk of a single circle', () => {
    const regions = computeSketchRegions([circle(10)], resolve);
    expect(regions).toHaveLength(1);
    const disk = regions[0]!;
    expect(disk.holes).toHaveLength(0);
    expect(disk.area).toBeCloseTo(Math.PI * 100, 0);
    expect(
      Math.hypot(disk.samplePoint.x, disk.samplePoint.y)
    ).toBeLessThan(10);
  });

  it('detects the ring between concentric circles as a region with a hole', () => {
    const regions = computeSketchRegions([circle(63), circle(40)], resolve);
    expect(regions).toHaveLength(2);
    const [ring, disk] = regions;
    expect(ring!.holes).toHaveLength(1);
    expect(ring!.area).toBeCloseTo(Math.PI * (63 * 63 - 40 * 40), -1);
    expect(disk!.holes).toHaveLength(0);
    expect(disk!.area).toBeCloseTo(Math.PI * 40 * 40, -1);
    // The ring's sample point is between the circles.
    const radius = Math.hypot(ring!.samplePoint.x, ring!.samplePoint.y);
    expect(radius).toBeGreaterThan(40);
    expect(radius).toBeLessThan(63);
  });

  it('splits a disk into two pieces with a chord', () => {
    const regions = computeSketchRegions(
      [circle(10), line(-15, 0, 15, 0)],
      resolve
    );
    expect(regions).toHaveLength(2);
    const [top, bottom] = regions;
    expect(top!.area + bottom!.area).toBeCloseTo(Math.PI * 100, 0);
    expect(top!.area).toBeCloseTo(bottom!.area, 0);
    // Chord along y=0: one piece samples above, the other below.
    const ys = regions.map((region) => Math.sign(region.samplePoint.y)).sort();
    expect(ys).toEqual([-1, 1]);
  });

  it('splits a rectangle with a line into two regions', () => {
    const regions = computeSketchRegions(
      [rectangle(40, 20), line(0, -15, 0, 15)],
      resolve
    );
    expect(regions).toHaveLength(2);
    expect(regions[0]!.area).toBeCloseTo(400, 0);
    expect(regions[1]!.area).toBeCloseTo(400, 0);
  });

  it('handles the reference scene: rectangle, two circles, and a chord', () => {
    // A rectangle around two concentric circles, with a line cutting the
    // inner disk — the crescent + wedge scene from the design reference.
    const regions = computeSketchRegions(
      [rectangle(160, 150), circle(63), circle(40), line(-70, -20, 70, 30)],
      resolve
    );
    // rectangle-minus-outer-circle, ring split in two, inner disk split in two.
    expect(regions.length).toBe(5);
    const total = regions.reduce((sum, region) => sum + region.area, 0);
    expect(total).toBeCloseTo(160 * 150, 0);
    const withHoles = regions.filter((region) => region.holes.length > 0);
    expect(withHoles).toHaveLength(1);
    expect(withHoles[0]!.holes).toHaveLength(1);
  });

  it('ignores open curves that close nothing', () => {
    expect(computeSketchRegions([line(0, 0, 10, 0)], resolve)).toHaveLength(0);
    expect(
      computeSketchRegions(
        [line(0, 0, 10, 0), line(10, 0, 10, 10)],
        resolve
      )
    ).toHaveLength(0);
  });

  it('closes a triangle drawn from three chained lines', () => {
    const regions = computeSketchRegions(
      [line(0, 0, 20, 0), line(20, 0, 10, 15), line(10, 15, 0, 0)],
      resolve
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(150, 0);
  });

  it('keeps fingerprints stable across object order and traversal direction', () => {
    const a = computeSketchRegions([circle(63), circle(40)], resolve);
    const b = computeSketchRegions([circle(40), circle(63)], resolve);
    expect(a.map((region) => region.regionFingerprint).sort()).toEqual(
      b.map((region) => region.regionFingerprint).sort()
    );
  });

  it('changes fingerprints when geometry changes', () => {
    const before = computeSketchRegions([circle(10)], resolve);
    const after = computeSketchRegions([circle(11)], resolve);
    expect(before[0]!.regionFingerprint).not.toBe(
      after[0]!.regionFingerprint
    );
  });

  it('supports arcs closed by a chord', () => {
    // Half-disc: 180° arc plus its diameter.
    const regions = computeSketchRegions(
      [
        object({
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 10,
          startAngleDeg: 0,
          endAngleDeg: 180
        }),
        line(-10, 0, 10, 0)
      ],
      resolve
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo((Math.PI * 100) / 2, 0);
    expect(regions[0]!.samplePoint.y).toBeGreaterThan(0);
  });

  it('registers a chord crossing a wrapped non-full arc start', () => {
    const endpoint = Math.sqrt(50);
    const regions = computeSketchRegions(
      [
        object({
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 10,
          startAngleDeg: 225,
          endAngleDeg: 315
        }),
        line(-endpoint, -endpoint, endpoint, -endpoint)
      ],
      resolve
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]!.area).toBeCloseTo(50 * (Math.PI / 2 - 1), 1);
  });

  it('nests holes through multiple levels', () => {
    const regions = computeSketchRegions(
      [rectangle(100, 100), circle(30), circle(15)],
      resolve
    );
    // rect-with-circle-hole, ring-with-hole, inner disk.
    expect(regions).toHaveLength(3);
    expect(regions[0]!.holes).toHaveLength(1);
    expect(regions[1]!.holes).toHaveLength(1);
    expect(regions[2]!.holes).toHaveLength(0);
  });
});

describe('regionAtPoint', () => {
  it('picks the smallest region containing the point', () => {
    const regions = computeSketchRegions([circle(63), circle(40)], resolve);
    const inner = regionAtPoint(regions, { x: 0, y: 0 });
    expect(inner?.holes).toHaveLength(0);
    const ring = regionAtPoint(regions, { x: 50, y: 0 });
    expect(ring?.holes).toHaveLength(1);
    expect(regionAtPoint(regions, { x: 100, y: 100 })).toBeNull();
  });
});
