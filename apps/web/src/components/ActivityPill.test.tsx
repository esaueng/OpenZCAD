import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityPill, elapsedLabel } from './ActivityPill';
import {
  IMPORT_CARD_DELAY_MS,
  IMPORT_CARD_SUCCESS_LINGER_MS,
  type ImportRunOutcome,
  type ImportRunState
} from '../lib/importProgress';

function running(overrides: Partial<ImportRunState> = {}): ImportRunState {
  return {
    id: 'run-1',
    kind: 'import',
    fileName: 'assembly.step',
    cancellable: true,
    phases: ['saving', 'reading', 'building', 'archiving'],
    progress: { phase: 'saving', fraction: 0.5 },
    cancelRequested: false,
    outcome: null,
    ...overrides
  };
}

function settled(
  outcome: ImportRunOutcome,
  overrides: Partial<ImportRunState> = {}
): ImportRunState {
  return running({ outcome, ...overrides });
}

function renderPill(run: ImportRunState | null) {
  const onDismiss = vi.fn();
  const onArchiveNow = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ActivityPill
      run={run}
      onDismiss={onDismiss}
      onArchiveNow={onArchiveNow}
      onCancel={onCancel}
    />
  );
  return { ...view, onDismiss, onArchiveNow, onCancel };
}

/** Advances past the appearance threshold, ticking the pill's own interval. */
function passDelay() {
  act(() => {
    vi.advanceTimersByTime(IMPORT_CARD_DELAY_MS + 100);
  });
}

function bar(): HTMLElement {
  const element = document.querySelector('.activity-pill-bar');
  if (!(element instanceof HTMLElement)) {
    throw new Error('The pill rendered no bar.');
  }
  return element;
}

function barWidth(): number {
  return Number.parseInt(
    (bar().firstElementChild as HTMLElement).style.width,
    10
  );
}

/** The announced line: verb, file name and detail, without the clock. */
function announced(): string {
  return document.querySelector('[aria-live="polite"]')?.textContent ?? '';
}

describe('ActivityPill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when nothing is running', () => {
    renderPill(null);
    expect(screen.queryByLabelText('File import')).toBeNull();
  });

  /**
   * A pill that flashes on screen for a third of a second and vanishes reads
   * as a glitch, not as feedback. Small imports finish inside this window and
   * must never produce one.
   */
  it('stays hidden until the run has gone on long enough to be worth a pill', () => {
    renderPill(running());
    act(() => {
      vi.advanceTimersByTime(IMPORT_CARD_DELAY_MS - 200);
    });
    expect(screen.queryByLabelText('File import')).toBeNull();
    passDelay();
    expect(screen.getByLabelText('File import')).toBeTruthy();
  });

  /**
   * The exception to the delay: a fast import that went wrong, or that landed
   * without archiving its source, still has something the user needs to see.
   */
  it('appears immediately for an ending that needs attention', () => {
    renderPill(settled({ tone: 'error', message: 'the file was refused' }));
    expect(announced()).toBe('Not imported assembly.stepthe file was refused');
  });

  it('stays hidden for a quiet success inside the delay window', () => {
    const { onDismiss } = renderPill(
      settled({ tone: 'ok', message: '1 body', landed: true })
    );
    expect(screen.queryByLabelText('File import')).toBeNull();
    // The run state clears at once, and the host is told nothing was shown.
    expect(onDismiss).toHaveBeenCalledWith(false);
  });

  it('reads verb, file and phase as one line', () => {
    renderPill(running());
    passDelay();
    expect(announced()).toBe('Importing assembly.stepSaving to this device');
  });

  it('conjugates the verb for the kind of run', () => {
    renderPill(
      running({
        kind: 'export',
        fileName: 'bracket.step',
        phases: ['building', 'writing', 'archiving'],
        progress: { phase: 'building', fraction: null }
      })
    );
    passDelay();
    expect(announced()).toBe('Exporting bracket.stepBuilding geometry');
    expect(screen.getByLabelText('File export')).toBeTruthy();
  });

  /**
   * The kernel phase is one synchronous wasm call: it can report neither a
   * percentage nor a heartbeat. The bar has to say so by holding still and
   * striping, rather than by filling to a number nobody measured.
   */
  it('holds and stripes the bar for a phase that cannot report', () => {
    renderPill(running({ progress: { phase: 'building', fraction: null } }));
    passDelay();
    expect(bar().className).toContain('indeterminate');
    expect(announced()).toContain('Building geometry');
    const parked = barWidth();

    // Ten seconds of the kernel working and the clock ticking. The bar must
    // not have crept a single percent, because nothing measured one.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('11 s')).toBeTruthy();
    expect(barWidth()).toBe(parked);
    expect(bar().className).toContain('indeterminate');
  });

  it('fills the bar as a measurable phase advances', () => {
    const { rerender, onDismiss, onArchiveNow } = renderPill(
      running({ progress: { phase: 'archiving', fraction: 0.25 } })
    );
    passDelay();
    const quarter = barWidth();
    rerender(
      <ActivityPill
        run={running({ progress: { phase: 'archiving', fraction: 0.75 } })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    expect(bar().className).not.toContain('indeterminate');
    expect(barWidth()).toBeGreaterThan(quarter);
  });

  /**
   * A refusal stops where it stopped. Completing the bar would say the import
   * finished, and the position is itself information: the file was stored and
   * read, and the geometry is what failed.
   */
  it('leaves the bar where a refusal stopped it', () => {
    renderPill(settled({ tone: 'error', message: 'no closed solids' }));
    expect(barWidth()).toBeGreaterThan(0);
    expect(barWidth()).toBeLessThan(100);
    expect(bar().className).toContain('error');
  });

  it('completes the bar when the file actually landed', () => {
    renderPill(
      settled({
        tone: 'warning',
        message: 'saved on this device only',
        landed: true,
        action: 'archive'
      })
    );
    expect(barWidth()).toBe(100);
    expect(announced()).toBe('Imported assembly.stepsaved on this device only');
  });

  /** An amber ending that landed nothing is a refusal, and says so. */
  it('says "not imported" for a warning that landed nothing', () => {
    renderPill(
      settled({
        tone: 'warning',
        message: 'the model kept changing while it rebuilt'
      })
    );
    expect(announced()).toBe(
      'Not imported assembly.stepthe model kept changing while it rebuilt'
    );
    expect(barWidth()).toBeLessThan(100);
  });

  it('offers the archive retry only for the ending that leaves work to do', () => {
    const { onArchiveNow } = renderPill(
      settled({
        tone: 'warning',
        message: 'saved on this device only',
        landed: true,
        action: 'archive'
      })
    );
    screen.getByRole('button', { name: 'Archive now' }).click();
    expect(onArchiveNow).toHaveBeenCalledTimes(1);
  });

  it('offers no action for a refusal, which leaves nothing to retry', () => {
    renderPill(settled({ tone: 'error', message: 'refused' }));
    expect(screen.queryByRole('button', { name: 'Archive now' })).toBeNull();
  });

  /**
   * A running pill has no ✕: hiding it would hide the only cancel, and the
   * ✕ next to a Cancel read as a second, gentler cancel. Its ending clears
   * itself or waits to be dismissed, which is when the ✕ appears.
   */
  it('offers dismiss only for an ending that waits to be seen', () => {
    const { rerender, onDismiss, onArchiveNow } = renderPill(running());
    passDelay();
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull();
    rerender(
      <ActivityPill
        run={settled({ tone: 'error', message: 'refused' })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    screen.getByRole('button', { name: 'Dismiss import status' }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('takes a successful pill away on its own', () => {
    const { rerender, onDismiss, onArchiveNow } = renderPill(running());
    passDelay();
    rerender(
      <ActivityPill
        run={settled({ tone: 'ok', message: '1 body', landed: true })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    expect(announced()).toBe('Imported assembly.step1 body');
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(IMPORT_CARD_SUCCESS_LINGER_MS + 50);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(true);
  });

  it('leaves an ending that needs attention on screen', () => {
    const { onDismiss } = renderPill(
      settled({ tone: 'error', message: 'refused' })
    );
    act(() => {
      vi.advanceTimersByTime(IMPORT_CARD_SUCCESS_LINGER_MS * 4);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  /**
   * The clock is read by a screen reader only if it sits in a live region.
   * At ten ticks a second that would be unusable, so the clock is a sibling
   * of the announced line.
   */
  it('announces the line without announcing every clock tick', () => {
    renderPill(running());
    passDelay();
    expect(announced()).not.toMatch(/\d s$/);
    expect(screen.getByText('0.7 s')).toBeTruthy();
  });

  it('stops the clock once the run has ended', () => {
    renderPill(settled({ tone: 'error', message: 'refused' }));
    expect(document.querySelector('.activity-pill-time')).toBeNull();
  });

  it('restarts the clock when a second run replaces the first', () => {
    const { rerender, onDismiss, onArchiveNow } = renderPill(running());
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('20 s')).toBeTruthy();
    rerender(
      <ActivityPill
        run={running({ id: 'run-2', fileName: 'bracket.step' })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByLabelText('File import')).toBeNull();
    passDelay();
    expect(screen.getByText('bracket.step')).toBeTruthy();
    expect(screen.queryByText('20 s')).toBeNull();
  });
});

describe('cancelling, from the pill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers cancel while running and not after it has ended', () => {
    const { rerender, onDismiss, onArchiveNow } = renderPill(running());
    passDelay();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    rerender(
      <ActivityPill
        run={settled({ tone: 'ok', message: '1 body', landed: true })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  /** A restore mid-write cannot stop halfway, so it offers no cancel. */
  it('offers no cancel for a run that cannot stop', () => {
    renderPill(
      running({
        kind: 'restore',
        cancellable: false,
        fileName: 'bracket.openzcad',
        phases: ['reading', 'saving'],
        progress: { phase: 'reading', fraction: null }
      })
    );
    passDelay();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(announced()).toBe('Restoring bracket.openzcadReading the file');
  });

  it('asks to cancel exactly once per press', () => {
    const { onCancel } = renderPill(running());
    passDelay();
    screen.getByRole('button', { name: 'Cancel' }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('acknowledges cancellation while the rebuild worker terminates', () => {
    renderPill(
      running({
        progress: { phase: 'building', fraction: null },
        cancelRequested: true
      })
    );
    passDelay();
    expect(announced()).toBe('Importing assembly.stepCancelling…');
    expect(screen.queryByText('Building geometry')).toBeNull();
  });

  it('cannot be pressed twice while it is taking effect', () => {
    const { onCancel } = renderPill(running({ cancelRequested: true }));
    passDelay();
    const button = screen.getByRole('button', { name: 'Cancelling…' });
    expect(button.hasAttribute('disabled')).toBe(true);
    button.click();
    expect(onCancel).not.toHaveBeenCalled();
  });

  /** A cancel is not a fault, so the pill clears itself like a success does. */
  it('takes a cancelled pill away on its own', () => {
    const { rerender, onDismiss, onArchiveNow } = renderPill(running());
    passDelay();
    rerender(
      <ActivityPill
        run={settled({ tone: 'cancelled', message: 'nothing was added' })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    expect(announced()).toBe('Import cancelled assembly.stepnothing was added');
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(IMPORT_CARD_SUCCESS_LINGER_MS + 50);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  /**
   * Nothing landed, so the bar must not complete — it stops where the import
   * stopped, the same as a refusal does.
   */
  it('leaves the bar where the cancel stopped it', () => {
    // Visible first, then settled: a quiet ending reached inside the delay
    // window shows nothing at all, which is a separate rule tested below.
    const { rerender, onDismiss, onArchiveNow } = renderPill(running());
    passDelay();
    rerender(
      <ActivityPill
        run={settled({ tone: 'cancelled', message: 'nothing was added' })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    expect(barWidth()).toBeLessThan(100);
    expect(bar().className).toContain('cancelled');
  });

  /**
   * A cancel that lands before the pill was ever worth showing shows nothing:
   * the user pressed nothing, because there was no pill to press.
   */
  it('shows nothing for a cancel reached inside the delay window', () => {
    const { onDismiss } = renderPill(
      settled({ tone: 'cancelled', message: 'nothing was added' })
    );
    expect(screen.queryByLabelText('File import')).toBeNull();
    expect(onDismiss).toHaveBeenCalledWith(false);
  });
});

describe('elapsedLabel', () => {
  it('shows tenths while the number needs to look alive', () => {
    expect(elapsedLabel(0)).toBe('0.0 s');
    expect(elapsedLabel(4300)).toBe('4.3 s');
  });

  it('drops to whole seconds once tenths stop meaning anything', () => {
    expect(elapsedLabel(12_400)).toBe('12 s');
  });

  it('uses minutes for the imports that actually take them', () => {
    expect(elapsedLabel(72_000)).toBe('1:12');
    expect(elapsedLabel(312_000)).toBe('5:12');
  });

  /** 59.7 s rounds to 60, which must not be rendered as "3:60". */
  it('carries a rounded-up minute instead of printing :60', () => {
    expect(elapsedLabel(3 * 60_000 + 59_700)).toBe('4:00');
  });

  it('never renders a negative clock', () => {
    expect(elapsedLabel(-500)).toBe('0.0 s');
  });
});
