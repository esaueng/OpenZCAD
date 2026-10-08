import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutsOverlay } from './ShortcutsOverlay';

describe('ShortcutsOverlay', () => {
  it('is named by the title it shows', () => {
    render(<ShortcutsOverlay onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Controls' });
    expect(
      within(dialog).getByRole('heading', { name: 'Controls' })
    ).toBeInTheDocument();
  });

  it('lets the keyboard reach and scroll the whole list', () => {
    // Close was the only tab stop, so the half of the reference below the
    // fold could not be scrolled into view without a mouse.
    render(<ShortcutsOverlay onClose={vi.fn()} />);
    const list = screen.getByRole('region', { name: 'Controls list' });
    expect(list).toHaveClass('shortcuts-grid');
    expect(list.tabIndex).toBe(0);
    expect(
      within(list).getByRole('heading', { name: 'Context & direct modeling' })
    ).toBeInTheDocument();
  });
});
