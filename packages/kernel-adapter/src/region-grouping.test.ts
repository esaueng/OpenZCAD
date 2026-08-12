/**
 * `connectedRegionGroups` after the switch from pairwise comparison to
 * signature bucketing.
 *
 * The relation is unchanged — "these two cells share a canonical boundary
 * piece" — so the components must be identical to what the old
 * `profilesShareBoundary` sweep produced. What changed is the cost: the sweep
 * rebuilt one profile's whole signature set once per pair, which is quadratic
 * in the number of profiles and quadratic again in their curves. A text
 * object contributes one profile per glyph region and none of them can ever
 * share a boundary, so a two-line label paid that entire cost for a
 * guaranteed-empty answer.
 *
 * These tests pin the behaviour, not the speed: every case is checked against
 * an independent brute-force implementation of the same relation.
 */
import { describe, expect, it } from 'vitest';
import {
  computeSketchRegions,
  profilesShareBoundary,
  type RegionCurve,
  type RegionLoop,
  type SketchProfile,
  type SketchRegionObject,
  type Vec2Like
} from '@openzcad/geometry';
import type { ParamValue } from '@openzcad/shared';
import { connectedRegionGroups } from './region-profile';

const resolve = (value: ParamValue): number =>
  typeof value === 'number' ? value : Number(value);

/**
 * The original definition, transcribed. Slow on purpose — it is the
 * specification the bucketed implementation has to agree with.
 */
function bruteForceGroups(profiles: SketchProfile[]): SketchProfile[][] {
  const remaining = new Set(profiles);
  const groups: SketchProfile[][] = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as SketchProfile;
    remaining.delete(seed);
    const group = [seed];
    for (let index = 0; index < group.length; index += 1) {
      const current = group[index]!;
      for (const candidate of [...remaining]) {
        if (profilesShareBoundary(current, candidate)) {
          remaining.delete(candidate);
          group.push(candidate);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/** Group membership as comparable sets of profile ids, order-independent. */
function membership(groups: SketchProfile[][]): string[][] {
  return groups
    .map((group) => group.map((profile) => profile.profileId).sort())
    .sort((left, right) => (left.join('|') < right.join('|') ? -1 : 1));
}

function loopOf(points: Vec2Like[], sourceObjectId: string): RegionLoop {
  const curves: RegionCurve[] = points.map((point, index) => ({
    kind: 'line',
    a: point,
    b: points[(index + 1) % points.length]!,
    sourceObjectId
  }));
  return { curves, polyline: points };
}

let nextId = 0;

/** A profile carrying only what `connectedRegionGroups` reads. */
function profileOf(points: Vec2Like[]): SketchProfile {
  nextId += 1;
  const sourceObjectId = `obj_${nextId}`;
  return {
    profileId: `profile_${nextId}`,
    regionFingerprint: nextId,
    sourceEntityIds: [sourceObjectId],
    outer: loopOf(points, sourceObjectId),
    holes: [],
    signedArea: 1,
    area: 1,
    centroid: { x: 0, y: 0 },
    boundingBox: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } },
    validity: 'valid',
    diagnostics: [],
    samplePoint: { x: 0, y: 0 }
  };
}

/** Unit square with its lower-left corner at (column, row). */
function cell(column: number, row: number): SketchProfile {
  return profileOf([
    { x: column, y: row },
    { x: column + 1, y: row },
    { x: column + 1, y: row + 1 },
    { x: column, y: row + 1 }
  ]);
}

describe('connectedRegionGroups', () => {
  it('joins cells that share an edge and separates ones that do not', () => {
    const touching = [cell(0, 0), cell(1, 0)];
    expect(connectedRegionGroups(touching)).toHaveLength(1);

    const apart = [cell(0, 0), cell(5, 0)];
    expect(connectedRegionGroups(apart)).toHaveLength(2);
  });

  it('joins a chain transitively, through a cell it does not touch', () => {
    // A—B—C where A and C share nothing: the middle cell is what makes them
    // one component, which is exactly what a union-find has to get right.
    const chain = [cell(0, 0), cell(2, 0), cell(1, 0)];
    const groups = connectedRegionGroups(chain);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
    expect(membership(groups)).toEqual(membership(bruteForceGroups(chain)));
  });

  it('returns groups in first-appearance order, members in input order', () => {
    const profiles = [cell(9, 0), cell(0, 0), cell(1, 0), cell(4, 0)];
    const groups = connectedRegionGroups(profiles);
    expect(groups.map((group) => group.map((p) => p.profileId))).toEqual([
      [profiles[0]!.profileId],
      [profiles[1]!.profileId, profiles[2]!.profileId],
      [profiles[3]!.profileId]
    ]);
  });

  it('agrees with the pairwise definition across a randomized sweep', () => {
    // A deterministic LCG: the same 200 layouts every run, so a disagreement
    // is reproducible rather than a one-off CI flake.
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const count = 2 + Math.floor(random() * 7);
      const profiles = Array.from({ length: count }, () =>
        cell(Math.floor(random() * 4), Math.floor(random() * 4))
      );
      expect(membership(connectedRegionGroups(profiles))).toEqual(
        membership(bruteForceGroups(profiles))
      );
    }
  });

  it('leaves every glyph region of a real sketch in its own group', () => {
    // The case the rewrite exists for. Two overlapping rectangles produce
    // arrangement cells that DO share boundaries, so the same call has to
    // keep joining those while never pairing the glyph regions with anything.
    const objects: SketchRegionObject[] = [
      {
        id: 'rect_1',
        data: {
          objectKind: 'rectangle',
          width: 40,
          height: 20,
          centerX: 0,
          centerY: 0
        }
      },
      {
        id: 'line_1',
        data: {
          objectKind: 'line',
          x1: 0,
          y1: -15,
          x2: 0,
          y2: 15
        }
      }
    ];
    const profiles = computeSketchRegions(objects, resolve);
    // The chord splits the rectangle into two cells that share it.
    expect(profiles).toHaveLength(2);
    expect(connectedRegionGroups(profiles)).toHaveLength(1);
    expect(membership(connectedRegionGroups(profiles))).toEqual(
      membership(bruteForceGroups(profiles))
    );

    // Glyph-shaped profiles: disjoint, and each its own solid.
    const glyphs = [cell(0, 0), cell(2, 0), cell(4, 0), cell(6, 0)];
    const groups = connectedRegionGroups(glyphs);
    expect(groups).toHaveLength(glyphs.length);
    expect(groups.every((group) => group.length === 1)).toBe(true);
  });
});
