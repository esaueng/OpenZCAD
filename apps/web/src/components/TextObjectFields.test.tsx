import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { FONT_FAMILIES } from '@openzcad/geometry';
import {
  TextObjectFields,
  previewFontFamily,
  type TextAttributes
} from './TextObjectFields';

function Harness({ initial }: { initial: TextAttributes }) {
  const [value, setValue] = useState(initial);
  return <TextObjectFields value={value} onChange={setValue} />;
}

const TEXT: TextAttributes = {
  text: 'Boa',
  fontFamily: 'open-sans',
  fontStyle: 'regular'
};

describe('TextObjectFields', () => {
  it('previews each family through a font-family list the browser keeps', () => {
    // `inherit` is a CSS-wide keyword and invalid inside a family list: the
    // whole declaration was dropped and no option previewed its face.
    for (const family of FONT_FAMILIES) {
      const value = previewFontFamily(family.id);
      expect(value).toContain(`"openzcad-preview-${family.id}"`);
      expect(value).not.toMatch(/\b(inherit|initial|unset|revert)\b/);
    }
    render(<Harness initial={TEXT} />);
    const select = screen.getByLabelText('Font');
    expect(select.getAttribute('style')).toContain(
      'openzcad-preview-open-sans'
    );
    expect(select.getAttribute('style')).not.toContain('inherit');
    for (const option of Array.from(select.querySelectorAll('option'))) {
      expect(option.getAttribute('style')).toContain(
        `openzcad-preview-${option.value}`
      );
      expect(option.getAttribute('style')).not.toContain('inherit');
    }
  });

  it('names the style toggles by what they do, not by their glyphs', () => {
    render(<Harness initial={TEXT} />);
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('moves the alignment with the arrow keys from one tab stop', async () => {
    const user = userEvent.setup();
    render(<Harness initial={TEXT} />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual([
      'Align left',
      'Align center',
      'Align right'
    ]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    radios[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveFocus();
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);

    await user.keyboard('{End}');
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    // Past the last wraps round to the first.
    await user.keyboard('{ArrowDown}');
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0]).toHaveFocus();
  });
});
