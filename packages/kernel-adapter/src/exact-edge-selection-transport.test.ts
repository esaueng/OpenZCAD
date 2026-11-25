import { describe, expect, it } from 'vitest';
import type { EdgeWitnessV1 } from '@openzcad/shared';
import {
  direction,
  edgeHeading,
  edgeProvenance,
  EdgeSelectionMemory,
  type EdgeTopologyLayout
} from './exact-edge-selection-transport';

describe('edge selection transport labels', () => {
  it('signs an unoriented direction by its rounded components', () => {
    // Near-axis noise on either side of zero rounds away; the sign must be
    // chosen from what is printed, or a mirror twin reads "-1" on one build
    // and "1" on the next.
    expect(direction([1e-4, 1, 0], false)).toBe('0.000,1.000,0.000');
    expect(direction([-1e-4, 1, 0], false)).toBe('0.000,1.000,0.000');
    expect(direction([-1e-4, -1, 0], false)).toBe('0.000,1.000,0.000');
    expect(direction([0, -1, 2e-4], false)).toBe('0.000,1.000,0.000');
    // A genuine lead component still decides.
    expect(direction([-0.6, 0.8, 0], false)).toBe('0.600,-0.800,0.000');
  });

  it('keeps an oriented direction’s own sense', () => {
    expect(direction([-1e-4, -1, 0], true)).toBe('0.000,-1.000,0.000');
    expect(direction([0, 0, 1], true)).toBe('0.000,0.000,1.000');
    expect(direction([0, 0, 0], true)).toBeNull();
    expect(direction([Number.NaN, 0, 1], false)).toBeNull();
  });

  it('reads a straight edge the same from either end', () => {
    const line = (
      start: [number, number, number],
      end: [number, number, number]
    ): EdgeWitnessV1 => ({
      curveType: 'LINE',
      length: 1,
      closed: false,
      endpoints: [start, end],
      midpoint: [
        (start[0] + end[0]) / 2,
        (start[1] + end[1]) / 2,
        (start[2] + end[2]) / 2
      ]
    });
    expect(edgeHeading(line([0, 0, 0], [0, 10, 0]))).toBe(
      edgeHeading(line([0, 10, 0], [0, 0, 0]))
    );
    expect(edgeHeading(line([0, 0, 0], [1, 10_000, 0]))).toBe(
      edgeHeading(line([1, 10_000, 0], [0, 0, 0]))
    );
  });
});

describe('edge provenance', () => {
  /**
   * Faces 1–4 around a boss: cap 1 meets sides 2, 3 and 4 along edges
   * 12, 13 and 14; edge 23 joins sides 2 and 3.
   */
  function layout(): EdgeTopologyLayout {
    const facesOfEdge = new Map<number, number[]>([
      [12, [1, 2]],
      [13, [1, 3]],
      [14, [1, 4]],
      [23, [2, 3]]
    ]);
    const edgesOfFace = new Map<number, number[]>();
    for (const [edge, faces] of facesOfEdge) {
      for (const face of faces) {
        edgesOfFace.set(face, [...(edgesOfFace.get(face) ?? []), edge]);
      }
    }
    return {
      signature: '',
      labels: new Map(),
      counts: new Map(),
      faceLabels: new Map(),
      faceCounts: new Map(),
      facesOfEdge,
      edgesOfFace,
      planes: new Map()
    };
  }
  const named =
    (names: Record<number, string>) =>
    (face: number): string | undefined =>
      names[face];

  it('reads an unnamed face through the named faces that border it', () => {
    // The cap and side 2 are unnamed; side 3 is boss A's own side.
    const fromA = edgeProvenance(
      layout(),
      12,
      named({ 3: 'A.side', 4: 'Base' })
    );
    const fromB = edgeProvenance(
      layout(),
      12,
      named({ 3: 'B.side', 4: 'Base' })
    );
    expect(fromA).not.toBeNull();
    expect(fromB).not.toBeNull();
    // Another boss in the same role reads differently.
    expect(fromA).not.toBe(fromB);
    // A named face reads as itself, whatever borders it.
    expect(edgeProvenance(layout(), 13, named({ 1: 'cap', 3: 'A.side' }))).toBe(
      edgeProvenance(layout(), 13, named({ 1: 'cap', 3: 'A.side', 2: 'x' }))
    );
  });

  it('is no evidence when an adjacent face has no named face around it', () => {
    expect(edgeProvenance(layout(), 23, named({}))).toBeNull();
    // Unnamed side 3 reads through named side 2, which it borders.
    expect(edgeProvenance(layout(), 23, named({ 2: 'A.side' }))).not.toBeNull();
    // The cap borders the named base, but unnamed side 2 borders only
    // unnamed faces (the cap and side 3).
    expect(edgeProvenance(layout(), 12, named({ 4: 'Base' }))).toBeNull();
    // An edge with no faces at all proves nothing.
    expect(edgeProvenance(layout(), 99, named({ 1: 'cap' }))).toBeNull();
  });
});

describe('edge selection memory', () => {
  const record = (selection: string) => ({
    edgeLabels: new Map<number, string>(),
    selected: new Map<number, string>(),
    provenance: new Map<number, string>(),
    faceIdentities: new Map<string, string>(),
    planes: new Map<string, string>(),
    hashSet: '',
    selection,
    upstream: {
      units: 'mm',
      features: [],
      sketches: new Map(),
      scope: {},
      sizes: new Map(),
      resolved: ''
    }
  });

  it('keeps a bounded number of layouts per feature, newest last', () => {
    const memory = new EdgeSelectionMemory();
    for (let index = 0; index < 6; index += 1) {
      memory.store('feature', `layout-${index}`, record(String(index)));
    }
    expect(memory.lookup('feature', 'layout-0')).toBeUndefined();
    expect(memory.lookup('feature', 'layout-1')).toBeUndefined();
    expect(memory.lookup('feature', 'layout-2')?.selection).toBe('2');
    expect(memory.latestRecord('feature')?.selection).toBe('5');
  });

  it('forgets everything on clear, as a new adapter would', () => {
    const memory = new EdgeSelectionMemory();
    memory.store('feature', 'layout', record('a'));
    memory.clear();
    expect(memory.size).toBe(0);
    expect(memory.lookup('feature', 'layout')).toBeUndefined();
    expect(memory.latestRecord('feature')).toBeUndefined();
  });
});
