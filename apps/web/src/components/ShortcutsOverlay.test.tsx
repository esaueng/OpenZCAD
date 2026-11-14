import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutsOverlay } from './ShortcutsOverlay';

describe('ShortcutsOverlay', () => {
  it('offers a modeling workflow and returns to the workspace tour', () => {
    const onTour = vi.fn();
    render(<ShortcutsOverlay onClose={vi.fn()} onTour={onTour} />);
    expect(
      screen.getByRole('heading', { name: 'Modeling guide' })
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open modeling guide' })
    );
    expect(onTour).toHaveBeenCalledOnce();
  });
  it('is named by the title it shows', () => {
    render(<ShortcutsOverlay onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Help & controls' });
    expect(
      within(dialog).getByRole('heading', { name: 'Help & controls' })
    ).toBeInTheDocument();
  });

  it('writes keys as the workspace does, and the mode key as a step (I21, I24)', () => {
    render(<ShortcutsOverlay onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Help & controls' });
    const keys = Array.from(dialog.querySelectorAll('kbd')).map(
      (kbd) => kbd.textContent ?? ''
    );
    // happy-dom is not a Mac: "Ctrl+…", as tooltips and menus write it.
    expect(keys).toContain('Ctrl+Shift+M');
    expect(keys.some((key) => key.includes('Ctrl/Cmd'))).toBe(false);
    expect(keys.some((key) => key.includes(' + '))).toBe(false);
    expect(within(dialog).getByText('Next workspace mode')).toBeVisible();
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
