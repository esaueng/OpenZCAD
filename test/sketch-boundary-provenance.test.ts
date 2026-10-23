import { describe, expect, it } from 'vitest';
import {
  computeSketchProfileAnalysis,
  computeSketchRegions,
  geometryTolerance,
  mergeAdjacentProfiles,
  profileContainsPoint,
  resolveBoundaryProfileReference,
  type SketchRegion,
  type SketchRegionObject
} from '@openzcad/geometry';
import {
  boundaryProvenanceEqual,
  makeSketchCompositeBoundaryToken,
  parseSketchBoundaryToken,
  type ParamValue
} from '@openzcad/shared';

const scalar = (value: ParamValue) =>
  typeof value === 'number' ? value : Number(value);
const rectangle = (
  id: string,
  width = 20,
  height = 12,
  centerX = 0,
  centerY = 0
): SketchRegionObject => ({
  id,
  data: { objectKind: 'rectangle', width, height, centerX, centerY }
});
const token = (id: string, edge: number, count = 4) =>
  makeSketchCompositeBoundaryToken(
    id,
    { kind: count === 4 ? 'rectangle' : 'regular-polygon', version: 1, count },
    edge
  );
const reference = (profile: SketchRegion) => ({
  sourceBoundaryLoops: profile.sourceBoundaryLoops!,
  sourceArea: profile.area,
  samplePoint: profile.samplePoint
});

function profile(objects: SketchRegionObject[]): SketchRegion {
  const profiles = computeSketchRegions(objects, scalar);
  expect(profiles).toHaveLength(1);
  return profiles[0]!;
}

describe('legacy composite authored boundary provenance', () => {
  it('names canonical rectangle sides without changing geometric fingerprints or physical source IDs', () => {
    const before = profile([rectangle('rect_A')]);
    expect(before.sourceBoundaryLoops).toEqual({
      outer: [0, 1, 2, 3].map((edge) => token('rect_A', edge)),
      holes: []
    });
    const after = profile([rectangle('rect_A', 30)]);
    expect(after.area).toBeCloseTo(360, 9);
    expect(after.sourceBoundaryLoops).toEqual(before.sourceBoundaryLoops);
    expect(after.sourceEntityIds).toEqual(['rect_A']);
    expect(after.regionFingerprint).not.toBe(before.regionFingerprint);
    expect(after.profileId).not.toBe(before.profileId);
    expect(
      resolveBoundaryProfileReference(
        reference(before),
        [after],
        geometryTolerance(30),
        profileContainsPoint
      )
    ).toBe(after);
  });

  it.each([3, 6, 64])(
    'preserves each of a regular polygon’s %i authored sides across radius/center changes',
    (sides) => {
      const polygon = (
        radius: number,
        centerX: number
      ): SketchRegionObject => ({
        id: 'polygon_A',
        data: { objectKind: 'polygon', sides, radius, centerX, centerY: 0 }
      });
      const before = profile([polygon(10, 0)]);
      const after = profile([polygon(20, 30)]);
      expect(after.sourceBoundaryLoops).toEqual(before.sourceBoundaryLoops);
      expect(after.sourceBoundaryLoops!.outer).toHaveLength(sides);
      expect(new Set(after.sourceBoundaryLoops!.outer).size).toBe(sides);
      expect(
        after.sourceBoundaryLoops!.outer.every((value) => {
          const parsed = parseSketchBoundaryToken(value);
          return (
            parsed?.kind === 'composite' &&
            parsed.topology.kind === 'regular-polygon' &&
            parsed.topology.count === sides
          );
        })
      ).toBe(true);
    }
  );

  it('preserves outer/hole roles and primitive circle identity in mixed profiles', () => {
    const objects: SketchRegionObject[] = [
      rectangle('outer_rect', 20, 20),
      rectangle('inner_rect', 6, 4),
      {
        id: 'circle_A',
        data: { objectKind: 'circle', radius: 1, centerX: 6, centerY: 0 }
      }
    ];
    const ring = computeSketchRegions(objects, scalar).find(
      (p) => p.holes.length === 2
    )!;
    expect(ring.area).toBeCloseTo(400 - 24 - Math.PI, 9);
    expect(ring.sourceBoundaryLoops).toEqual({
      outer: [0, 1, 2, 3].map((edge) => token('outer_rect', edge)),
      holes: [
        [0, 1, 2, 3].map((edge) => token('inner_rect', edge)),
        ['p1/circle_A/circle']
      ]
    });
    const reordered = computeSketchRegions([...objects].reverse(), scalar).find(
      (p) => p.holes.length === 2
    )!;
    expect(reordered.sourceBoundaryLoops).toEqual(ring.sourceBoundaryLoops);
    expect(reordered.profileId).toBe(ring.profileId);
    expect(reordered.regionFingerprint).toBe(ring.regionFingerprint);
    const circleOnly = profile([objects[2]!]);
    expect(circleOnly).not.toHaveProperty('sourceBoundaryLoops');
    expect(circleOnly.outer.curves[0]!.boundaryToken).toBe(
      'p1/circle_A/circle'
    );
    const unqualifiedHole = computeSketchRegions(
      [objects[0]!, { ...objects[2]!, id: 'unqualified/source' }],
      scalar
    ).find((p) => p.holes.length === 1)!;
    expect(unqualifiedHole.area).toBeCloseTo(400 - Math.PI, 9);
    expect(unqualifiedHole).not.toHaveProperty('sourceBoundaryLoops');
  });

  it('retains repeated tokens from one edge split into multiple boundary pieces, including merged cells', () => {
    const cells = computeSketchRegions(
      [rectangle('rect_A', 20, 20), rectangle('rect_B', 10, 40, 10)],
      scalar
    );
    expect(cells).toHaveLength(3);
    const repeated = cells.find(
      (p) =>
        p.sourceBoundaryLoops!.outer.filter((t) => t === token('rect_B', 3))
          .length === 2
    )!;
    expect(repeated).toBeDefined();
    expect(repeated.area).toBeCloseTo(300, 9);
    const merged = mergeAdjacentProfiles(cells);
    expect(merged.area).toBeCloseTo(700, 9);
    expect(
      merged.sourceBoundaryLoops!.outer.filter((t) => t === token('rect_B', 3))
    ).toHaveLength(2);
    const changedMultiplicity = {
      ...reference(repeated),
      sourceBoundaryLoops: {
        ...repeated.sourceBoundaryLoops!,
        outer: repeated.sourceBoundaryLoops!.outer.filter(
          (t, index, all) =>
            t !== token('rect_B', 3) || all.indexOf(t) === index
        )
      }
    };
    expect(() =>
      resolveBoundaryProfileReference(
        changedMultiplicity,
        [repeated],
        geometryTolerance(40),
        profileContainsPoint
      )
    ).toThrow(/boundary topology no longer matches/);
  });

  it('retains old boundary tokens after explicit promotion while reporting actual generated line IDs', () => {
    const original = profile([rectangle('legacy_rect')]);
    const corners = [
      { x: -15, y: -6 },
      { x: 15, y: -6 },
      { x: 15, y: 6 },
      { x: -15, y: 6 }
    ];
    const edges = corners.map((a, i): SketchRegionObject => ({
      id: `edge_${i}`,
      data: {
        objectKind: 'line',
        x1: a.x,
        y1: a.y,
        x2: corners[(i + 1) % 4]!.x,
        y2: corners[(i + 1) % 4]!.y
      }
    }));
    const aliases = new Map(
      edges.map(({ id }, i) => [id, token('legacy_rect', i)])
    );
    const promoted = computeSketchRegions(edges, scalar, undefined, {
      promotionBoundaryTokens: aliases
    });
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.area).toBeCloseTo(360, 9);
    expect(promoted[0]!.sourceEntityIds).toEqual(edges.map(({ id }) => id));
    expect(
      boundaryProvenanceEqual(
        promoted[0]!.sourceBoundaryLoops!,
        original.sourceBoundaryLoops!
      )
    ).toBe(true);
    expect(
      resolveBoundaryProfileReference(
        reference(original),
        promoted,
        geometryTolerance(30),
        profileContainsPoint
      )
    ).toBe(promoted[0]);
    const partial = new Map(aliases);
    partial.delete('edge_3');
    expect(() =>
      computeSketchProfileAnalysis(edges, scalar, undefined, {
        promotionBoundaryTokens: partial
      })
    ).toThrow(/aliases are partial/);
    const malformed = new Map(aliases);
    malformed.set('edge_3', 'b2/legacy_rect/rectangle/1/4/e/3');
    expect(() =>
      computeSketchProfileAnalysis(edges, scalar, undefined, {
        promotionBoundaryTokens: malformed
      })
    ).toThrow(/aliases are missing, malformed or ambiguous/);
    const mixedTopologies = new Map(aliases);
    mixedTopologies.set(
      'edge_3',
      makeSketchCompositeBoundaryToken(
        'legacy_rect',
        { kind: 'regular-polygon', version: 1, count: 4 },
        3
      )
    );
    expect(() =>
      computeSketchProfileAnalysis(edges, scalar, undefined, {
        promotionBoundaryTokens: mixedTopologies
      })
    ).toThrow(/topology is ambiguous/);
  });

  it('uses geometric witnesses only among exact provenance matches and refuses missing/ambiguous witnesses', () => {
    const left = profile([rectangle('rect_A', 20, 12, -30)]);
    const right = profile([rectangle('rect_A', 20, 12, 30)]);
    expect(
      resolveBoundaryProfileReference(
        reference(left),
        [right, left],
        geometryTolerance(60),
        profileContainsPoint
      )
    ).toBe(left);
    for (const witness of [
      { sourceArea: NaN, samplePoint: left.samplePoint },
      { sourceArea: left.area, samplePoint: { x: Infinity, y: 0 } },
      { sourceArea: left.area, samplePoint: { x: 0, y: 0 } }
    ])
      expect(() =>
        resolveBoundaryProfileReference(
          { ...reference(left), ...witness },
          [left, right],
          geometryTolerance(60),
          profileContainsPoint
        )
      ).toThrow(/Broken profile reference/);
    expect(() =>
      resolveBoundaryProfileReference(
        reference(left),
        [left, left],
        geometryTolerance(60),
        profileContainsPoint
      )
    ).toThrow(/does not resolve uniquely/);
    const wrongTopology = profile([rectangle('other_rect', 20, 12, -30)]);
    expect(() =>
      resolveBoundaryProfileReference(
        reference(left),
        [wrongTopology],
        geometryTolerance(60),
        profileContainsPoint
      )
    ).toThrow(/boundary topology no longer matches/);
  });
});
