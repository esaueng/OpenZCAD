import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { RemusKernel, loadRemusTranslators } from './remus-runtime';
import {
  importStepWithOwnBudget,
  readStepImportReport,
  stepImportEmptyReason
} from './kernel-step-import';

const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'test',
  'parity',
  'corpus'
);

function corpusStep(id: string): Uint8Array {
  return new Uint8Array(readFileSync(join(CORPUS, `${id}.step`)));
}

describe('the STEP reader report', () => {
  it('reads the counts the pinned reader returns', () => {
    expect(
      readStepImportReport('{"solidCount":2,"sheetCount":1,"diagnostics":[]}')
    ).toEqual({
      solidCount: 2,
      sheetCount: 1,
      diagnostics: [],
      diagnosticCount: 0
    });
  });

  /**
   * Every corpus file reports an empty diagnostics list on this pin, so the
   * entry shape is unverified. Both readable spellings are accepted and an
   * entry that is neither is counted rather than quoted — a disclosure this
   * adapter cannot render must still show up as one that happened.
   */
  it('renders the diagnostic spellings it can and counts the rest', () => {
    const report = readStepImportReport({
      solidCount: 1,
      sheetCount: 0,
      diagnostics: ['sewed 3 gaps', { message: 'dropped a degenerate edge' }, 7]
    });
    expect(report.diagnostics).toEqual([
      'sewed 3 gaps',
      'dropped a degenerate edge'
    ]);
    expect(report.diagnosticCount).toBe(3);
  });

  it('treats an absent diagnostics field as nothing to report', () => {
    expect(
      readStepImportReport('{"solidCount":0,"sheetCount":0}').diagnosticCount
    ).toBe(0);
  });

  it('raises rather than guessing when a count is missing', () => {
    expect(() => readStepImportReport('{"sheetCount":0}')).toThrow(
      /missing its "solidCount" count/
    );
    expect(() => readStepImportReport('not json')).toThrow(
      /unreadable STEP import result/
    );
  });

  it('names surface-only bodies instead of reading as an empty file', () => {
    expect(
      stepImportEmptyReason({
        solidCount: 0,
        sheetCount: 3,
        diagnostics: [],
        diagnosticCount: 0
      })
    ).toBe(
      'STEP file contains no solids: its 3 bodies are surfaces, which this ' +
        'exact modeler cannot adopt as a solid.'
    );
    expect(
      stepImportEmptyReason({
        solidCount: 0,
        sheetCount: 1,
        diagnostics: [],
        diagnosticCount: 0
      })
    ).toContain('its 1 body is a surface');
    expect(
      stepImportEmptyReason({
        solidCount: 0,
        sheetCount: 0,
        diagnostics: [],
        diagnosticCount: 0
      })
    ).toBe('STEP file contains no solids.');
  });
});

describe('importStepWithReport against the pinned reader', () => {
  beforeAll(async () => {
    await loadRemusTranslators();
  });

  /**
   * The load-bearing equivalence for this migration: the reporting reader
   * must hand back the same solid document as `importStep`, or adopting it
   * would change which geometry is imported and not merely what is said
   * about it. Checked by volume on the restored solids.
   */
  it.each([
    ['a-export-bored-plate', 1, [8814.6018]],
    ['d-multi-two-boxes', 2, [1000, 216]]
  ])('restores %s identically', (id, solidCount, volumes) => {
    const kernel = new RemusKernel();
    try {
      const imported = importStepWithOwnBudget(kernel, corpusStep(id));
      expect(imported.report.solidCount).toBe(solidCount);
      expect(imported.report.sheetCount).toBe(0);
      expect(imported.report.diagnosticCount).toBe(0);
      expect(Array.from(imported.solids)).toHaveLength(solidCount);
      Array.from(imported.solids).forEach((solid, index) => {
        expect(kernel.volume(solid, 0.01)).toBeCloseTo(volumes[index]!, 3);
      });
    } finally {
      kernel.free();
    }
  });

  it('reports no solid roots for a file that declares none', () => {
    const kernel = new RemusKernel();
    try {
      const imported = importStepWithOwnBudget(
        kernel,
        corpusStep('f-hostile-no-shape-representation')
      );
      expect(Array.from(imported.solids)).toEqual([]);
      expect(imported.report).toEqual({
        solidCount: 0,
        sheetCount: 0,
        diagnostics: [],
        diagnosticCount: 0
      });
      expect(stepImportEmptyReason(imported.report)).toBe(
        'STEP file contains no solids.'
      );
    } finally {
      kernel.free();
    }
  });

  /**
   * The reader has no typed refusal on the pin: a parse failure and a budget
   * breach both arrive as a bare Error carrying its prose, from
   * `importStepWithReport` exactly as from `importStep`. Pinned here so the
   * limit recorded in HANDOFF.md is a measured fact rather than a claim, and
   * so a future kernel that DOES categorise these is noticed.
   */
  it('still throws untyped prose for an unparseable file', () => {
    const kernel = new RemusKernel();
    try {
      expect(() =>
        importStepWithOwnBudget(
          kernel,
          corpusStep('f-hostile-dangling-reference')
        )
      ).toThrow(/parse error/);
    } finally {
      kernel.free();
    }
  });
});
