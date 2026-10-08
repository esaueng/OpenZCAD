import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MIN_DWELL_MS } from '../hooks/usePacedStatus';
import {
  STATUS_CLOCK_STEP_MS,
  STATUS_LIFETIME_MS
} from '../lib/statusLifetime';
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

  it('takes its log button out of the tab order while hidden', () => {
    // Faded to nothing, it was still a tab stop: focus vanished onto it and
    // Enter opened the log. The rail's log button is the keyboard path.
    const { rerender } = render(
      <WorkspaceReadout
        status="Fillet added"
        statusAt={Date.now()}
        tone="ready"
        logOpen={false}
        onToggleLog={vi.fn()}
        {...SUMMARY}
      />
    );
    const body = () => screen.getByRole('button', { name: /activity log/ });
    expect(screen.getByRole('contentinfo')).not.toHaveClass('hidden');
    expect(body().tabIndex).toBe(0);

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
    expect(body().tabIndex).toBe(-1);
    // Still in the tree with its live region, as the comment above it asks.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});

describe('WorkspaceReadout pacing', () => {
  const readout = (status: string, tone: 'ready' | 'warning' = 'ready') => (
    <WorkspaceReadout
      status={status}
      statusAt={Date.now()}
      tone={tone}
      logOpen={false}
      onToggleLog={vi.fn()}
      {...SUMMARY}
    />
  );

  it('holds a message through a routine burst, then shows the latest without a count', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(readout('Opening Bracket'));
      for (const step of ['Loading', 'Rebuilding', 'Tessellating']) {
        act(() => {
          vi.advanceTimersByTime(40);
        });
        rerender(readout(step));
      }
      rerender(readout('Reopened Bracket.'));
      expect(screen.getByRole('status')).toHaveTextContent('Opening Bracket');
      act(() => {
        vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
      });
      expect(screen.getByRole('status')).toHaveTextContent('Reopened Bracket.');
      // Progress passed over is routine: no "3 more in log" for a model that
      // simply rebuilt.
      expect(container.querySelector('.workspace-toast-more')).toBeNull();
      expect(
        screen.getByRole('button', {
          name: 'Open activity log. Current status: Reopened Bracket.'
        })
      ).toHaveAttribute('title', 'Reopened Bracket. — View activity log');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a warning or refusal the burst passed over', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(readout('Opening Bracket'));
      act(() => {
        vi.advanceTimersByTime(40);
      });
      rerender(readout('Fillet failed: radius too large', 'warning'));
      rerender(readout('Cannot use Box: This shared project is read-only.'));
      rerender(readout('Rebuilding'));
      rerender(readout('Reopened Bracket.'));
      act(() => {
        vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
      });
      expect(screen.getByRole('status')).toHaveTextContent('Reopened Bracket.');
      // The counter says what it counts, not a bare "+2".
      expect(
        container.querySelector('.workspace-toast-more')
      ).toHaveTextContent(/^2 warnings in log$/);
      expect(
        screen.getByRole('button', {
          name: 'Open activity log. Current status: Reopened Bracket.'
        })
      ).toHaveAttribute(
        'title',
        'Reopened Bracket. — 2 warnings in the activity log'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Holds the main thread for `ms`, as the viewer's first frame does while its
 * shaders compile: time passes, and timers that came due fire once, late.
 * Vitest does not expose the fake clock's jump, but the faked `setTimeout`
 * carries the clock it was installed by.
 */
function blockMainThread(ms: number) {
  const clock = (
    globalThis.setTimeout as unknown as { clock?: { jump(ms: number): void } }
  ).clock;
  if (!clock) {
    throw new Error('blockMainThread needs vi.useFakeTimers().');
  }
  act(() => {
    clock.jump(ms);
  });
}

describe('WorkspaceReadout message lifetime', () => {
  const STARTING = {
    phase: 'Starting geometry worker',
    projection: 'the model appears when it is ready'
  };
  const REFUSAL = 'Cannot use Box: This shared project is read-only.';

  function readout(
    status: string,
    statusAt: number,
    geometryStatus: typeof STARTING | null = null
  ) {
    return (
      <WorkspaceReadout
        status={status}
        statusAt={statusAt}
        geometryStatus={geometryStatus}
        tone={geometryStatus ? 'running' : 'ready'}
        logOpen={false}
        onToggleLog={vi.fn()}
        {...SUMMARY}
      />
    );
  }

  it('counts only the time the page could draw toward the lifetime', () => {
    vi.useFakeTimers();
    try {
      render(readout(REFUSAL, Date.now()));
      const toast = screen.getByRole('contentinfo');
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // Opening a project mounts the viewer, whose first frame held the main
      // thread for longer than a message lives. The refusal used to come out
      // of that already expired, never drawn.
      blockMainThread(STATUS_LIFETIME_MS + 2000);
      expect(screen.getByRole('status')).toHaveTextContent(REFUSAL);
      expect(toast).not.toHaveClass('hidden');
      // The stall counted as one late step; the rest of the lifetime is the
      // reader's, and no more.
      const left = STATUS_LIFETIME_MS - 1000 - 2 * STATUS_CLOCK_STEP_MS;
      act(() => {
        vi.advanceTimersByTime(left - STATUS_CLOCK_STEP_MS);
      });
      expect(toast).not.toHaveClass('hidden');
      act(() => {
        vi.advanceTimersByTime(2 * STATUS_CLOCK_STEP_MS);
      });
      expect(toast).toHaveClass('hidden');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not bring back a message that had expired before the readout mounted', () => {
    vi.useFakeTimers();
    try {
      render(readout('Offline workspace', Date.now() - 60_000));
      expect(screen.getByRole('contentinfo')).toHaveClass('hidden');
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws a message set behind a slow worker start in front of the phase', () => {
    vi.useFakeTimers();
    try {
      // An old message under the boot line: only the line, and it holds.
      const { rerender } = render(
        readout('Offline workspace', Date.now() - 60_000, STARTING)
      );
      const toast = screen.getByRole('contentinfo');
      expect(screen.getByRole('status')).toHaveTextContent(
        'Starting geometry worker · the model appears when it is ready'
      );
      expect(toast).not.toHaveClass('hidden');

      // The user's action answers at once, ahead of the phase, rather than
      // waiting behind the boot line for a worker that may take longer than
      // the message's whole lifetime.
      const refusedAt = Date.now();
      rerender(readout(REFUSAL, refusedAt, STARTING));
      act(() => {
        vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
      });
      expect(screen.getByRole('status')).toHaveTextContent(
        `${REFUSAL} · Starting geometry worker`
      );
      expect(
        screen.getByRole('button', {
          name: `Open activity log. Current status: ${REFUSAL} · Starting geometry worker`
        })
      ).toBeInTheDocument();

      // The message expires on its own clock; the boot line, a state rather
      // than a message, stays up on its own.
      act(() => {
        vi.advanceTimersByTime(STATUS_LIFETIME_MS);
      });
      expect(screen.getByRole('status')).toHaveTextContent(
        'Starting geometry worker · the model appears when it is ready'
      );
      expect(screen.getByRole('status')).not.toHaveTextContent('Cannot use');
      expect(toast).not.toHaveClass('hidden');

      // Geometry ready with the message long gone: the toast goes quiet.
      rerender(readout(REFUSAL, refusedAt));
      expect(toast).toHaveClass('hidden');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a live message alone once the geometry is ready', () => {
    vi.useFakeTimers();
    try {
      const openedAt = Date.now();
      const { rerender } = render(
        readout('Opened Invited Link Part.', openedAt, STARTING)
      );
      expect(screen.getByRole('status')).toHaveTextContent(
        'Opened Invited Link Part. · Starting geometry worker'
      );
      act(() => {
        vi.advanceTimersByTime(STATUS_MIN_DWELL_MS);
      });
      rerender(readout('Opened Invited Link Part.', openedAt));
      expect(screen.getByRole('status')).toHaveTextContent(
        /^Opened Invited Link Part\.$/
      );
      act(() => {
        vi.advanceTimersByTime(STATUS_LIFETIME_MS);
      });
      expect(screen.getByRole('contentinfo')).toHaveClass('hidden');
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
