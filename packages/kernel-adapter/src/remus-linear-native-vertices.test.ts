import { describe, expect, it, vi } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { decodeRemusPatternJournal } from './remus-lineage';
import {
  patternJournalBoundaryOutputs,
  patternJournalBoundaryOutputsForSources
} from './exact-lineage-builders';
import { transformMatrix } from './exact-math';

function fixture(count = 3) {
  const kernel = new RemusKernel();
  const source = kernel.makeBox(10, 10, 10);
  const journal = decodeRemusPatternJournal(
    kernel.linearPatternJournaled(source, 1, 0, 0, 30, count)
  );
  const solids = Array.from(kernel.getCompoundSolids(journal.compound));
  return { kernel, source, journal, solids };
}

function multipleSources(count = 3, chamfered = false) {
  const kernel = new RemusKernel();
  // Build both inputs before journaling either pattern. No unjournaled mutation
  // between the two calls may sever the first operation's current evidence.
  const sources = [0, 40].map((z) => {
    const box = kernel.makeBox(10, 10, 10);
    const source = chamfered
      ? kernel.chamfer(box, Uint32Array.of(kernel.getSolidEdges(box)[0]!), 1)
      : box;
    kernel.transformSolid(
      source,
      transformMatrix({ x: 0, y: 0, z }, { x: 0, y: 0, z: 0 })
    );
    return source;
  });
  const patterns = sources.map((source) => {
    const journal = decodeRemusPatternJournal(
      kernel.linearPatternJournaled(source, 1, 0, 0, 30, count)
    );
    return {
      source,
      journal,
      instanceSolids: Array.from(kernel.getCompoundSolids(journal.compound))
    };
  });
  return {
    kernel,
    patterns,
    plans: patterns.map(({ journal, instanceSolids }) => ({
      op: journal.op,
      instanceSolids
    }))
  };
}

describe('explicit LINEAR construction subject qualification', () => {
  it('partitions each source operation by actual members, independent of subject and input order', () => {
    const f = multipleSources();
    try {
      const resolve = f.kernel.resolveOperationOutput.bind(f.kernel);
      vi.spyOn(f.kernel, 'resolveOperationOutput').mockImplementation(
        (op, kind, index) => {
          const total = kind === 'edge' ? 36 : kind === 'vertex' ? 24 : 18;
          return resolve(op, kind, index < total ? total - index - 1 : index);
        }
      );
      const result = patternJournalBoundaryOutputsForSources(f.kernel, f.plans);
      for (const [index, plan] of f.plans.entries()) {
        expect(
          result[index]?.edges.map((members) => [...members].sort())
        ).toEqual(
          plan.instanceSolids.map((solid) =>
            Array.from(f.kernel.getSolidEdges(solid)).sort()
          )
        );
        expect(
          result[index]?.vertices?.map((members) => [...members].sort())
        ).toEqual(
          plan.instanceSolids.map((solid) =>
            Array.from(f.kernel.getSolidVertices(solid)).sort()
          )
        );
      }
      const permuted = f.plans
        .slice()
        .reverse()
        .map((plan) => ({
          op: plan.op,
          instanceSolids: plan.instanceSolids.slice().reverse()
        }));
      const reversed = patternJournalBoundaryOutputsForSources(
        f.kernel,
        permuted
      );
      expect(reversed).toEqual(
        result
          .slice()
          .reverse()
          .map((row) => ({
            ...row!,
            edges: row!.edges.slice().reverse(),
            vertices: row!.vertices!.slice().reverse()
          }))
      );
    } finally {
      f.kernel.free();
    }
  });

  it('shares the edge and vertex event-visit budget across two actual 7F/15E/10V source patterns', () => {
    const f = multipleSources(50, true);
    try {
      const summary = JSON.parse(f.kernel.journalSummary()) as {
        op: number;
        detail?: { events?: number };
      }[];
      for (const pattern of f.patterns) {
        expect(f.kernel.getSolidFaces(pattern.source)).toHaveLength(7);
        expect(f.kernel.getSolidEdges(pattern.source)).toHaveLength(15);
        expect(f.kernel.getSolidVertices(pattern.source)).toHaveLength(10);
        expect(pattern.instanceSolids).toHaveLength(50);
        const count = (kind: 'face' | 'edge' | 'vertex') =>
          pattern.instanceSolids.reduce(
            (sum, solid) =>
              sum +
              (kind === 'face'
                ? f.kernel.getSolidFaces(solid).length
                : kind === 'edge'
                  ? f.kernel.getSolidEdges(solid).length
                  : f.kernel.getSolidVertices(solid).length),
            0
          );
        expect([count('face'), count('edge'), count('vertex')]).toEqual([
          350, 750, 500
        ]);
        expect(
          summary.find((row) => row.op === pattern.journal.op)?.detail?.events
        ).toBe(1600);
      }
      expect(2 * (750 + 1) * 1600).toBe(2_403_200);
      expect(2 * (750 + 500 + 2) * 1600).toBe(4_006_400);
      const output = vi.spyOn(f.kernel, 'resolveOperationOutput');
      const result = patternJournalBoundaryOutputsForSources(f.kernel, f.plans);
      for (const row of result) {
        expect(row?.edges).toHaveLength(50);
        expect(row?.edges.every((members) => members.size === 15)).toBe(true);
        expect(row?.vertices).toBeNull();
        expect(row?.vertexUnavailableReason).toBe('event-budget');
      }
      expect(
        output.mock.calls.filter(([, kind]) => kind === 'edge')
      ).toHaveLength(1502);
      expect(
        output.mock.calls.filter(([, kind]) => kind === 'vertex')
      ).toHaveLength(0);
      output.mockClear();
      expect(
        patternJournalBoundaryOutputsForSources(
          f.kernel,
          f.plans.slice().reverse()
        )
      ).toEqual(result.slice().reverse());
      expect(
        output.mock.calls.filter(([, kind]) => kind === 'edge')
      ).toHaveLength(1502);
      expect(
        output.mock.calls.filter(([, kind]) => kind === 'vertex')
      ).toHaveLength(0);
    } finally {
      f.kernel.free();
    }
  });

  it('refuses the aggregate edge overflow before either source subject census', () => {
    const f = multipleSources(75, true);
    try {
      for (const pattern of f.patterns) {
        expect(pattern.instanceSolids).toHaveLength(75);
        expect(f.kernel.getSolidEdges(pattern.source)).toHaveLength(15);
      }
      expect(2 * (75 * 15 + 1) * (75 * (7 + 15 + 10))).toBe(5_404_800);
      const output = vi.spyOn(f.kernel, 'resolveOperationOutput');
      expect(
        patternJournalBoundaryOutputsForSources(f.kernel, f.plans)
      ).toEqual([null, null]);
      expect(output).not.toHaveBeenCalled();
    } finally {
      f.kernel.free();
    }
  });

  it('refuses a valid operation paired with another source result instead of using ordinal identity', () => {
    const f = multipleSources();
    try {
      const mismatched = f.plans.map((plan, index) => ({
        ...plan,
        op: f.plans[1 - index]!.op
      }));
      const before = f.kernel.serializeSolids(
        Uint32Array.from(f.plans.flatMap((plan) => plan.instanceSolids))
      );
      const output = vi.spyOn(f.kernel, 'resolveOperationOutput');
      expect(
        patternJournalBoundaryOutputsForSources(f.kernel, mismatched)
      ).toEqual([null, null]);
      expect(
        output.mock.calls.filter(([, kind]) => kind === 'vertex')
      ).toHaveLength(0);
      expect(
        f.kernel.serializeSolids(
          Uint32Array.from(f.plans.flatMap((plan) => plan.instanceSolids))
        )
      ).toEqual(before);
    } finally {
      f.kernel.free();
    }
  });

  it.each([
    'duplicate-op',
    'duplicate-member',
    'missing-op',
    'malformed-summary'
  ])(
    'rejects %s in the full source preflight before all subject reads',
    (fault) => {
      const f = multipleSources();
      try {
        const plans = f.plans.map((plan) => ({
          ...plan,
          instanceSolids: [...plan.instanceSolids]
        }));
        if (fault === 'duplicate-op') plans[1]!.op = plans[0]!.op;
        if (fault === 'missing-op') plans[1]!.op = 4_000_000_000;
        if (fault === 'duplicate-member')
          plans[1]!.instanceSolids[0] = plans[0]!.instanceSolids[0]!;
        if (fault === 'malformed-summary')
          vi.spyOn(f.kernel, 'journalSummary').mockReturnValue('{');
        const output = vi.spyOn(f.kernel, 'resolveOperationOutput');
        expect(
          patternJournalBoundaryOutputsForSources(f.kernel, plans)
        ).toEqual([null, null]);
        expect(output).not.toHaveBeenCalled();
      } finally {
        f.kernel.free();
      }
    }
  );

  it.each([
    ['edge', 'foreign'],
    ['edge', 'incomplete'],
    ['vertex', 'malformed'],
    ['vertex', 'incomplete']
  ] as const)(
    'withholds source-local %s proof for %s subjects',
    (kind, fault) => {
      const f = multipleSources();
      try {
        const resolve = f.kernel.resolveOperationOutput.bind(f.kernel);
        vi.spyOn(f.kernel, 'resolveOperationOutput').mockImplementation(
          (op, subject, index) => {
            if (op !== f.plans[1]!.op || subject !== kind || index !== 1)
              return resolve(op, subject, index);
            if (fault === 'malformed') return '{';
            if (fault === 'incomplete')
              return JSON.stringify({ status: 'noMatch' });
            return resolve(f.plans[0]!.op, subject, index);
          }
        );
        const result = patternJournalBoundaryOutputsForSources(
          f.kernel,
          f.plans
        );
        expect(result[0]?.edges.map((members) => members.size)).toEqual([
          12, 12, 12
        ]);
        expect(result[0]?.vertices?.map((members) => members.size)).toEqual([
          8, 8, 8
        ]);
        if (kind === 'edge') expect(result[1]).toBeNull();
        else {
          expect(result[1]?.edges.map((members) => members.size)).toEqual([
            12, 12, 12
          ]);
          expect(result[1]?.vertices).toBeNull();
          expect(result[1]?.vertexUnavailableReason).toBe(
            'journal-unavailable'
          );
        }
      } finally {
        f.kernel.free();
      }
    }
  );

  it('accepts the legitimate kernel count1 with source handle0 without changing the product count minimum', () => {
    const f = fixture(1);
    try {
      expect(f.solids).toEqual([f.source]);
      const result = patternJournalBoundaryOutputs(
        f.kernel,
        f.journal.op,
        f.solids,
        true,
        'linear_pattern'
      )!;
      expect(result.edges.map((members) => members.size)).toEqual([12]);
      expect(result.vertices?.map((members) => members.size)).toEqual([8]);
      expect(result.vertices![0]!.has(0)).toBe(true);
    } finally {
      f.kernel.free();
    }
  });

  it.each(['grid_pattern', undefined, null, '', 7, 'circular_pattern'])(
    'declines expected producer%j for an actual LINEAR operation before ordinal reads',
    (expected) => {
      const f = fixture();
      const output = vi.spyOn(f.kernel, 'resolveOperationOutput');
      try {
        const result: unknown = Reflect.apply(
          patternJournalBoundaryOutputs,
          undefined,
          [f.kernel, f.journal.op, f.solids, true, expected]
        );
        expect(result).toBeNull();
        expect(output).not.toHaveBeenCalled();
      } finally {
        f.kernel.free();
      }
    }
  );

  it('refuses an unallowlisted producer even if the supplied summary uses the same arbitrary name', () => {
    const f = fixture();
    try {
      const summary = f.kernel.journalSummary.bind(f.kernel);
      vi.spyOn(f.kernel, 'journalSummary').mockImplementation(() => {
        const rows = JSON.parse(summary()) as { kind: string }[];
        rows.forEach((row) => {
          row.kind = 'arbitrary_pattern';
        });
        return JSON.stringify(rows);
      });
      const output = vi.spyOn(f.kernel, 'resolveOperationOutput');
      const result: unknown = Reflect.apply(
        patternJournalBoundaryOutputs,
        undefined,
        [f.kernel, f.journal.op, f.solids, true, 'arbitrary_pattern']
      );
      expect(result).toBeNull();
      expect(output).not.toHaveBeenCalled();
    } finally {
      f.kernel.free();
    }
  });

  it.each([
    'grid_pattern',
    'inferred',
    'missing',
    'duplicate',
    'understated',
    'fractional',
    'stale'
  ])('declines %s LINEAR metadata without either boundary scan', (fault) => {
    const f = fixture();
    try {
      const summary = f.kernel.journalSummary.bind(f.kernel);
      vi.spyOn(f.kernel, 'journalSummary').mockImplementation(() => {
        const rows = JSON.parse(summary()) as {
          op: number;
          kind: string;
          detail: { origin: string; events: number };
        }[];
        if (fault === 'missing') return '[]';
        for (const row of rows) {
          if (row.kind !== 'linear_pattern') continue;
          if (fault === 'grid_pattern') row.kind = 'grid_pattern';
          if (fault === 'inferred') row.detail.origin = 'inferred';
          if (fault === 'understated') row.detail.events = 36;
          if (fault === 'fractional') row.detail.events = 78.5;
          if (fault === 'stale') row.op += 1;
        }
        if (fault === 'duplicate')
          rows.push(...rows.filter((row) => row.kind === 'linear_pattern'));
        return JSON.stringify(rows);
      });
      const output = vi.spyOn(f.kernel, 'resolveOperationOutput');
      expect(
        patternJournalBoundaryOutputs(
          f.kernel,
          f.journal.op,
          f.solids,
          true,
          'linear_pattern'
        )
      ).toBeNull();
      expect(output).not.toHaveBeenCalled();
    } finally {
      f.kernel.free();
    }
  });

  describe.each(['edge', 'vertex'] as const)('%s subject refusals', (kind) => {
    it.each([
      'missing',
      'duplicate',
      'wrong-kind',
      'bound-many',
      'inferred',
      'foreign',
      'phantom',
      'stale',
      'malformed'
    ])(
      'declines%s without changing geometry or inventing vertex names',
      (fault) => {
        const f = fixture();
        try {
          const before = f.kernel.serializeSolids(Uint32Array.from(f.solids));
          const resolve = f.kernel.resolveOperationOutput.bind(f.kernel);
          const total = kind === 'edge' ? 36 : 24;
          const output = vi
            .spyOn(f.kernel, 'resolveOperationOutput')
            .mockImplementation((op, subject, index) => {
              if (subject !== kind) return resolve(op, subject, index);
              if (fault === 'phantom' && index === total)
                return resolve(op, subject, 0);
              if (index !== 1) return resolve(op, subject, index);
              if (fault === 'missing')
                return JSON.stringify({ status: 'noMatch' });
              if (fault === 'stale')
                return JSON.stringify({ status: 'unknownOperation' });
              if (fault === 'malformed') return '{';
              const row = JSON.parse(
                resolve(op, subject, fault === 'duplicate' ? 0 : 1)
              ) as {
                status: string;
                provenance: string;
                entities: { kind: string; handle: number }[];
              };
              if (fault === 'wrong-kind')
                row.entities[0]!.kind = kind === 'edge' ? 'vertex' : 'edge';
              if (fault === 'bound-many') row.status = 'boundMany';
              if (fault === 'inferred') row.provenance = 'inferred';
              if (fault === 'foreign') row.entities[0]!.handle = 4_000_000_000;
              return JSON.stringify(row);
            });
          const result = patternJournalBoundaryOutputs(
            f.kernel,
            f.journal.op,
            f.solids,
            true,
            'linear_pattern'
          );
          if (kind === 'edge') {
            expect(result).toBeNull();
            expect(
              output.mock.calls.filter(([, subject]) => subject === 'vertex')
            ).toHaveLength(0);
          } else {
            expect(result?.edges.map((members) => members.size)).toEqual([
              12, 12, 12
            ]);
            expect(result?.vertices).toBeNull();
            expect(result?.vertexUnavailableReason).toBe('journal-unavailable');
          }
          expect(f.kernel.serializeSolids(Uint32Array.from(f.solids))).toEqual(
            before
          );
        } finally {
          f.kernel.free();
        }
      }
    );
  });
});
