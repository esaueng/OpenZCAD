import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from './Toast';
import { TOAST_EXIT_MS, TOAST_LIFETIME_MS, type ToastModel } from '../lib/toasts';

function toast(overrides: Partial<ToastModel> = {}): ToastModel {
  return { id: 1, message: 'Deleted Boss', ...overrides };
}

describe('ToastHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the message and expires on its own', () => {
    const onDismiss = vi.fn();
    render(<ToastHost toast={toast()} onDismiss={onDismiss} />);
    expect(screen.getByRole('status')).toHaveTextContent('Deleted Boss');

    act(() => {
      vi.advanceTimersByTime(TOAST_LIFETIME_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('waits while the pointer is on it', () => {
    const onDismiss = vi.fn();
    render(<ToastHost toast={toast()} onDismiss={onDismiss} />);
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => {
      vi.advanceTimersByTime(TOAST_LIFETIME_MS * 2);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => {
      vi.advanceTimersByTime(TOAST_LIFETIME_MS);
    });
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('runs the action and then dismisses', () => {
    const onDismiss = vi.fn();
    const run = vi.fn();
    render(
      <ToastHost
        toast={toast({ action: { label: 'Undo', run } })}
        onDismiss={onDismiss}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it('dismisses from its own close control and from Escape while focused', () => {
    const onDismiss = vi.fn();
    render(<ToastHost toast={toast()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('status'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('stays mounted for the closing fade, then leaves', () => {
    const { rerender } = render(
      <ToastHost toast={toast()} onDismiss={vi.fn()} />
    );
    rerender(<ToastHost toast={null} onDismiss={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveClass('closing');

    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('replaces the current notice with the newest one', () => {
    const { rerender } = render(
      <ToastHost toast={toast()} onDismiss={vi.fn()} />
    );
    rerender(
      <ToastHost
        toast={toast({ id: 2, message: 'Exported part.step (1 body)' })}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Exported part.step');
    expect(screen.getByRole('status')).not.toHaveClass('closing');
  });
});
