import { describe, expect, it, vi } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { decodeRemusPatternJournal } from './remus-lineage';
import { patternJournalBoundaryOutputs } from './exact-lineage-builders';

function fixture(count = 3) {
  const kernel = new RemusKernel();
  const source = kernel.makeBox(10, 10, 10);
  const journal = decodeRemusPatternJournal(
    kernel.linearPatternJournaled(source, 1, 0, 0, 30, count)
  );
  const solids = Array.from(kernel.getCompoundSolids(journal.compound));
  return { kernel, source, journal, solids };
}

describe('explicit LINEAR construction subject qualification', () => {
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
