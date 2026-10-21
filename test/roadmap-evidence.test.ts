import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRepo,
  evidenceColumn,
  FRAGMENT_DIR,
  foldEvidence,
  foldRepo,
  parseFragment,
  ROADMAP_PATH,
  splitRow
} from '../scripts/roadmap-evidence.mjs';

/** A miniature ledger with the table shapes the real one uses. */
const LEDGER = [
  '# Roadmap',
  '',
  '| Master ID | Status | Scope and evidence |',
  '| --- | --- | --- |',
  '| A01 | In review | Glimpse counters. |',
  '',
  '| ID | Status | Outcome and completion evidence | Legacy scope |',
  '| --- | --- | --- | --- |',
  '| <a id="h02"></a>H02 | Partial | Cache reuse; `a \\| b` stays one cell. | old |',
  '| <a id="m10"></a>M10 | Planned | — | old |',
  '',
  '| ID | Priority / phase / evidence | State |',
  '| --- | --- | --- |',
  '| <a id="perf-n04"></a>PERF-N04 | P1 / 3 / M | Pending |',
  '',
  'Prose mentioning | A01 | outside a table.'
].join('\n');

const fragment = (
  row: string,
  evidence: string,
  state?: string,
  name = `${row.toLowerCase()}--x.md`
) => ({
  name,
  row,
  evidence,
  ...(state === undefined ? {} : { state })
});

const rowOf = (markdown: string, id: string) =>
  markdown
    .split('\n')
    .find((line) => line.startsWith(`| ${id}`) || line.includes(`id="${id}"`));

describe('roadmap evidence fragments', () => {
  it('parses front matter and folds body line breaks', () => {
    expect(
      parseFragment(
        'h02--x.md',
        '---\nrow: H02\nstate: Done\n---\nFirst line\nsecond line.\n'
      )
    ).toEqual({
      name: 'h02--x.md',
      row: 'H02',
      state: 'Done',
      evidence: 'First line second line.'
    });
  });

  it('refuses fragments the fold could not place', () => {
    expect(() => parseFragment('a.md', 'no front matter')).toThrow(
      /front matter/
    );
    expect(() => parseFragment('a.md', '---\nstate: Done\n---\ntext')).toThrow(
      /needs a row/
    );
    expect(() =>
      parseFragment('a.md', '---\nrow: A01\nowner: me\n---\ntext')
    ).toThrow(/unknown/);
    expect(() => parseFragment('a.md', '---\nrow: A01\n---\n  \n')).toThrow(
      /no evidence/
    );
  });

  it('keeps escaped and code-span pipes inside their cell', () => {
    expect(splitRow('| a | `x | y` | b \\| c |')).toEqual([
      'a',
      '`x | y`',
      'b \\| c'
    ]);
  });

  it('appends to the evidence column and leaves other rows byte-identical', () => {
    const out = foldEvidence(LEDGER, [
      fragment('A01', 'Live delivery verified.')
    ]);
    expect(rowOf(out, 'A01')).toBe(
      '| A01 | In review | Glimpse counters. Live delivery verified. |'
    );
    expect(out.replace(rowOf(out, 'A01')!, '')).toBe(
      LEDGER.replace(rowOf(LEDGER, 'A01')!, '')
    );
  });

  it('targets the evidence column even when it is not the last one', () => {
    const out = foldEvidence(LEDGER, [fragment('h02', 'PR #805.', 'Done')]);
    expect(splitRow(rowOf(out, 'h02')!)).toEqual([
      '<a id="h02"></a>H02',
      'Done',
      'Cache reuse; `a \\| b` stays one cell. PR #805.',
      'old'
    ]);
  });

  it('replaces an empty evidence cell and escapes pipes in the fragment', () => {
    const out = foldEvidence(LEDGER, [fragment('M10', 'Copies a|b.')]);
    expect(splitRow(rowOf(out, 'm10')!)[2]).toBe('Copies a\\|b.');
  });

  it('never appends prose to a structured slash column', () => {
    expect(evidenceColumn(['ID', 'Priority / phase / evidence', 'State'])).toBe(
      2
    );
    const out = foldEvidence(LEDGER, [fragment('PERF-N04', 'Measured.')]);
    expect(splitRow(rowOf(out, 'perf-n04')!)).toEqual([
      '<a id="perf-n04"></a>PERF-N04',
      'P1 / 3 / M',
      'Pending Measured.'
    ]);
  });

  it('applies several fragments for one row in file-name order', () => {
    const out = foldEvidence(LEDGER, [
      fragment('A01', 'Second.', undefined, 'a01--b.md'),
      fragment('A01', 'First.', undefined, 'a01--a.md')
    ]);
    expect(rowOf(out, 'A01')).toContain('Glimpse counters. First. Second.');
  });

  it('refuses unknown rows and competing state changes without writing', () => {
    expect(() => foldEvidence(LEDGER, [fragment('Z99', 'x')])).toThrow(
      /matches 0 ledger rows/
    );
    expect(() =>
      foldEvidence(LEDGER, [
        fragment('A01', 'x', 'Done', 'a01--a.md'),
        fragment('A01', 'y', 'Blocked', 'a01--b.md')
      ])
    ).toThrow(/already sets the state/);
  });

  it('folds a repository and deletes only the folded fragments', () => {
    const root = mkdtempSync(join(tmpdir(), 'roadmap-evidence-'));
    try {
      writeFileSync(join(root, ROADMAP_PATH), LEDGER);
      mkdirSync(join(root, FRAGMENT_DIR), { recursive: true });
      writeFileSync(join(root, FRAGMENT_DIR, 'README.md'), '# not a fragment');
      writeFileSync(
        join(root, FRAGMENT_DIR, 'a01--live.md'),
        '---\nrow: A01\n---\nLive.\n'
      );
      expect(checkRepo(root)).toHaveLength(1);
      expect(foldRepo(root)).toHaveLength(1);
      expect(readFileSync(join(root, ROADMAP_PATH), 'utf8')).toContain(
        'Glimpse counters. Live. |'
      );
      expect(existsSync(join(root, FRAGMENT_DIR, 'a01--live.md'))).toBe(false);
      expect(existsSync(join(root, FRAGMENT_DIR, 'README.md'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses badly named fragments', () => {
    const root = mkdtempSync(join(tmpdir(), 'roadmap-evidence-'));
    try {
      writeFileSync(join(root, ROADMAP_PATH), LEDGER);
      mkdirSync(join(root, FRAGMENT_DIR), { recursive: true });
      writeFileSync(
        join(root, FRAGMENT_DIR, 'A01 notes.md'),
        '---\nrow: A01\n---\nx\n'
      );
      expect(() => checkRepo(root)).toThrow(/<row>--<slug>\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts every pending fragment in this repository', () => {
    expect(() => checkRepo()).not.toThrow();
  });
});
