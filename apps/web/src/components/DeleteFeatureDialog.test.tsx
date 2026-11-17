import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DeleteFeatureDialog } from './DeleteFeatureDialog';

describe('DeleteFeatureDialog', () => {
  it('names the dependents and focuses Cancel so a reflex Enter keeps them', () => {
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
    expect(dialog).toHaveTextContent('3 later features build on it:');
    expect(
      screen.getAllByRole('listitem').map((item) => item.textContent)
    ).toEqual(['Union', 'Fillet', 'Hole']);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    const remove = screen.getByRole('button', { name: 'Delete' });
    expect(remove).not.toHaveFocus();
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

  it('titles a History batch by its count and words the dependents for them', () => {
    render(
      <DeleteFeatureDialog
        name="3 features"
        count={3}
        dependents={['Union', 'Fillet']}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(
      screen.getByRole('alertdialog', { name: 'Delete 3 features?' })
    ).toHaveTextContent('2 later features build on them:');
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
      screen.getByText('1 later feature builds on it:')
    ).toBeInTheDocument();
  });

  it('says what deleting does to the dependents in the terms Suppress uses', () => {
    // 13 November review: Delete said the dependents "will rebuild without
    // it" while Suppress, of the same Fillet and Hole, said they "cannot
    // rebuild without it". Both are now one account: they stay and rebuild,
    // and one that needed the feature fails.
    const { rerender } = render(
      <DeleteFeatureDialog
        name="Box"
        dependents={['Fillet', 'Hole']}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Delete “Box”?' });
    expect(dialog).toHaveTextContent(
      'They stay in History, and any that cannot rebuild without it shows an error. Undo brings everything back.'
    );
    expect(dialog).not.toHaveTextContent('will rebuild without');
    rerender(
      <DeleteFeatureDialog
        name="Box"
        dependents={['Fillet']}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'It stays in History, and shows an error if it cannot rebuild without it.'
    );
  });
});
