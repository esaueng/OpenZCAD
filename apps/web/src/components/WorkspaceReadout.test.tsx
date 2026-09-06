import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceReadout } from './WorkspaceReadout';

describe('WorkspaceReadout', () => {
  it('shows the live status, and the hint once it goes quiet', () => {
    render(
      <WorkspaceReadout
        status="Fillet added"
        statusAt={Date.now()}
        tone="ready"
        hint="Click a face"
        snap={null}
        selectionFilter="any"
        selectionFilterIsAutomatic={false}
        onSelectionFilter={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Fillet added');
    // The message opens the activity log, as the status bar's did.
    expect(
      screen.getByRole('button', { name: /Open activity log/ })
    ).toBeInTheDocument();
  });

  it('keeps only the corner facts while a tool card carries the message', () => {
    render(
      <WorkspaceReadout
        status="The resulting body wouldn't be valid."
        tone="warning"
        hint="Try another value"
        snap={{ spacing: 1, units: 'mm', enabled: true }}
        muted
        selectionFilter="any"
        selectionFilterIsAutomatic={false}
        onSelectionFilter={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.getByText('Snap 1 mm')).toBeInTheDocument();
  });

  it('cycles the selection filter from the corner', async () => {
    const user = userEvent.setup();
    const onSelectionFilter = vi.fn();
    render(
      <WorkspaceReadout
        status=""
        tone="ready"
        hint={null}
        snap={null}
        selectionFilter="any"
        selectionFilterIsAutomatic
        onSelectionFilter={onSelectionFilter}
      />
    );
    await user.click(
      screen.getByRole('button', { name: /Selection filter: Any/ })
    );
    expect(onSelectionFilter).toHaveBeenCalledTimes(1);
    expect(onSelectionFilter.mock.calls[0]?.[0]).not.toBe('any');
  });
});
