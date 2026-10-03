import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShortcutKeys } from './ShortcutKeys';

describe('ShortcutKeys', () => {
  it('draws each modifier glyph as an icon, since no bundled font has one', () => {
    const { container } = render(
      <kbd>
        <ShortcutKeys label="⇧⌘Z" />
      </kbd>
    );
    const glyphs = container.querySelectorAll('.shortcut-glyph');
    expect(glyphs).toHaveLength(2);
    for (const glyph of glyphs) {
      expect(glyph.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
        'true'
      );
    }
    // The characters stay in the text, so the label still reads as written.
    expect(container.querySelector('kbd')?.textContent).toBe('⇧⌘Z');
  });

  it('leaves a label without Apple modifiers as plain text', () => {
    const { container } = render(
      <kbd>
        <ShortcutKeys label="Ctrl+K" />
      </kbd>
    );
    expect(container.querySelector('.shortcut-glyph')).toBeNull();
    expect(container.querySelector('kbd')?.innerHTML).toBe('Ctrl+K');
  });
});
