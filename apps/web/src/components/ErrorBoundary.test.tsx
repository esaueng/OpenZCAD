import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getActivityLogSnapshot,
  resetActivityLogForTests
} from '../lib/activityLog';
import {
  ErrorBoundary,
  PANEL_AUTO_RETRY_DELAY_MS,
  PANEL_AUTO_RETRY_WINDOW_MS
} from './ErrorBoundary';

function Throws({ error }: { error: Error }): never {
  throw error;
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderFailing(error: Error, scope?: 'panel' | 'page') {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return render(
      <ErrorBoundary label="OpenZCAD workspace" scope={scope}>
        <Throws error={error} />
      </ErrorBoundary>
    );
  }

  it('does not claim a deployment from a failed chunk download', () => {
    renderFailing(
      new TypeError('Failed to fetch dynamically imported module: /a.js'),
      'page'
    );
    expect(
      screen.getByRole('heading', { name: 'Part of OpenZCAD could not load' })
    ).toBeTruthy();
    expect(screen.queryByText(/could not be rendered/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Reload workspace' })
    ).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check your connection'
    );
    expect(screen.queryByText(/new version was released/i)).toBeNull();
    expect(screen.queryByText('Error details')).toBeNull();
  });

  it('keeps the crash title at page scope and offers the error detail', () => {
    renderFailing(new Error('boom'), 'page');
    expect(
      screen.getByRole('heading', {
        name: 'OpenZCAD workspace could not be rendered.'
      })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Reload workspace' })
    ).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('keeps the page a main landmark and alerts with the message alone', () => {
    renderFailing(new Error('boom'), 'page');
    expect(
      screen.getByRole('main', {
        name: 'OpenZCAD workspace could not be rendered.'
      })
    ).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'An unexpected error stopped the workspace. Reload to recover.'
    );
  });

  it('stays an inline panel fallback by default', () => {
    vi.useFakeTimers();
    const { container } = renderFailing(new Error('boom'));
    act(() => {
      vi.advanceTimersByTime(PANEL_AUTO_RETRY_DELAY_MS);
    });
    expect(container.querySelector('.error-boundary')).not.toBeNull();
    expect(container.querySelector('.error-page')).toBeNull();
  });

  /** Throws while `failures.left` is positive, then renders. */
  function Flaky({ failures }: { failures: { left: number } }) {
    if (failures.left > 0) {
      failures.left -= 1;
      throw new Error('transient');
    }
    return <p>panel content</p>;
  }

  function renderFlaky(left: number) {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failures = { left };
    render(
      <ErrorBoundary label="3D viewer">
        <Flaky failures={failures} />
      </ErrorBoundary>
    );
    return failures;
  }

  it('remounts a crashed panel once on its own, without a reload', () => {
    // React renders a throwing child twice before giving up on it.
    renderFlaky(2);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(PANEL_AUTO_RETRY_DELAY_MS);
    });
    expect(screen.getByText('panel content')).toBeTruthy();
  });

  it('leaves a persistent crash to the user and retries it in place', () => {
    const failures = renderFlaky(Number.POSITIVE_INFINITY);
    act(() => {
      vi.advanceTimersByTime(PANEL_AUTO_RETRY_DELAY_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      '3D viewer could not be rendered.'
    );
    // No second automatic attempt inside the window.
    act(() => {
      vi.advanceTimersByTime(PANEL_AUTO_RETRY_WINDOW_MS);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Reload workspace' })
    ).toBeTruthy();
    failures.left = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('panel content')).toBeTruthy();
  });

  it('does not promise an in-place retry for a failed chunk download', () => {
    vi.useFakeTimers();
    renderFailing(
      new TypeError('Failed to fetch dynamically imported module: /a.js')
    );
    act(() => {
      vi.advanceTimersByTime(PANEL_AUTO_RETRY_DELAY_MS);
    });
    // A quiet line, not an alert: the reload is optional.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'OpenZCAD workspace did not load.'
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Reload workspace' })
    ).toHaveAttribute('title', expect.stringMatching(/check your connection/i));
  });

  it('keeps the whole-app fallback on a reload', () => {
    vi.useFakeTimers();
    renderFailing(new Error('boom'), 'page');
    act(() => {
      vi.advanceTimersByTime(PANEL_AUTO_RETRY_DELAY_MS);
    });
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Reload workspace' })
    ).toBeTruthy();
  });

  it('names what broke on the card and in the activity log', () => {
    resetActivityLogForTests();
    renderFlaky(Number.POSITIVE_INFINITY);
    act(() => {
      vi.advanceTimersByTime(PANEL_AUTO_RETRY_DELAY_MS);
    });
    expect(screen.getByText('Error details')).toBeTruthy();
    expect(screen.getByText('transient')).toBeTruthy();
    const crashes = getActivityLogSnapshot().entries.filter(
      (entry) => entry.message === '3D viewer crashed: transient'
    );
    // The first crash, which the automatic remount hid, is recorded too.
    expect(crashes.length).toBeGreaterThanOrEqual(2);
    expect(crashes[0]).toMatchObject({ level: 'error', source: 'error' });
  });
});
