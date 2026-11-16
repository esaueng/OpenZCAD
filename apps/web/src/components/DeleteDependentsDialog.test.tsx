import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteDependentsDialog } from './DeleteDependentsDialog';

describe('DeleteDependentsDialog', () => {
  it('names the steps built on the detail and focuses Delete them too', () => {
    const onDeleteAll = vi.fn();
    const onCancel = vi.fn();
    render(
      <DeleteDependentsDialog
        name="Chamfer"
        dependents={['Fillet 2', 'Remove Blend']}
        onCancel={onCancel}
        onDeleteAll={onDeleteAll}
      />
    );
    const dialog = screen.getByRole('alertdialog', {
      name: 'Delete “Chamfer”?'
    });
    expect(dialog).toHaveTextContent(
      '2 later features were built on Chamfer and cannot rebuild without it:'
    );
    expect(
      screen.getAllByRole('listitem').map((item) => item.textContent)
    ).toEqual(['Fillet 2', 'Remove Blend']);
    const confirm = screen.getByRole('button', { name: 'Delete them too' });
    expect(confirm).toHaveFocus();
    fireEvent.click(confirm);
    expect(onDeleteAll).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels on Escape and on Cancel, and counts what it does not name', () => {
    const onCancel = vi.fn();
    render(
      <DeleteDependentsDialog
        name="Hole"
        dependents={Array.from(
          { length: 8 },
          (_, index) => `Fillet ${index + 1}`
        )}
        onCancel={onCancel}
        onDeleteAll={vi.fn()}
      />
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByText('and 2 more')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('uses the singular for one dependent', () => {
    render(
      <DeleteDependentsDialog
        name="Chamfer"
        dependents={['Fillet 2']}
        onCancel={vi.fn()}
        onDeleteAll={vi.fn()}
      />
    );
    expect(
      screen.getByText(
        '1 later feature was built on Chamfer and cannot rebuild without it:'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete it too' })
    ).toBeInTheDocument();
  });
});
