import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SelectionCalloutOperation } from '../lib/selectionCallout';
import { EditRefusal } from './EditRefusal';

function refused(
  overrides: Partial<SelectionCalloutOperation> = {}
): SelectionCalloutOperation {
  return {
    title: 'Resize Cylinder',
    phase: 'failed',
    error: { message: 'Refused.', detail: 'kernel words' },
    onEditCulprit: vi.fn(),
    onViewDetails: vi.fn(),
    onKeepLastValid: vi.fn(),
    onSelectAllEdges: vi.fn(),
    ...overrides
  };
}

describe('EditRefusal reproduction export', () => {
  it('offers Save reproduction beside Technical details when one is held', () => {
    const onSaveReproduction = vi.fn();
    render(
      <EditRefusal
        operation={refused({ onSaveReproduction })}
        variant="control"
        unitLabel="mm"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
    expect(
      screen.getByRole('button', { name: 'Technical details' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save reproduction' }));
    expect(onSaveReproduction).toHaveBeenCalledOnce();
  });

  it('offers no export when no refused rebuild is held', () => {
    render(
      <EditRefusal operation={refused()} variant="control" unitLabel="mm" />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
    expect(
      screen.queryByRole('button', { name: 'Save reproduction' })
    ).toBeNull();
  });
});
