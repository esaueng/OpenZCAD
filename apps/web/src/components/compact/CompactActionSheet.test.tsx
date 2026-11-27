import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CompactActionSheet from './CompactActionSheet';

const MENU = {
  x: 10,
  y: 10,
  heading: 'Box 1',
  items: [
    { id: 'edit', label: 'Edit properties' },
    {
      id: 'duplicate',
      label: 'Duplicate',
      disabled: true,
      detail: 'Duplicate covers Move and Mirror steps only.'
    },
    { id: 'delete', label: 'Delete', danger: true, section: true }
  ]
};

describe('CompactActionSheet', () => {
  it('lists the menu’s items under its heading, with a reason on a disabled one', () => {
    render(
      <CompactActionSheet menu={MENU} onSelect={vi.fn()} onClose={vi.fn()} />
    );
    const sheet = screen.getByRole('menu', { name: 'Box 1' });
    expect(sheet).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: /^Duplicate/ })).toBeDisabled();
    expect(
      screen.getByText('Duplicate covers Move and Mirror steps only.')
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass(
      'is-danger'
    );
  });

  it('runs an item and closes', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <CompactActionSheet menu={MENU} onSelect={onSelect} onClose={onClose} />
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit properties' }));
    expect(onSelect).toHaveBeenCalledWith('edit');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Cancel, Escape and a tap outside, running nothing', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <CompactActionSheet menu={MENU} onSelect={onSelect} onClose={onClose} />
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerDown(
      container.querySelector('.compact-action-sheet-scrim')!
    );
    // A press on the sheet itself is not outside it.
    fireEvent.pointerDown(container.querySelector('.compact-action-sheet')!);
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('is deaf while it fades out', () => {
    const onClose = vi.fn();
    const { container } = render(
      <CompactActionSheet
        menu={MENU}
        closing
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );
    expect(
      container.querySelector('.compact-action-sheet-scrim')
    ).toHaveAttribute('inert');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
