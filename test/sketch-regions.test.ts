import { describe, expect, it } from 'vitest';
import {
  computeSketchProfileAnalysis,
  computeSketchRegions,
  mergeAdjacentProfiles,
  profileContainsPoint,
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
    expect(Math.hypot(disk.samplePoint.x, disk.samplePoint.y)).toBeLessThan(10);
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

  it('discovers every independently selectable cell from two overlapping circles', () => {
    const regions = computeSketchRegions(
      [circle(10, -5, 0), circle(10, 5, 0)],
      resolve
    );
    expect(regions).toHaveLength(3);
    expect(regionAtPoint(regions, { x: -8, y: 0 })?.area).toBeGreaterThan(0);
    expect(regionAtPoint(regions, { x: 0, y: 0 })?.area).toBeGreaterThan(0);
    expect(regionAtPoint(regions, { x: 8, y: 0 })?.area).toBeGreaterThan(0);
    const profileIds = new Set(regions.map((region) => region.profileId));
    expect(profileIds.size).toBe(3);

    const left = regionAtPoint(regions, { x: -8, y: 0 })!;
    const lens = regionAtPoint(regions, { x: 0, y: 0 })!;
    const merged = mergeAdjacentProfiles([left, lens]);
    expect(merged.area).toBeCloseTo(Math.PI * 100, 6);
    expect(merged.holes).toHaveLength(0);
  });

  it('discovers every bounded cell from three overlapping circles', () => {
    const regions = computeSketchRegions(
      [circle(10, -8, 0), circle(10, 0, 0), circle(10, 8, 0)],
      resolve
    );
    expect(regions.length).toBeGreaterThanOrEqual(5);
    expect(new Set(regions.map((region) => region.profileId)).size).toBe(
      regions.length
    );
    expect(regionAtPoint(regions, { x: -12, y: 0 })).not.toBeNull();
    expect(regionAtPoint(regions, { x: 0, y: 0 })).not.toBeNull();
    expect(regionAtPoint(regions, { x: 12, y: 0 })).not.toBeNull();
  });

  it('does not invent a micro-profile at tangent or near-tangent contact', () => {
    const tangent = computeSketchRegions(
      [circle(10, -10, 0), circle(10, 10, 0)],
      resolve
    );
    const tolerance = 1e-5;
    const nearTangent = computeSketchRegions(
      [circle(10, -10 - tolerance / 4, 0), circle(10, 10, 0)],
      resolve,
      tolerance
    );
    expect(tangent).toHaveLength(2);
    expect(nearTangent).toHaveLength(2);
    expect(
      nearTangent.every((profile) => profile.area > tolerance * tolerance)
    ).toBe(true);
  });

  it('keeps multiple disconnected profiles independent', () => {
    const regions = computeSketchRegions(
      [circle(4, -20, 0), rectangle(6, 8, 20, 0)],
      resolve
    );
    expect(regions).toHaveLength(2);
    expect(regionAtPoint(regions, { x: -20, y: 0 })?.area).toBeCloseTo(
      Math.PI * 16,
      6
    );
    expect(regionAtPoint(regions, { x: 20, y: 0 })?.area).toBeCloseTo(48, 6);
  });

  it('keeps the inner disk and annulus as distinct point-testable profiles', () => {
    const regions = computeSketchRegions([circle(20), circle(8)], resolve);
    const disk = regionAtPoint(regions, { x: 0, y: 0 });
    const annulus = regionAtPoint(regions, { x: 12, y: 0 });
    expect(disk).not.toBeNull();
    expect(annulus?.holes).toHaveLength(1);
    expect(profileContainsPoint(annulus!, { x: 0, y: 0 })).toBe(false);
    expect(profileContainsPoint(annulus!, { x: 12, y: 0 })).toBe(true);
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

  it('does not let construction geometry split or bound profiles', () => {
    const divider = line(0, -15, 0, 15);
    divider.data.construction = true;
    const analysis = computeSketchProfileAnalysis(
      [rectangle(40, 20), divider],
      resolve
    );
    expect(analysis.profiles).toHaveLength(1);
    expect(analysis.profiles[0]!.area).toBeCloseTo(800, 6);
    expect(
      analysis.diagnostics.some(
        (diagnostic) => diagnostic.code === 'construction-excluded'
      )
    ).toBe(true);
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
      computeSketchRegions([line(0, 0, 10, 0), line(10, 0, 10, 10)], resolve)
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

  it('keeps profile ids stable for the same entities in a different array order', () => {
    const outer = circle(63);
    const inner = circle(40);
    const forward = computeSketchRegions([outer, inner], resolve);
    const reverse = computeSketchRegions([inner, outer], resolve);
    expect(forward.map((profile) => profile.profileId).sort()).toEqual(
      reverse.map((profile) => profile.profileId).sort()
    );
  });

  it('changes fingerprints when geometry changes', () => {
    const before = computeSketchRegions([circle(10)], resolve);
    const after = computeSketchRegions([circle(11)], resolve);
    expect(before[0]!.regionFingerprint).not.toBe(after[0]!.regionFingerprint);
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

  it('distinguishes complementary arc boundaries in stable fingerprints', () => {
    const short = computeSketchRegions(
      [
        object({
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 10,
          startAngleDeg: 0,
          endAngleDeg: 90
        }),
        line(0, 10, 10, 0)
      ],
      resolve
    );
    const long = computeSketchRegions(
      [
        object({
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 10,
          startAngleDeg: 90,
          endAngleDeg: 360
        }),
        line(0, 10, 10, 0)
      ],
      resolve
    );
    expect(short).toHaveLength(1);
    expect(long).toHaveLength(1);
    expect(short[0]!.regionFingerprint).not.toBe(long[0]!.regionFingerprint);
    expect(short[0]!.profileId).not.toBe(long[0]!.profileId);
  });

  it('distinguishes complementary semicircles and joins them into a disk', () => {
    const upper = object({
      objectKind: 'arc',
      centerX: 0,
      centerY: 0,
      radius: 10,
      startAngleDeg: 0,
      endAngleDeg: 180
    });
    const lower = object({
      objectKind: 'arc',
      centerX: 0,
      centerY: 0,
      radius: 10,
      startAngleDeg: 180,
      endAngleDeg: 360
    });
    const diameter = line(-10, 0, 10, 0);
    const upperProfile = computeSketchRegions([upper, diameter], resolve);
    const lowerProfile = computeSketchRegions([lower, diameter], resolve);
    expect(upperProfile).toHaveLength(1);
    expect(lowerProfile).toHaveLength(1);
    expect(upperProfile[0]!.regionFingerprint).not.toBe(
      lowerProfile[0]!.regionFingerprint
    );
    expect(upperProfile[0]!.profileId).not.toBe(lowerProfile[0]!.profileId);

    const disk = computeSketchRegions([upper, lower], resolve);
    expect(disk).toHaveLength(1);
    expect(disk[0]!.area).toBeCloseTo(Math.PI * 100, 6);
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

  it('reports a near-tolerance open gap without inventing a profile', () => {
    const gap = 3e-6;
    const analysis = computeSketchProfileAnalysis(
      [
        line(0, 0, 10, 0),
        line(10, 0, 10, 10),
        line(10, 10, 0, 10),
        line(0, 10, 0, gap)
      ],
      resolve
    );
    expect(analysis.profiles).toHaveLength(0);
    expect(
      analysis.diagnostics.some(
        (diagnostic) => diagnostic.code === 'gap-within-tolerance'
      )
    ).toBe(true);
  });

  it('rejects duplicate boundary segments with an explicit diagnostic', () => {
    const bottom = line(0, 0, 10, 0);
    const duplicate = line(10, 0, 0, 0);
    const analysis = computeSketchProfileAnalysis(
      [
        bottom,
        line(10, 0, 10, 10),
        line(10, 10, 0, 10),
        line(0, 10, 0, 0),
        duplicate
      ],
      resolve
    );
    expect(analysis.profiles).toHaveLength(0);
    expect(
      analysis.diagnostics.some(
        (diagnostic) => diagnostic.code === 'duplicate-entity'
      )
    ).toBe(true);
  });

  it('rejects a self-intersecting polygon with a focused diagnostic', () => {
    const analysis = computeSketchProfileAnalysis(
      [
        object({
          objectKind: 'polygon',
          sides: 4,
          radius: 10,
          centerX: 0,
          centerY: 0
        })
      ],
      resolve
    );
    expect(analysis.profiles).toHaveLength(1);

    const bowTie = object({
      objectKind: 'rectangle',
      width: 1,
      height: 1,
      centerX: 0,
      centerY: 0
    });
    // A custom polygon is not yet a persisted sketch primitive. Four segments
    // with one shared source model the same invalid single-entity boundary.
    const sourceId = bowTie.id;
    const selfCrossing = [
      { id: sourceId, data: line(-10, -10, 10, 10).data },
      { id: sourceId, data: line(10, 10, -10, 10).data },
      { id: sourceId, data: line(-10, 10, 10, -10).data },
      { id: sourceId, data: line(10, -10, -10, -10).data }
    ];
    const invalid = computeSketchProfileAnalysis(selfCrossing, resolve);
    expect(invalid.profiles).toHaveLength(0);
    expect(
      invalid.diagnostics.some(
        (diagnostic) => diagnostic.code === 'self-intersection'
      )
    ).toBe(true);
  });

  it('carries source ids, centroid, bounds, and positive signed area', () => {
    const source = rectangle(20, 10, 5, -3);
    const profile = computeSketchRegions([source], resolve)[0]!;
    expect(profile.sourceEntityIds).toEqual([source.id]);
    expect(profile.centroid.x).toBeCloseTo(5, 6);
    expect(profile.centroid.y).toBeCloseTo(-3, 6);
    expect(profile.boundingBox).toEqual({
      min: { x: -5, y: -8 },
      max: { x: 15, y: 2 }
    });
    expect(profile.signedArea).toBeCloseTo(200, 6);
    expect(profile.validity).toBe('valid');
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
