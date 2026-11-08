import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { comparisonPage, pairCaptures } from '../scripts/lookdev-compare.mjs';

describe('lookdev comparison page', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('pairs captures by name and keeps one-sided ones', () => {
    expect(pairCaptures(['b.png', 'a.png'], ['a.png', 'c.png'])).toEqual([
      { name: 'a.png', before: true, after: true },
      { name: 'b.png', before: true, after: false },
      { name: 'c.png', before: false, after: true }
    ]);
  });

  it('links captures relative to the page instead of embedding them', () => {
    root = mkdtempSync(join(tmpdir(), 'lookdev-'));
    for (const label of ['before', 'after run']) {
      mkdirSync(join(root, label));
      writeFileSync(join(root, label, 'sphere--top.png'), 'png');
    }
    writeFileSync(join(root, 'before', 'notes.json'), '{}');
    const page = comparisonPage({
      beforeDir: join(root, 'before'),
      afterDir: join(root, 'after run'),
      out: join(root, 'comparison.html')
    });
    expect(page).toContain('src="before/sphere--top.png"');
    expect(page).toContain('src="after%20run/sphere--top.png"');
    expect(page).not.toContain('data:image');
    expect(page).not.toContain('notes.json');
    expect(page).toContain('<h2>sphere--top</h2>');
  });
});
