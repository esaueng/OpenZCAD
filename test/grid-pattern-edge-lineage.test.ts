import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  patternBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeTopologyReferenceV5
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { topologyHashOfWitness } from '../packages/kernel-adapter/src/topology-lineage';

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => adapter.dispose());

function grid(spacing = 30, spacing2 = 40) {
  const block = addPrimitiveFeature(
    createProjectDocument('Grid edge lineage', toUserId('user_grid_edges')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    }
  );
  const document = patternBody(block, {
    name: 'Field',
    patternKind: 'grid',
    targetBodyId: block.bodyOrder.at(-1)!,
    axis: 'x',
    axis2: 'y',
    count: 3,
    count2: 2,
    spacing,
    spacing2
  }).document;
  return {
    document,
    bodyId: document.bodyOrder.at(-1)!,
    featureId: listFeaturesInOrder(document).at(-1)!.featureId
  };
}

function topology(derived: DerivedState, bodyId: BodyId) {
  expect(derived.bodyRepresentations[bodyId]).toBeDefined();
  return derived.bodyRepresentations[bodyId]!.topology!;
}

/** Closed-form box edge coordinates, independent of the producer's journal order. */
function expectBoxEdge(
  reference: EdgeTopologyReferenceV5,
  spacing: number,
  spacing2: number
) {
  const match =
    /^pattern\.edge\.instance\.(\d+)-(\d+)\.primitive\.box\.edge\.([xyz])\.([xyz])-(min|max)\.([xyz])-(min|max)$/.exec(
      reference.lineageName
    );
  expect(match, reference.lineageName).not.toBeNull();
  const [, column, row, varying, first, firstBound, second, secondBound] =
    match!;
  const axes = ['x', 'y', 'z'];
  const offset = [Number(column) * spacing, Number(row) * spacing2, 0];
  const low = axes.map(
    (axis, index) =>
      offset[index]! +
      (axis === first
        ? firstBound === 'max'
          ? 10
          : 0
        : axis === second
          ? secondBound === 'max'
            ? 10
            : 0
          : 0)
  );
  const high = low.map(
    (value, index) => value + (axes[index] === varying ? 10 : 0)
  );
  const quantize = (point: number[]) =>
    point.map((value) => Math.round(value * 1e6));
  expect(reference.witness).toEqual({
    curveType: 'LINE',
    closed: false,
    length: 10_000_000,
    endpoints: [quantize(low), quantize(high)],
    midpoint: quantize(low.map((value, index) => (value + high[index]!) / 2))
  });
  expect(reference.currentHash).toBe(
    topologyHashOfWitness('edge', reference.witness)
  );
}

describe('journal-qualified grid edge lineage', { timeout: 120_000 }, () => {
  it.each([
    [30, 40],
    [-30, 40],
    [30, -40],
    [-30, -40]
  ])(
    'names all 72 box edges at signed spacing %s, %s',
    async (spacing, spacing2) => {
      const { document, bodyId } = grid(spacing, spacing2);
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const edges = topology(derived, bodyId).edges;
      expect(edges).toHaveLength(72);
      expect(edges.filter((edge) => edge.reference)).toHaveLength(72);
      expect(
        new Set(edges.map((edge) => edge.reference!.lineageName)).size
      ).toBe(72);
      for (let ordinal = 0; ordinal < 6; ordinal += 1) {
        const cell = `${Math.floor(ordinal / 2)}-${ordinal % 2}`;
        const group = edges.slice(ordinal * 12, (ordinal + 1) * 12);
        for (const edge of group) {
          expect(edge.reference!.lineageName).toContain(`instance.${cell}.`);
          expect(edge.length).toBe(10);
          expectBoxEdge(edge.reference!, spacing, spacing2);
        }
      }
    }
  );

  it('preserves edge identities and exact witnesses when both counts grow', async () => {
    const { document, bodyId, featureId } = grid(-30, 40);
    const initial = await adapter.syncDocument(document);
    const grown = updateFeature(document, {
      featureId,
      data: { count: 4, count2: 3 }
    });
    const rebuilt = await adapter.syncDocument(grown);
    expect(rebuilt.warnings).toEqual([]);
    const after = topology(rebuilt, bodyId).edges;
    expect(after.filter((edge) => edge.reference)).toHaveLength(144);
    for (const edge of topology(initial, bodyId).edges) {
      expect(edge.reference).toBeDefined();
      const retained = after.filter(
        (candidate) =>
          candidate.reference?.lineageName === edge.reference!.lineageName
      );
      expect(retained).toHaveLength(1);
      expect(retained[0]!.reference).toEqual(edge.reference);
    }
  });

  it('qualifies the existing 100-solid box envelope within the event-visit budget', async () => {
    const outputs = vi.spyOn(RemusKernel.prototype, 'resolveOperationOutput');
    try {
      const { document, bodyId, featureId } = grid();
      const largest = updateFeature(document, {
        featureId,
        data: { count: 10, count2: 10 }
      });
      const derived = await adapter.syncDocument(largest);
      expect(derived.warnings).toEqual([]);
      expect(
        topology(derived, bodyId).edges.filter((edge) => edge.reference)
      ).toHaveLength(1200);
      expect(
        outputs.mock.calls.filter(([, kind]) => kind === 'edge')
      ).toHaveLength(1201);
      expect(1201 * (600 + 1200 + 800)).toBeLessThanOrEqual(4_000_000);
    } finally {
      outputs.mockRestore();
    }
  });

  it('derives edge roles independently of public output ordinal order', async () => {
    const resolve = RemusKernel.prototype.resolveOperationOutput;
    const outputs = vi
      .spyOn(RemusKernel.prototype, 'resolveOperationOutput')
      .mockImplementation(function (this: RemusKernel, op, kind, index) {
        return resolve.call(
          this,
          op,
          kind,
          kind === 'edge' && index < 72 ? 71 - index : index
        );
      });
    try {
      const { document, bodyId } = grid(-30, 40);
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const edges = topology(derived, bodyId).edges;
      expect(edges.filter((edge) => edge.reference)).toHaveLength(72);
      for (const edge of edges) expectBoxEdge(edge.reference!, -30, 40);
    } finally {
      outputs.mockRestore();
    }
  });

  it.each([
    'over-budget',
    'wrong-origin',
    'wrong-kind',
    'missing',
    'invalid-count',
    'understated-count',
    'overstated-count',
    'stale',
    'duplicate'
  ])(
    'declines %s journal metadata before starting edge ordinal scans',
    async (fault) => {
      const summary = RemusKernel.prototype.journalSummary;
      const outputs = vi.spyOn(RemusKernel.prototype, 'resolveOperationOutput');
      const metadata = vi
        .spyOn(RemusKernel.prototype, 'journalSummary')
        .mockImplementation(function (this: RemusKernel) {
          const entries = JSON.parse(summary.call(this)) as Array<{
            op: number;
            kind: string;
            detail: { origin: string; events: number };
          }>;
          if (fault === 'missing') return '[]';
          for (const entry of entries) {
            if (entry.kind !== 'grid_pattern') continue;
            if (fault === 'over-budget') entry.detail.events = 100_000_000;
            if (fault === 'wrong-origin') entry.detail.origin = 'inferred';
            if (fault === 'wrong-kind') entry.kind = 'fillet';
            if (fault === 'invalid-count') entry.detail.events = 1.5;
            if (fault === 'understated-count') entry.detail.events = 72;
            if (fault === 'overstated-count') entry.detail.events += 1;
            if (fault === 'stale') entry.op = 4_000_000_000;
          }
          if (fault === 'duplicate')
            entries.push(
              ...entries.filter((entry) => entry.kind === 'grid_pattern')
            );
          return JSON.stringify(entries);
        });
      try {
        const { document, bodyId } = grid();
        const derived = await adapter.syncDocument(document);
        expect(derived.warnings).toEqual([]);
        expect(
          outputs.mock.calls.filter(([, kind]) => kind === 'edge')
        ).toHaveLength(0);
        expect(
          topology(derived, bodyId).edges.filter((edge) => edge.reference)
        ).toHaveLength(0);
        expect(
          topology(derived, bodyId).faces.filter((face) => face.reference)
        ).toHaveLength(36);
      } finally {
        metadata.mockRestore();
        outputs.mockRestore();
      }
    }
  );

  it.each([
    'missing',
    'duplicate',
    'wrong-kind',
    'inferred',
    'malformed',
    'foreign',
    'phantom'
  ])(
    'declines edge names for a %s edge journal census while preserving face adoption',
    async (fault) => {
      const resolve = RemusKernel.prototype.resolveOperationOutput;
      const outputs = vi
        .spyOn(RemusKernel.prototype, 'resolveOperationOutput')
        .mockImplementation(function (this: RemusKernel, op, kind, index) {
          if (kind !== 'edge') return resolve.call(this, op, kind, index);
          if (index === 72 && fault === 'phantom')
            return resolve.call(this, op, kind, 0);
          if (index !== 1) return resolve.call(this, op, kind, index);
          const row = JSON.parse(resolve.call(this, op, kind, 0)) as Record<
            string,
            unknown
          >;
          if (fault === 'missing') return JSON.stringify({ status: 'noMatch' });
          if (fault === 'duplicate') return JSON.stringify(row);
          if (fault === 'malformed') return '{';
          if (fault === 'wrong-kind') return resolve.call(this, op, 'face', 1);
          if (fault === 'foreign')
            return JSON.stringify({
              ...row,
              entities: [{ kind: 'edge', handle: 4_000_000_000 }]
            });
          return JSON.stringify({ ...row, provenance: 'inferred' });
        });
      try {
        const { document, bodyId } = grid();
        const derived = await adapter.syncDocument(document);
        expect(outputs.mock.calls.some(([, kind]) => kind === 'edge')).toBe(
          true
        );
        expect(derived.warnings).toEqual([]);
        const result = topology(derived, bodyId);
        expect(result.edges).toHaveLength(72);
        expect(result.edges.filter((edge) => edge.reference)).toHaveLength(0);
        expect(result.faces.filter((face) => face.reference)).toHaveLength(36);
        expect(derived.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
          6000,
          6
        );
      } finally {
        outputs.mockRestore();
      }
    }
  );

  it('follows a grid edge axis and endpoint point, then refuses their deleted cell', async () => {
    const { document, bodyId, featureId } = grid(-30, 40);
    const initial = await adapter.syncDocument(document);
    const edge = topology(initial, bodyId).edges.find(
      (candidate) =>
        candidate.reference?.lineageName ===
        'pattern.edge.instance.2-1.primitive.box.edge.z.x-max.y-min'
    );
    expect(edge?.reference).toBeDefined();
    const reference = edge!.reference!;
    const axis = addDatumAxis(document, {
      name: 'Cell axis',
      definition: {
        kind: 'edge',
        source: { type: 'edge', bodyId, edgeReference: reference }
      }
    });
    const plane = addDatumPlane(axis.document, {
      name: 'Cell endpoint',
      definition: {
        kind: 'parallel-point',
        source: { type: 'canonical', plane: 'XY', offset: 0 },
        point: { type: 'edge-vertex', bodyId, edgeReference: reference, end: 1 }
      }
    });
    const built = await adapter.syncDocument(plane.document);
    expect(built.warnings).toEqual([]);
    expect(built.datumAxes![axis.featureId]!.origin).toEqual({
      x: -50,
      y: 40,
      z: 0
    });
    expect(built.datumAxes![axis.featureId]!.direction).toEqual({
      x: 0,
      y: 0,
      z: 1
    });
    expect(built.datumFrames![plane.featureId]!.origin).toEqual({
      x: -50,
      y: 40,
      z: 10
    });
    const moved = updateFeature(plane.document, {
      featureId,
      data: { spacing: -45, spacing2: 55, count: 4, count2: 3 }
    });
    const replayed = await adapter.syncDocument(moved);
    expect(replayed.warnings).toEqual([]);
    expect(replayed.datumAxes![axis.featureId]!.origin).toEqual({
      x: -80,
      y: 55,
      z: 0
    });
    expect(replayed.datumFrames![plane.featureId]!.origin).toEqual({
      x: -80,
      y: 55,
      z: 10
    });
    const cold = await createExactKernelAdapter();
    try {
      const rebuilt = await cold.syncDocument(moved);
      expect(rebuilt.warnings).toEqual([]);
      expect(rebuilt.datumAxes![axis.featureId]).toEqual(
        replayed.datumAxes![axis.featureId]
      );
      expect(rebuilt.datumFrames![plane.featureId]).toEqual(
        replayed.datumFrames![plane.featureId]
      );
    } finally {
      cold.dispose();
    }
    const removed = updateFeature(moved, { featureId, data: { count: 2 } });
    const refused = await adapter.syncDocument(removed);
    expect(refused.datumAxes?.[axis.featureId]).toBeUndefined();
    expect(refused.datumFrames?.[plane.featureId]).toBeUndefined();
    expect(refused.warnings).toHaveLength(2);
    expect(refused.warnings.join('\n')).toMatch(
      /Cell axis.*deleted|Cell axis.*no longer/i
    );
    expect(refused.warnings.join('\n')).toMatch(
      /Cell endpoint.*deleted|Cell endpoint.*no longer/i
    );
  });

  it.each(['fillet', 'chamfer'] as const)(
    'keeps an unchanged multi-solid grid %s pick equivalent to its legacy hash control',
    async (kind) => {
      const { document, bodyId } = grid(-30, 40);
      const source = await adapter.syncDocument(document);
      const edge = topology(source, bodyId).edges.find(
        (candidate) =>
          candidate.reference?.lineageName ===
          'pattern.edge.instance.2-1.primitive.box.edge.z.x-max.y-min'
      );
      expect(edge?.reference).toBeDefined();
      const modify = kind === 'fillet' ? filletEdges : chamferEdges;
      const input = {
        name: 'Cell blend',
        targetBodyId: bodyId,
        edgeHashes: [edge!.hash],
        size: 1
      };
      const legacy = modify(document, input);
      const named = modify(document, {
        ...input,
        edgeReferences: [edge!.reference!]
      });
      const baseline = await adapter.syncDocument(legacy.document);
      const result = await adapter.syncDocument(named.document);
      expect(baseline.warnings).toEqual([]);
      expect(result.warnings).toEqual([]);
      const expected = 6000 - 10 * (kind === 'fillet' ? 1 - Math.PI / 4 : 0.5);
      for (const [derived, id] of [
        [baseline, legacy.bodyId],
        [result, named.bodyId]
      ] as const) {
        const body = derived.bodyRepresentations[id];
        expect(body).toBeDefined();
        expect(body!.volume).toBeCloseTo(expected, 6);
        expect(topology(derived, id).faces).toHaveLength(37);
        expect(topology(derived, id).edges).toHaveLength(75);
      }
      expect(
        topology(result, named.bodyId)
          .faces.map((face) => face.hash)
          .sort()
      ).toEqual(
        topology(baseline, legacy.bodyId)
          .faces.map((face) => face.hash)
          .sort()
      );
      expect(
        topology(result, named.bodyId)
          .edges.map((candidate) => candidate.hash)
          .sort()
      ).toEqual(
        topology(baseline, legacy.bodyId)
          .edges.map((candidate) => candidate.hash)
          .sort()
      );
    }
  );
});
