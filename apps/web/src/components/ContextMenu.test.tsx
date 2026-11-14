import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';

describe('ContextMenu', () => {
  it('shows why a disabled item is unavailable and does not run it', () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu
        menu={{
          x: 10,
          y: 10,
          heading: 'Block',
          items: [
            {
              id: 'duplicate',
              label: 'Duplicate',
              disabled: true,
              detail: 'Duplicate covers Move, Mirror and Pattern steps only.'
            },
            { id: 'delete', label: 'Delete' }
          ]
        }}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const item = screen.getByRole('menuitem', { name: /^Duplicate/ });
    expect(item).toBeDisabled();
    expect(item).toHaveTextContent('Move, Mirror and Pattern steps only');
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onSelect).toHaveBeenCalledWith('delete');
  });

  it('marks an item that opens another menu', () => {
    render(
      <ContextMenu
        menu={{
          x: 10,
          y: 10,
          items: [
            { id: 'other', label: 'Select other', submenu: true },
            { id: 'fit', label: 'Fit view' }
          ]
        }}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    const other = screen.getByRole('menuitem', { name: 'Select other' });
    expect(other).toHaveAttribute('aria-haspopup', 'menu');
    expect(other.querySelector('.context-menu-submenu')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    expect(
      screen.getByRole('menuitem', { name: 'Fit view' })
    ).not.toHaveAttribute('aria-haspopup');
  });
});
