import { describe, expect, it } from 'vitest';
import { shareLinkCopyName } from './shareLinkCopy';

describe('shareLinkCopyName', () => {
  it('keeps the shared name exactly when the visitor has no project by it', () => {
    expect(shareLinkCopyName('Lucky Quokka', ['Bracket'])).toBe('Lucky Quokka');
    expect(shareLinkCopyName('  Lucky Quokka ', [])).toBe('  Lucky Quokka ');
  });

  it('adds the copy suffix only on a clash, compared as the shelf does', () => {
    expect(shareLinkCopyName('Lucky Quokka', ['lucky quokka '])).toBe(
      'Lucky Quokka (copy)'
    );
    expect(
      shareLinkCopyName('Lucky Quokka', ['Lucky Quokka', 'Lucky Quokka (copy)'])
    ).toBe('Lucky Quokka (copy 2)');
  });

  it('keeps a shared name that already reads "(copy)" when it is free', () => {
    expect(shareLinkCopyName('Lucky Quokka (copy)', [])).toBe(
      'Lucky Quokka (copy)'
    );
  });

  it('never splits a character at the length limit', () => {
    const fits = `${'a'.repeat(198)}\u{1F600}`;
    expect(shareLinkCopyName(fits, [])).toBe(fits);
    const over = `${'a'.repeat(199)}\u{1F600}`;
    const copy = shareLinkCopyName(over, []);
    expect(copy).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(copy.length).toBeLessThanOrEqual(200);
  });

  it('names a blank shared model as any duplicate is named', () => {
    expect(shareLinkCopyName('   ', [])).toBe('Untitled (copy)');
  });
});
