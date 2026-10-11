import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SuppressFeatureDialog } from './SuppressFeatureDialog';

describe('SuppressFeatureDialog', () => {
  it('names the dependents and focuses Suppress them too', () => {
    const onSuppressAll = vi.fn();
    const onCancel = vi.fn();
    render(
      <SuppressFeatureDialog
        name="Boss"
        dependents={['Place boss on wall', 'Union boss', 'Fillet']}
        onCancel={onCancel}
        onSuppressAll={onSuppressAll}
      />
    );
    const dialog = screen.getByRole('alertdialog', {
      name: 'Suppress “Boss”?'
    });
    expect(dialog).toHaveTextContent(
      'Boss is used by 3 later features that cannot rebuild without it:'
    );
    expect(dialog.textContent).not.toMatch(/body_/);
    expect(
      screen.getAllByRole('listitem').map((item) => item.textContent)
    ).toEqual(['Place boss on wall', 'Union boss', 'Fillet']);
    const confirm = screen.getByRole('button', { name: 'Suppress them too' });
    expect(confirm).toHaveFocus();
    fireEvent.click(confirm);
    expect(onSuppressAll).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels on Escape and on Cancel, and counts what it does not name', () => {
    const onCancel = vi.fn();
    render(
      <SuppressFeatureDialog
        name="Plate"
        dependents={Array.from(
          { length: 8 },
          (_, index) => `Hole ${index + 1}`
        )}
        onCancel={onCancel}
        onSuppressAll={vi.fn()}
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
      <SuppressFeatureDialog
        name="Sketch"
        dependents={['Extrude']}
        onCancel={vi.fn()}
        onSuppressAll={vi.fn()}
      />
    );
    expect(
      screen.getByText(
        'Sketch is used by 1 later feature that cannot rebuild without it:'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Suppress it too' })
    ).toBeInTheDocument();
  });
});
