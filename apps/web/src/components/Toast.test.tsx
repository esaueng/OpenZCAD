import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastHost } from './Toast';
import {
  TOAST_EXIT_MS,
  TOAST_LIFETIME_MS,
  type ToastModel
} from '../lib/toasts';

function toast(overrides: Partial<ToastModel> = {}): ToastModel {
  return { id: 1, message: 'Deleted Boss', ...overrides };
}

/** The visible card; the live region beside it carries the message. */
function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.toast');
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
    fireEvent.mouseEnter(card()!);
    act(() => {
      vi.advanceTimersByTime(TOAST_LIFETIME_MS * 2);
    });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(card()!);
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

    fireEvent.keyDown(card()!, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('stays mounted for the closing fade, then leaves', () => {
    const { rerender } = render(
      <ToastHost toast={toast()} onDismiss={vi.fn()} />
    );
    rerender(<ToastHost toast={null} onDismiss={vi.fn()} />);
    expect(card()).toHaveClass('closing');

    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS);
    });
    expect(card()).toBeNull();
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
    expect(document.querySelectorAll('.toast')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Exported part.step');
    expect(card()).toHaveTextContent('Exported part.step');
    expect(card()).not.toHaveClass('closing');
  });
});

/** The toast with its host's state, as App holds it: dismiss clears it. */
function Host({ initial }: { initial: ToastModel }) {
  const [current, setCurrent] = useState<ToastModel | null>(initial);
  hostSetToast = setCurrent;
  return (
    <ToastHost
      toast={current}
      onDismiss={(id) =>
        setCurrent((shown) => (shown?.id === id ? null : shown))
      }
    />
  );
}
let hostSetToast: (toast: ToastModel | null) => void = () => {};

describe('ToastHost after an action', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs its action once, however fast the second click lands', () => {
    // The card stays mounted for its exit fade; a double-click's second
    // press reached the same Undo and undid a second step.
    const run = vi.fn();
    render(<Host initial={toast({ action: { label: 'Undo', run } })} />);
    const undo = screen.getByRole('button', { name: 'Undo' });
    fireEvent.click(undo);
    fireEvent.click(undo);
    expect(run).toHaveBeenCalledTimes(1);
    expect(card()).toHaveClass('closing');
    expect(card()).toHaveAttribute('inert');
  });

  it('still expires the next notice after one is dismissed from the keyboard', () => {
    // Focus went down with the card and no blur reached React, so the hold
    // it had set outlived it and the next notice never expired.
    render(<Host initial={toast()} />);
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    act(() => dismiss.focus());
    fireEvent.click(dismiss);
    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS);
    });
    expect(card()).toBeNull();

    act(() => hostSetToast(toast({ id: 2, message: 'Exported part.step' })));
    expect(card()).toHaveTextContent('Exported part.step');
    act(() => {
      vi.advanceTimersByTime(TOAST_LIFETIME_MS);
    });
    expect(card()).toHaveClass('closing');
    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS);
    });
    expect(card()).toBeNull();
  });

  it('hands focus back to where it came from after acting', () => {
    const run = vi.fn();
    render(
      <>
        <button type="button">Canvas</button>
        <Host initial={toast({ action: { label: 'Undo', run } })} />
      </>
    );
    const canvas = screen.getByRole('button', { name: 'Canvas' });
    act(() => canvas.focus());
    const undo = screen.getByRole('button', { name: 'Undo' });
    act(() => undo.focus());
    // Enter or Space on a button: a click with no pointer count.
    fireEvent.click(undo, { detail: 0 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(canvas).toHaveFocus();
  });

  it('leaves focus alone after a pointer press', () => {
    // The element focus came from may be the command bar, which focus
    // would reopen.
    render(
      <>
        <button type="button">Canvas</button>
        <Host initial={toast()} />
      </>
    );
    const canvas = screen.getByRole('button', { name: 'Canvas' });
    act(() => canvas.focus());
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    act(() => dismiss.focus());
    fireEvent.click(dismiss, { detail: 1 });
    expect(canvas).not.toHaveFocus();
  });

  it('keeps one live region mounted between notices', () => {
    // Inserted already holding its text, the region went unannounced by
    // several screen readers; it now stands empty and the text lands in it.
    render(<Host initial={toast()} />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Deleted Boss');
    expect(region).not.toContainElement(
      screen.getByRole('button', { name: 'Dismiss' })
    );
    act(() => hostSetToast(null));
    act(() => {
      vi.advanceTimersByTime(TOAST_EXIT_MS);
    });
    expect(card()).toBeNull();
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toBeEmptyDOMElement();

    act(() => hostSetToast(toast({ id: 3, message: 'Suppressed Sketch 01' })));
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Suppressed Sketch 01');
  });
});
