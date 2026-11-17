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

  // QA 2026-11-14 finding #18: "Technical details" navigated away from the
  // workspace to Settings › Activity log. It now opens the kernel's words in
  // place, and leaves the workspace only when asked to.
  it('shows the technical details in place without leaving the workspace', () => {
    const operation = refused({
      error: {
        message: 'A face next to this one is curved.',
        detail:
          'Remus draft refused: the draft moves a corner of curved face 139'
      }
    });
    render(
      <EditRefusal operation={operation} variant="control" unitLabel="mm" />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
    expect(screen.queryByText(/curved face 139/)).toBeNull();
    const technical = screen.getByRole('button', { name: 'Technical details' });
    expect(technical).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(technical);
    expect(technical).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText(
        'Remus draft refused: the draft moves a corner of curved face 139'
      )
    ).toBeVisible();
    expect(operation.onViewDetails).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open activity log' }));
    expect(operation.onViewDetails).toHaveBeenCalledOnce();
    fireEvent.click(technical);
    expect(screen.queryByText(/curved face 139/)).toBeNull();
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
