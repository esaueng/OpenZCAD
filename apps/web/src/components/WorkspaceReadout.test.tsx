import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ViewportDockExtras, WorkspaceReadout } from './WorkspaceReadout';

const SUMMARY = {
  prompt: 'Click a body, face, or edge · Shift+Click adds to selection',
  projectName: 'Bracket',
  featureCount: 2,
  bodyCount: 1,
  warningCount: 0,
  documentVersion: 3,
  saveState: 'synced' as const,
  onOpenSearch: () => {},
  searchKey: { glyph: '⌘K', accessible: 'Cmd+K' }
};

describe('WorkspaceReadout', () => {
  it('puts the guidance over the search bar while the toast is quiet, and the bar opens search', async () => {
    const user = userEvent.setup();
    const onOpenSearch = vi.fn();
    const { container, rerender } = render(
      <WorkspaceReadout
        status=""
        tone="ready"
        logOpen={false}
        onToggleLog={vi.fn()}
        {...SUMMARY}
        onOpenSearch={onOpenSearch}
      />
    );
    // Drawn for sighted users only: the summary already speaks the prompt.
    const hint = container.querySelector('.workspace-hint');
    expect(hint).toHaveTextContent('Click a body, face, or edge');
    expect(hint).toHaveAttribute('aria-hidden', 'true');
    await user.click(
      screen.getByRole('button', { name: 'Search commands (Cmd+K)' })
    );
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    // A live message takes the guidance's place.
    rerender(
      <WorkspaceReadout
        status="Fillet added"
        statusAt={Date.now()}
        tone="ready"
        logOpen={false}
        onToggleLog={vi.fn()}
        {...SUMMARY}
      />
    );
    expect(container.querySelector('.workspace-hint')).toBeNull();
  });

  it('hands the assistant a slot at the end of the search bar', () => {
    const onSearchSlot = vi.fn();
    render(
      <WorkspaceReadout
        status=""
        tone="ready"
        logOpen={false}
        onToggleLog={vi.fn()}
        {...SUMMARY}
        onSearchSlot={onSearchSlot}
      />
    );
    const bar = screen.getByRole('button', {
      name: 'Search commands (Cmd+K)'
    });
    expect(bar).toHaveTextContent('Search commands or ask the assistant');
    const slot = onSearchSlot.mock.calls[0]?.[0] as HTMLElement;
    expect(slot).toHaveClass('command-bar-slot');
    expect(slot.previousElementSibling).toBe(bar);
  });

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
        {...SUMMARY}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Fillet added');
    await user.click(screen.getByRole('button', { name: /Open activity log/ }));
    expect(onToggleLog).toHaveBeenCalledTimes(1);
    // The summary the status bar carried for assistive tech is still there.
    expect(
      screen.getByRole('group', { name: 'Workspace status' })
    ).toHaveTextContent('sync');
    expect(
      screen.getByLabelText('Bracket · 2 features · 1 body. Sync Synced.')
    ).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toHaveTextContent(
      'Shift+Click adds to selection'
    );
  });

  it('hides while a tool card carries the message, or with none, but stays the landmark', () => {
    const { rerender } = render(
      <WorkspaceReadout
        status="The resulting body wouldn't be valid."
        tone="warning"
        muted
        logOpen={false}
        onToggleLog={vi.fn()}
        {...SUMMARY}
      />
    );
    // Still in the tree as the contentinfo landmark, only hidden.
    expect(screen.getByRole('contentinfo')).toHaveClass('hidden');
    rerender(
      <WorkspaceReadout
        status=""
        tone="ready"
        logOpen={false}
        onToggleLog={vi.fn()}
        {...SUMMARY}
      />
    );
    expect(screen.getByRole('contentinfo')).toHaveClass('hidden');
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

  it('hands the filter back to the tool at the end of the cycle', async () => {
    const user = userEvent.setup();
    const onSelectionFilter = vi.fn();
    render(
      <ViewportDockExtras
        selectionFilter="sketch"
        selectionFilterIsAutomatic={false}
        onSelectionFilter={onSelectionFilter}
        snap={null}
        logOpen={false}
        onToggleLog={vi.fn()}
        logTriggerRef={createRef<HTMLButtonElement>()}
      />
    );
    await user.click(
      screen.getByRole('button', { name: /Selection filter: Sketch/ })
    );
    expect(onSelectionFilter).toHaveBeenCalledWith(null);
  });
});
