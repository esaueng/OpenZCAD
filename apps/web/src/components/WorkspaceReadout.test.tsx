import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MIN_DWELL_MS } from '../hooks/usePacedStatus';
import {
  ActivityLogButton,
  ViewportDockExtras,
  WorkspaceReadout
} from './WorkspaceReadout';

const SUMMARY = {
  prompt: 'Click a body, face, or edge · Shift+Click adds to selection',
  projectName: 'Bracket',
  featureCount: 2,
  bodyCount: 1,
  warningCount: 0,
  documentVersion: 3,
  saveState: 'synced' as const,
  searchBar: <input role="combobox" aria-label="Search commands" />
};

describe('WorkspaceReadout', () => {
  it('puts the guidance over the search bar while the toast is quiet', () => {
    const { container, rerender } = render(
      <WorkspaceReadout
        status=""
        tone="ready"
        logOpen={false}
        onToggleLog={vi.fn()}
        {...SUMMARY}
      />
    );
    // Drawn for sighted users only: the summary already speaks the prompt.
    const hint = container.querySelector('.workspace-hint');
    expect(hint).toHaveTextContent('Click a body, face, or edge');
    expect(hint).toHaveAttribute('aria-hidden', 'true');
    // The lane stacks the guidance over the bar the host hands in.
    const bar = screen.getByRole('combobox', { name: 'Search commands' });
    expect(hint?.parentElement).toBe(
      container.querySelector('.command-bar-lane')
    );
    expect(hint?.nextElementSibling).toBe(bar);
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

describe('WorkspaceReadout pacing', () => {
  it('holds a message through a burst, then shows the latest with a count', () => {
    vi.useFakeTimers();
    try {
      const readout = (status: string) => (
        <WorkspaceReadout
          status={status}
          statusAt={Date.now()}
          tone="ready"
          logOpen={false}
          onToggleLog={vi.fn()}
          {...SUMMARY}
        />
      );
      const { container, rerender } = render(readout('Opening Bracket'));
      for (const step of ['Loading', 'Rebuilding', 'Tessellating']) {
        act(() => {
          vi.advanceTimersByTime(40);
        });
        rerender(readout(step));
      }
      rerender(readout('Reopened Bracket.'));
      expect(screen.getByRole('status')).toHaveTextContent('Opening Bracket');
      expect(container.querySelector('.workspace-toast-more')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
      });
      expect(screen.getByRole('status')).toHaveTextContent('Reopened Bracket.');
      expect(
        container.querySelector('.workspace-toast-more')
      ).toHaveTextContent('+3');
      // The button still names the live message for assistive tech.
      expect(
        screen.getByRole('button', {
          name: 'Open activity log. Current status: Reopened Bracket.'
        })
      ).toHaveAttribute(
        'title',
        'Reopened Bracket. — 3 more in the activity log'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ViewportDockExtras', () => {
  it('cycles the selection filter and reads the snap', async () => {
    const user = userEvent.setup();
    const onSelectionFilter = vi.fn();
    render(
      <ViewportDockExtras
        selectionFilter="any"
        selectionFilterIsAutomatic
        onSelectionFilter={onSelectionFilter}
        snap={{ spacing: 1, units: 'mm', enabled: true }}
      />
    );
    await user.click(
      screen.getByRole('button', { name: /Selection filter: Any/ })
    );
    expect(onSelectionFilter).toHaveBeenCalledTimes(1);
    expect(onSelectionFilter.mock.calls[0]?.[0]).not.toBe('any');
    // The word and the value are separate nodes, so the compact readout can
    // swap the word for a glyph; together they still read "Snap 1 mm".
    expect(screen.getByTitle('Sketch snap: 1 mm')).toHaveTextContent(
      'Snap 1 mm'
    );
    // The log's button left the readout for the instrument rail.
    expect(screen.queryByRole('button', { name: /activity log/ })).toBeNull();
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
      />
    );
    await user.click(
      screen.getByRole('button', { name: /Selection filter: Sketch/ })
    );
    expect(onSelectionFilter).toHaveBeenCalledWith(null);
  });
});

describe('ActivityLogButton', () => {
  it('is a rail button that names its state and opens the log', async () => {
    const user = userEvent.setup();
    const onToggleLog = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <ActivityLogButton
        logOpen={false}
        onToggleLog={onToggleLog}
        logTriggerRef={ref}
      />
    );
    const button = screen.getByRole('button', { name: 'Open activity log' });
    expect(button).toHaveClass('rail-button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // The log returns focus here when it closes.
    expect(ref.current).toBe(button);
    await user.click(button);
    expect(onToggleLog).toHaveBeenCalledTimes(1);
    rerender(
      <ActivityLogButton
        logOpen
        onToggleLog={onToggleLog}
        logTriggerRef={ref}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Close activity log' })
    ).toHaveClass('active');
  });
});
