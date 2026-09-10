import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLTIP_OPEN_DELAY_MS, Tooltip } from './Tooltip';

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits 300 ms before opening from pointer hover', () => {
    render(
      <Tooltip label="Box" shortcut="B" description="Create a box">
        <button type="button">Box tool</button>
      </Tooltip>
    );
    const trigger = screen.getByRole('button', { name: 'Box tool' });

    fireEvent.pointerEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY_MS - 1);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('BoxBCreate a box');
    expect(trigger).toHaveAttribute(
      'aria-describedby',
      screen.getByRole('tooltip').id
    );
  });

  it('opens immediately from keyboard focus and closes on Escape', () => {
    const onKeyDown = vi.fn();
    render(
      <Tooltip label="Fit view" shortcut="F">
        <button type="button" onKeyDown={onKeyDown}>
          Fit
        </button>
      </Tooltip>
    );
    const trigger = screen.getByRole('button', { name: 'Fit' });

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Fit viewF');

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(trigger).not.toHaveAttribute('aria-describedby');
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it('opens a sibling instantly during the 200 ms hand-off window', () => {
    render(
      <>
        <Tooltip label="Undo">
          <button type="button">Undo</button>
        </Tooltip>
        <Tooltip label="Redo">
          <button type="button">Redo</button>
        </Tooltip>
      </>
    );
    const undo = screen.getByRole('button', { name: 'Undo' });
    const redo = screen.getByRole('button', { name: 'Redo' });

    fireEvent.pointerEnter(undo);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY_MS);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Undo');

    fireEvent.pointerLeave(undo);
    fireEvent.pointerEnter(redo);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Redo');
  });
});
