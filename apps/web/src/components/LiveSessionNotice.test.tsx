import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_SESSION_CONNECTING,
  LiveSessionNotice
} from './LiveSessionNotice';

// Design review I10: "Waiting for the project edit lease" replaced every tool
// description and offered no way on. One notice says it in plain words.
describe('LiveSessionNotice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says it is connecting, without lease jargon, and offers Retry only once it stalls', () => {
    const onRetry = vi.fn();
    render(<LiveSessionNotice onRetry={onRetry} stallMs={8_000} />);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(LIVE_SESSION_CONNECTING);
    expect(notice).not.toHaveTextContent(/lease/i);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(notice).toHaveTextContent('Still connecting');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    // Retrying starts the wait again.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers no Retry when no retry can help', () => {
    render(<LiveSessionNotice stallMs={10} />);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
