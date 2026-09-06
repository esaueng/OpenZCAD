import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ViewportDockExtras, WorkspaceReadout } from './WorkspaceReadout';

describe('WorkspaceReadout', () => {
  it('shows the live status as a toast that opens the activity log', async () => {
    const user = userEvent.setup();
    const onToggleLog = vi.fn();
    render(
      <WorkspaceReadout
        status="Fillet added"
        statusAt={Date.now()}
        tone="ready"
        logOpen={false}
        onToggleLog={onToggleLog}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Fillet added');
    await user.click(screen.getByRole('button', { name: /Open activity log/ }));
    expect(onToggleLog).toHaveBeenCalledTimes(1);
  });

  it('shows nothing while a tool card carries the message, or with none', () => {
    const { rerender } = render(
      <WorkspaceReadout
        status="The resulting body wouldn't be valid."
        tone="warning"
        muted
        logOpen={false}
        onToggleLog={vi.fn()}
      />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(
      <WorkspaceReadout
        status=""
        tone="ready"
        logOpen={false}
        onToggleLog={vi.fn()}
      />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('ViewportDockExtras', () => {
  it('cycles the selection filter and opens the log from the dock', async () => {
    const user = userEvent.setup();
    const onSelectionFilter = vi.fn();
    const onToggleLog = vi.fn();
    render(
      <ViewportDockExtras
        selectionFilter="any"
        selectionFilterIsAutomatic
        onSelectionFilter={onSelectionFilter}
        snap={{ spacing: 1, units: 'mm', enabled: true }}
        logOpen={false}
        onToggleLog={onToggleLog}
        logTriggerRef={createRef<HTMLButtonElement>()}
      />
    );
    await user.click(
      screen.getByRole('button', { name: /Selection filter: Any/ })
    );
    expect(onSelectionFilter).toHaveBeenCalledTimes(1);
    expect(onSelectionFilter.mock.calls[0]?.[0]).not.toBe('any');
    expect(screen.getByText('Snap 1 mm')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open activity log' }));
    expect(onToggleLog).toHaveBeenCalledTimes(1);
  });
});
