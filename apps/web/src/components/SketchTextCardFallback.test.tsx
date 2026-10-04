/**
 * The loading stand-in must catch the first letters typed after `T`, so they
 * become text rather than workspace shortcuts.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { isTypingTarget } from '../lib/exactEntryShortcut';
import { SketchTextCardFallback } from './SketchTextCardFallback';

function Harness() {
  const [text, setText] = useState('');
  return (
    <>
      <SketchTextCardFallback text={text} onText={setText} />
      <output data-testid="draft">{text}</output>
    </>
  );
}

describe('SketchTextCardFallback', () => {
  it('takes focus at once and writes what is typed into the draft', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByLabelText('Text');
    expect(document.activeElement).toBe(field);
    // The workspace's shortcut handler ignores keys from a typing target, so
    // `l` and `a` here are letters, not the Line and Arc tools.
    expect(isTypingTarget(document.activeElement as HTMLElement)).toBe(true);
    await user.keyboard('lab');
    expect(screen.getByTestId('draft')).toHaveTextContent('lab');
  });
});
