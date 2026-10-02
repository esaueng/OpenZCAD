import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteFeatureDialog } from './DeleteFeatureDialog';

describe('DeleteFeatureDialog', () => {
  it('names the dependents and focuses Delete so Del then Enter deletes', () => {
    const onDelete = vi.fn();
    const onCancel = vi.fn();
    render(
      <DeleteFeatureDialog
        name="Box"
        dependents={['Union', 'Fillet', 'Hole']}
        onCancel={onCancel}
        onDelete={onDelete}
      />
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Box”?' });
    expect(dialog).toHaveTextContent(
      '3 later features build on it and will rebuild without it:'
    );
    expect(
      screen.getAllByRole('listitem').map((item) => item.textContent)
    ).toEqual(['Union', 'Fillet', 'Hole']);
    const remove = screen.getByRole('button', { name: 'Delete' });
    expect(remove).toHaveFocus();
    fireEvent.click(remove);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels on Escape and counts what it does not name', () => {
    const onCancel = vi.fn();
    render(
      <DeleteFeatureDialog
        name="Plate"
        dependents={Array.from(
          { length: 9 },
          (_, index) => `Hole ${index + 1}`
        )}
        onCancel={onCancel}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByText('and 3 more')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('uses the singular for one dependent', () => {
    render(
      <DeleteFeatureDialog
        name="Sketch"
        dependents={['Extrude']}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(
      screen.getByText(
        '1 later feature builds on it and will rebuild without it:'
      )
    ).toBeInTheDocument();
  });
});
