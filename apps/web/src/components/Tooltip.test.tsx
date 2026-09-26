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

  describe('on a vertical rail', () => {
    const boxes: Record<string, DOMRect> = {};
    const box = (left: number, top: number, width: number, height: number) =>
      new DOMRect(left, top, width, height);

    beforeEach(() => {
      vi.spyOn(
        HTMLElement.prototype,
        'getBoundingClientRect'
      ).mockImplementation(function (this: HTMLElement) {
        const key =
          this.getAttribute('role') === 'tooltip'
            ? 'tooltip'
            : (this.getAttribute('aria-label') ?? '');
        return boxes[key] ?? box(0, 0, 0, 0);
      });
      boxes.tooltip = box(0, 0, 200, 24);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const renderRail = (style?: { flexDirection: 'column' | 'row' }) =>
      render(
        <div role="toolbar" aria-label="Rail" style={style}>
          <Tooltip label="Parts" description="Show the parts list">
            <button type="button" aria-label="Parts">
              P
            </button>
          </Tooltip>
        </div>
      );

    it('opens beside the rail instead of over its next buttons', () => {
      boxes.Rail = box(20, 300, 40, 120);
      boxes.Parts = box(25, 305, 30, 30);
      renderRail({ flexDirection: 'column' });

      fireEvent.focus(screen.getByRole('button', { name: 'Parts' }));
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveAttribute('data-placement', 'right');
      // Rail's right edge plus the 8 px gap, centred on the button.
      expect(parseFloat(tooltip.style.left)).toBeCloseTo(68, 6);
      expect(parseFloat(tooltip.style.top)).toBeCloseTo(320, 6);
    });

    it('drops the description beside an open flyout', () => {
      boxes.Rail = box(20, 300, 40, 120);
      boxes.Parts = box(25, 305, 30, 30);
      boxes.Flyout = box(68, 100, 320, 500);
      render(
        <>
          <div
            role="toolbar"
            aria-label="Rail"
            style={{ flexDirection: 'column' }}
          >
            <Tooltip label="Parts" description="Show the parts list">
              <button type="button" aria-label="Parts">
                P
              </button>
            </Tooltip>
          </div>
          <div data-rail-flyouts="">
            <aside aria-label="Flyout" />
          </div>
        </>
      );

      fireEvent.focus(screen.getByRole('button', { name: 'Parts' }));
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveAttribute('data-placement', 'right');
      expect(tooltip).toHaveTextContent(/^Parts$/);
    });

    it('keeps the description when the flyout is elsewhere', () => {
      boxes.Rail = box(20, 300, 40, 120);
      boxes.Parts = box(25, 305, 30, 30);
      boxes.Flyout = box(600, 100, 320, 500);
      render(
        <>
          <div
            role="toolbar"
            aria-label="Rail"
            style={{ flexDirection: 'column' }}
          >
            <Tooltip label="Parts" description="Show the parts list">
              <button type="button" aria-label="Parts">
                P
              </button>
            </Tooltip>
          </div>
          <div data-rail-flyouts="">
            <aside aria-label="Flyout" />
          </div>
        </>
      );

      fireEvent.focus(screen.getByRole('button', { name: 'Parts' }));
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        'PartsShow the parts list'
      );
    });

    it('opens to the left of a rail on the right edge', () => {
      boxes.Rail = box(window.innerWidth - 50, 300, 40, 120);
      boxes.Parts = box(window.innerWidth - 45, 305, 30, 30);
      renderRail({ flexDirection: 'column' });

      fireEvent.focus(screen.getByRole('button', { name: 'Parts' }));
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip).toHaveAttribute('data-placement', 'left');
      expect(parseFloat(tooltip.style.left)).toBeCloseTo(
        window.innerWidth - 58,
        6
      );
    });

    it('keeps the below placement on a horizontal toolbar', () => {
      boxes.Rail = box(20, 300, 120, 40);
      boxes.Parts = box(25, 305, 30, 30);
      renderRail({ flexDirection: 'row' });

      fireEvent.focus(screen.getByRole('button', { name: 'Parts' }));
      expect(screen.getByRole('tooltip')).toHaveAttribute(
        'data-placement',
        'below'
      );
    });
  });
});
