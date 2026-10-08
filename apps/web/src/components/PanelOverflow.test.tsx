import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PanelOverflow } from './PanelOverflow';

function renderOverflow() {
  render(
    <PanelOverflow>
      <button type="button">Delete feature</button>
    </PanelOverflow>
  );
  const summary = screen.getByLabelText('More actions');
  const menu = summary.closest('details')!;
  return { summary, menu, item: screen.getByText('Delete feature') };
}

describe('PanelOverflow', () => {
  it('returns focus to its button when Escape closes it from an item', () => {
    const { summary, menu, item } = renderOverflow();
    menu.open = true;
    act(() => item.focus());
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(menu.open).toBe(false);
    // Closing hid the focused item; focus used to fall to the body.
    expect(document.activeElement).toBe(summary);
  });

  it('leaves focus where it is when Escape closes it from elsewhere', () => {
    const { menu } = renderOverflow();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    menu.open = true;
    act(() => outside.focus());
    fireEvent.keyDown(outside, { key: 'Escape' });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
