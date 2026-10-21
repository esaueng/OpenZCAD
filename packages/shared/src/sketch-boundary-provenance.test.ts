import { describe, expect, it } from 'vitest';
import {
  boundaryProvenanceEqual,
  boundaryProvenanceObjectIds,
  canonicalBoundaryLoop,
  canonicalBoundaryProvenance,
  isBoundaryProvenance,
  isLegacyCompositeTopology,
  makeSketchCompositeBoundaryToken,
  makeSketchPrimitiveBoundaryToken,
  parseSketchBoundaryToken,
  type BoundaryProvenance
} from './sketch-boundary-provenance';

const rectangle = { kind: 'rectangle', version: 1, count: 4 } as const;
const edge = (i: number) =>
  makeSketchCompositeBoundaryToken('ent_rect', rectangle, i);
const line = (id: string) => makeSketchPrimitiveBoundaryToken(id, 'line');

describe('S04 boundary token wire identity', () => {
  it('uses exact legacy source topology and accepts zero-based edge zero', () => {
    expect(edge(0)).toBe('b1/ent_rect/rectangle/1/4/e/0');
    expect(parseSketchBoundaryToken(edge(3))).toEqual({
      kind: 'composite',
      objectId: 'ent_rect',
      topology: rectangle,
      edgeIndex: 3
    });
    const polygon = { kind: 'regular-polygon', version: 1, count: 64 } as const;
    expect(
      parseSketchBoundaryToken(
        makeSketchCompositeBoundaryToken('ent-polygon', polygon, 63)
      )
    ).toEqual({
      kind: 'composite',
      objectId: 'ent-polygon',
      topology: polygon,
      edgeIndex: 63
    });
  });

  it.each(['line', 'circle', 'arc', 'ellipse', 'spline'] as const)(
    'retains primitive %s identity in complete mixed loops',
    (kind) => {
      const token = makeSketchPrimitiveBoundaryToken('ent_curve', kind);
      expect(token).toBe(`p1/ent_curve/${kind}`);
      expect(parseSketchBoundaryToken(token)).toEqual({
        kind: 'primitive',
        objectId: 'ent_curve',
        objectKind: kind
      });
    }
  );

  it.each([
    'b1//rectangle/1/4/e/0',
    'b1/ent.rect/rectangle/1/4/e/0',
    'b1/ent_rect/rectangle/2/4/e/0',
    'b1/ent_rect/rectangle/01/4/e/0',
    'b1/ent_rect/rectangle/1/04/e/0',
    'b1/ent_rect/rectangle/1/4/e/00',
    'b1/ent_rect/rectangle/1/4/e/4',
    'b1/ent_rect/rectangle/1/4/e/-1',
    'b1/ent_rect/rectangle/1/3/e/0',
    'b1/ent_rect/regular-polygon/1/2/e/0',
    'b1/ent_rect/regular-polygon/1/65/e/0',
    'b1/ent_rect/polygon/1/4/e/0',
    'b1/ent_rect/rectangle/1/4/e/0/extra',
    'p2/ent_curve/line',
    'p1/ent_curve/text',
    'p1/ent_curve/line/extra',
    'p1/ent%2Fcurve/line',
    'b1/ent_rect/rectangle/1/4/e/1.5'
  ])('refuses unknown or noncanonical token %s', (token) => {
    expect(parseSketchBoundaryToken(token)).toBeNull();
  });

  it('refuses malformed topology and invalid constructor arguments', () => {
    expect(isLegacyCompositeTopology({ ...rectangle, extra: true })).toBe(
      false
    );
    expect(() =>
      makeSketchCompositeBoundaryToken('ent_rect', rectangle, 4)
    ).toThrow();
    expect(() =>
      makeSketchCompositeBoundaryToken('ent/rect', rectangle, 0)
    ).toThrow();
    expect(() => makeSketchPrimitiveBoundaryToken('', 'line')).toThrow();
  });
});

describe('S04 loop roles, sequence and split multiplicity', () => {
  const outer = [edge(0), line('ent_cut'), edge(2), edge(3)];
  const hole = [line('ent_holeA'), line('ent_holeB'), line('ent_holeC')];
  const value: BoundaryProvenance = { outer, holes: [hole] };

  it('normalizes start and traversal without mutating inputs', () => {
    const before = structuredClone(value);
    expect(
      boundaryProvenanceEqual(value, {
        outer: [outer[2]!, outer[1]!, outer[0]!, outer[3]!],
        holes: [[hole[1]!, hole[0]!, hole[2]!]]
      })
    ).toBe(true);
    expect(value).toEqual(before);
    expect(canonicalBoundaryLoop([edge(2), edge(0), edge(1)])).toEqual([
      edge(0),
      edge(1),
      edge(2)
    ]);
  });

  it('keeps loop roles and primitive segment identity significant', () => {
    expect(
      boundaryProvenanceEqual(value, { outer: hole, holes: [outer] })
    ).toBe(false);
    expect(
      boundaryProvenanceEqual(value, {
        outer: [edge(0), line('ent_other_cut'), edge(2), edge(3)],
        holes: [hole]
      })
    ).toBe(false);
    expect(
      boundaryProvenanceEqual(value, {
        outer: [outer[0]!, outer[2]!, outer[1]!, outer[3]!],
        holes: [hole]
      })
    ).toBe(false);
  });

  it('retains repeated pieces, repeated hole loops and their occurrence counts', () => {
    const split = { ...value, outer: [edge(0), edge(0), ...outer.slice(1)] };
    expect(boundaryProvenanceEqual(value, split)).toBe(false);
    const duplicateHole = { ...value, holes: [hole, [...hole].reverse()] };
    expect(canonicalBoundaryProvenance(duplicateHole).holes).toHaveLength(2);
    expect(boundaryProvenanceEqual(value, duplicateHole)).toBe(false);
    expect(
      boundaryProvenanceEqual(duplicateHole, {
        ...value,
        holes: [[...hole].reverse(), hole]
      })
    ).toBe(true);
    expect(boundaryProvenanceObjectIds(split)).toEqual([
      'ent_cut',
      'ent_holeA',
      'ent_holeB',
      'ent_holeC',
      'ent_rect'
    ]);
  });

  it('handles long repeated loops without discarding their sequence', () => {
    const repeated = [...Array<string>(10000).fill(edge(0)), edge(1)];
    const rotated = [...repeated.slice(7500), ...repeated.slice(0, 7500)];
    expect(canonicalBoundaryLoop(rotated)).toEqual(repeated);
  });

  it.each([
    { outer: [], holes: [] },
    { outer: ['bad'], holes: [] },
    { outer, holes: [[]] },
    { outer, holes: [], extra: true },
    { outer: Array<string>(1), holes: [] },
    { outer, holes: Array<string[]>(1) }
  ])('rejects incomplete or malformed loop records', (malformed) => {
    expect(isBoundaryProvenance(malformed)).toBe(false);
    expect(() =>
      canonicalBoundaryProvenance(malformed as BoundaryProvenance)
    ).toThrow();
  });
});
