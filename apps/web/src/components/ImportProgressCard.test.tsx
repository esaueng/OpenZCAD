import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportProgressCard, elapsedLabel } from './ImportProgressCard';
import {
  IMPORT_CARD_DELAY_MS,
  IMPORT_CARD_SUCCESS_LINGER_MS,
  type ImportRunOutcome,
  type ImportRunState
} from '../lib/importProgress';

function running(
  overrides: Partial<ImportRunState> = {}
): ImportRunState {
  return {
    id: 'run-1',
    fileName: 'assembly.step',
    phases: ['saving', 'reading', 'building', 'archiving'],
    progress: { phase: 'saving', fraction: 0.5 },
    cancelRequested: false,
    outcome: null,
    ...overrides
  };
}

function settled(outcome: ImportRunOutcome): ImportRunState {
  return running({ outcome });
}

function renderCard(run: ImportRunState | null) {
  const onDismiss = vi.fn();
  const onArchiveNow = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ImportProgressCard
      run={run}
      onDismiss={onDismiss}
      onArchiveNow={onArchiveNow}
      onCancel={onCancel}
    />
  );
  return { ...view, onDismiss, onArchiveNow, onCancel };
}

/** Advances past the appearance threshold, ticking the card's own interval. */
function passDelay() {
  act(() => {
    vi.advanceTimersByTime(IMPORT_CARD_DELAY_MS + 100);
  });
}

function bar(): HTMLElement {
  const element = document.querySelector('.import-card-bar');
  if (!(element instanceof HTMLElement)) {
    throw new Error('The card rendered no bar.');
  }
  return element;
}

describe('ImportProgressCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when no import is running', () => {
    renderCard(null);
    expect(screen.queryByLabelText('File import')).toBeNull();
  });

  /**
   * A panel that flashes on screen for a third of a second and vanishes reads
   * as a glitch, not as feedback. Small imports finish inside this window and
   * must never produce one.
   */
  it('stays hidden until the import has run long enough to be worth a panel', () => {
    renderCard(running());
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
    renderCard(settled({ tone: 'error', message: 'Not imported — refused' }));
    expect(screen.getByText('Not imported — refused')).toBeTruthy();
  });

  it('stays hidden for a quiet success inside the delay window', () => {
    renderCard(settled({ tone: 'ok', message: 'Imported — 1 body' }));
    expect(screen.queryByLabelText('File import')).toBeNull();
  });

  it('names the file and the phase in plain words', () => {
    renderCard(running());
    passDelay();
    expect(screen.getByText('assembly.step')).toBeTruthy();
    expect(screen.getByText('Saving to this device')).toBeTruthy();
  });

  /**
   * The kernel phase is one synchronous wasm call: it can report neither a
   * percentage nor a heartbeat. The bar has to say so by holding still and
   * striping, rather than by filling to a number nobody measured.
   */
  it('holds and stripes the bar for a phase that cannot report', () => {
    renderCard(running({ progress: { phase: 'building', fraction: null } }));
    passDelay();
    expect(bar().className).toContain('indeterminate');
    expect(screen.getByText('Building geometry')).toBeTruthy();
    const parked = (bar().firstElementChild as HTMLElement).style.width;

    // Ten seconds of the kernel working and the clock ticking. The bar must
    // not have crept a single percent, because nothing measured one.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('11 s')).toBeTruthy();
    expect((bar().firstElementChild as HTMLElement).style.width).toBe(parked);
    expect(bar().className).toContain('indeterminate');
  });

  it('fills the bar as a measurable phase advances', () => {
    const { rerender, onDismiss, onArchiveNow } = renderCard(
      running({ progress: { phase: 'archiving', fraction: 0.25 } })
    );
    passDelay();
    const quarter = Number.parseInt(
      (bar().firstElementChild as HTMLElement).style.width,
      10
    );
    rerender(
      <ImportProgressCard
        run={running({ progress: { phase: 'archiving', fraction: 0.75 } })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    const threeQuarters = Number.parseInt(
      (bar().firstElementChild as HTMLElement).style.width,
      10
    );
    expect(bar().className).not.toContain('indeterminate');
    expect(threeQuarters).toBeGreaterThan(quarter);
  });

  /**
   * A refusal stops where it stopped. Completing the bar would say the import
   * finished, and the position is itself information: the file was stored and
   * read, and the geometry is what failed.
   */
  it('leaves the bar where a refusal stopped it', () => {
    renderCard(
      settled({ tone: 'error', message: 'Not imported — no closed solids' })
    );
    const width = Number.parseInt(
      (bar().firstElementChild as HTMLElement).style.width,
      10
    );
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(100);
    expect(bar().className).toContain('error');
  });

  it('completes the bar when a body actually landed', () => {
    renderCard(
      settled({
        tone: 'warning',
        message: 'Imported, but saved on this device only',
        action: 'archive'
      })
    );
    expect((bar().firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('offers the archive retry only for the ending that leaves work to do', () => {
    const { onArchiveNow } = renderCard(
      settled({
        tone: 'warning',
        message: 'Imported, but saved on this device only',
        action: 'archive'
      })
    );
    screen.getByRole('button', { name: 'Archive now' }).click();
    expect(onArchiveNow).toHaveBeenCalledTimes(1);
  });

  it('offers no action for a refusal, which leaves nothing to retry', () => {
    renderCard(settled({ tone: 'error', message: 'Not imported' }));
    expect(screen.queryByRole('button', { name: 'Archive now' })).toBeNull();
  });

  it('offers to hide, not to cancel, while the import is running', () => {
    const { onDismiss } = renderCard(running());
    passDelay();
    const button = screen.getByRole('button', {
      name: 'Hide import progress'
    });
    expect(button.getAttribute('title')).toContain('keeps running');
    button.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('takes a successful card away on its own', () => {
    const { rerender, onDismiss, onArchiveNow } = renderCard(running());
    passDelay();
    rerender(
      <ImportProgressCard
        run={settled({ tone: 'ok', message: 'Imported — 1 body' })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('Imported — 1 body')).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(IMPORT_CARD_SUCCESS_LINGER_MS + 50);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('leaves an ending that needs attention on screen', () => {
    const { onDismiss } = renderCard(
      settled({ tone: 'error', message: 'Not imported' })
    );
    act(() => {
      vi.advanceTimersByTime(IMPORT_CARD_SUCCESS_LINGER_MS * 4);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  /**
   * The clock is read by a screen reader only if it sits in a live region.
   * At ten ticks a second that would be unusable, so only the phase is live.
   */
  it('announces the phase without announcing every clock tick', () => {
    renderCard(running());
    passDelay();
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('Saving to this device');
  });

  it('restarts the clock when a second import replaces the first', () => {
    const { rerender, onDismiss, onArchiveNow } = renderCard(running());
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('20 s')).toBeTruthy();
    rerender(
      <ImportProgressCard
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

describe('cancelling, from the card', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers cancel while running and not after it has ended', () => {
    const { rerender, onDismiss, onArchiveNow } = renderCard(running());
    passDelay();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    rerender(
      <ImportProgressCard
        run={settled({ tone: 'ok', message: 'Imported — 1 body' })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  /**
   * Cancel and hide want opposite things — one throws away minutes of work,
   * the other just clears the panel — so they are separate controls. Merging
   * them onto the ✕ would put the destructive one under an accidental click.
   */
  it('keeps cancel off the hide control', () => {
    const { onDismiss, onCancel } = renderCard(running());
    passDelay();
    screen.getByRole('button', { name: 'Hide import progress' }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('asks to cancel exactly once per press', () => {
    const { onCancel } = renderCard(running());
    passDelay();
    screen.getByRole('button', { name: 'Cancel' }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('acknowledges cancellation while the rebuild worker terminates', () => {
    renderCard(
      running({
        progress: { phase: 'building', fraction: null },
        cancelRequested: true
      })
    );
    passDelay();
    expect(document.querySelector('[aria-live]')?.textContent).toBe(
      'Cancelling…'
    );
    expect(screen.queryByText('Building geometry')).toBeNull();
  });

  it('says plainly it is cancelling in a phase that can stop promptly', () => {
    renderCard(
      running({
        progress: { phase: 'saving', fraction: 0.4 },
        cancelRequested: true
      })
    );
    passDelay();
    // Scoped to the announced line: the button also reads "Cancelling…".
    expect(document.querySelector('[aria-live]')?.textContent).toBe(
      'Cancelling…'
    );
  });

  it('cannot be pressed twice while it is taking effect', () => {
    const { onCancel } = renderCard(running({ cancelRequested: true }));
    passDelay();
    const button = screen.getByRole('button', { name: 'Cancelling…' });
    expect(button.hasAttribute('disabled')).toBe(true);
    button.click();
    expect(onCancel).not.toHaveBeenCalled();
  });

  /** A cancel is not a fault, so the card clears itself like a success does. */
  it('takes a cancelled card away on its own', () => {
    const { rerender, onDismiss, onArchiveNow } = renderCard(running());
    passDelay();
    rerender(
      <ImportProgressCard
        run={settled({ tone: 'cancelled', message: 'Import cancelled' })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('Import cancelled')).toBeTruthy();
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
    const { rerender, onDismiss, onArchiveNow } = renderCard(running());
    passDelay();
    rerender(
      <ImportProgressCard
        run={settled({ tone: 'cancelled', message: 'Import cancelled' })}
        onDismiss={onDismiss}
        onArchiveNow={onArchiveNow}
        onCancel={vi.fn()}
      />
    );
    const width = Number.parseInt(
      (bar().firstElementChild as HTMLElement).style.width,
      10
    );
    expect(width).toBeLessThan(100);
    expect(bar().className).toContain('cancelled');
  });

  /**
   * A cancel that lands before the card was ever worth showing shows nothing:
   * the user pressed nothing, because there was no card to press.
   */
  it('shows nothing for a cancel reached inside the delay window', () => {
    renderCard(settled({ tone: 'cancelled', message: 'Import cancelled' }));
    expect(screen.queryByLabelText('File import')).toBeNull();
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
