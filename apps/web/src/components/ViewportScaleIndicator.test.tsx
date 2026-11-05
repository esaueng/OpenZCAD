import { act, render, screen } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ViewportGridReadout,
  ViewportScaleIndicator,
  scaleRuleRoom,
  type SketchGridReadoutSink,
  type ViewportScaleSink
} from './ViewportScaleIndicator';

describe('ViewportScaleIndicator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  {
    it('keeps unchanged label nodes and bitmap dimensions while the rule changes length', () => {
      const clearRect = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        setTransform() {},
        clearRect,
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {}
      } as unknown as CanvasRenderingContext2D);
      const sinkRef: MutableRefObject<ViewportScaleSink | null> = {
        current: null
      };
      render(<ViewportScaleIndicator scaleSinkRef={sinkRef} units="mm" />);
      act(() => sinkRef.current?.({ value: 10, widthPx: 120.1 }));
      const root = screen.getByTestId('viewport-scale-indicator');
      const canvas = screen.getByTestId<HTMLCanvasElement>(
        'viewport-scale-rule'
      );
      const value = root.querySelector('output')!;
      const text = value.firstChild;
      const observer = new MutationObserver(() => undefined);
      observer.observe(root, {
        attributes: true,
        childList: true,
        subtree: true
      });
      clearRect.mockClear();
      act(() => sinkRef.current?.({ value: 10, widthPx: 120.2 }));
      const mutations = observer.takeRecords();
      observer.disconnect();
      expect(value.firstChild).toBe(text);
      expect(
        mutations.filter((mutation) => mutation.type === 'childList')
      ).toEqual([]);
      expect(mutations.filter((mutation) => mutation.target === root)).toEqual(
        []
      );
      expect(
        mutations.filter((mutation) =>
          ['width', 'height'].includes(mutation.attributeName ?? '')
        )
      ).toEqual([]);
      expect(clearRect).toHaveBeenLastCalledWith(
        0,
        0,
        canvas.width,
        canvas.height
      );
      act(() => sinkRef.current?.({ value: 20, widthPx: 140 }));
      expect(value).toHaveTextContent('20 mm');
      expect(root).toHaveAccessibleName(
        'Viewport scale at the model center plane: 20 mm'
      );
    });

    it('draws the rule lying along the foot at every width', () => {
      const transforms: number[][] = [];
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        setTransform: (...args: number[]) => transforms.push(args),
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {}
      } as unknown as CanvasRenderingContext2D);
      const sinkRef: MutableRefObject<ViewportScaleSink | null> = {
        current: null
      };
      render(<ViewportScaleIndicator scaleSinkRef={sinkRef} units="mm" />);
      act(() => sinkRef.current?.({ value: 10, widthPx: 120 }));

      const root = screen.getByTestId('viewport-scale-indicator');
      const canvas = screen.getByTestId<HTMLCanvasElement>(
        'viewport-scale-rule'
      );
      expect(root.classList.contains('is-upright')).toBe(false);
      // 120px along the rule, 18px across it.
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      expect([canvas.width, canvas.height]).toEqual([
        Math.round(120 * ratio),
        Math.round(18 * ratio)
      ]);
      expect(canvas.style.getPropertyValue('--viewport-scale-length')).toBe(
        '120px'
      );
      expect(transforms.at(-1)?.[0]).toBe(ratio);
    });
  }

  it('ends the rule short of the search bar it shares a row with', () => {
    const rule = { left: 10, top: 960, bottom: 978 };
    // A wide stage: the bar starts far enough right for the full rule.
    expect(scaleRuleRoom(rule, { left: 346, top: 952, bottom: 990 })).toEqual({
      maxWidthPx: 200,
      raise: false
    });
    // 1280px: the bar starts at 230, so the rule and its value end before it.
    expect(scaleRuleRoom(rule, { left: 230, top: 756, bottom: 790 })).toEqual({
      maxWidthPx: 200,
      raise: false
    });
    expect(scaleRuleRoom(rule, { left: 230, top: 952, bottom: 990 })).toEqual({
      maxWidthPx: 136,
      raise: false
    });
    // Too little room for a readable rule: it steps up over the bar.
    expect(scaleRuleRoom(rule, { left: 116, top: 952, bottom: 990 })).toEqual({
      maxWidthPx: 200,
      raise: true
    });
    // No bar, or one in another row: the full rule.
    expect(scaleRuleRoom(rule, null)).toEqual({
      maxWidthPx: 200,
      raise: false
    });
  });

  it('strokes the rule in the stage ink, not the chrome text colours', () => {
    // The rule sits straight on the stage, so it follows the stage's ink
    // rather than the chrome's, which can differ from it.
    const tokens: Record<string, string> = {
      '--color-text': '#111111',
      '--color-text-muted': '#222222',
      '--color-accent': '#333333',
      '--color-stage-ink': '#eeeeee',
      '--color-stage-ink-muted': '#dddddd',
      '--color-preselect': '#cccccc'
    };
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudo) =>
        element instanceof HTMLCanvasElement
          ? ({
              getPropertyValue: (name: string) => tokens[name] ?? ''
            } as unknown as CSSStyleDeclaration)
          : computed(element, pseudo)
    );
    const strokes: string[] = [];
    const context = {
      setTransform() {},
      clearRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {
        strokes.push(String(this.strokeStyle));
      },
      strokeStyle: '' as unknown,
      lineWidth: 1,
      lineCap: 'butt'
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    );
    const sinkRef: MutableRefObject<ViewportScaleSink | null> = {
      current: null
    };
    render(<ViewportScaleIndicator scaleSinkRef={sinkRef} units="mm" />);

    act(() => sinkRef.current?.({ value: 10, widthPx: 120 }));

    expect(strokes.length).toBeGreaterThan(0);
    expect(new Set(strokes)).toEqual(
      new Set(['#eeeeee', '#dddddd', '#cccccc'])
    );
  });

  it('is one named image, not a live region that reads every zoom step', () => {
    // The value was an <output>, a polite status announcing a bare "50 mm"
    // on each step, while the descriptive label sat on a role-less div.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const sinkRef: MutableRefObject<ViewportScaleSink | null> = {
      current: null
    };
    render(<ViewportScaleIndicator scaleSinkRef={sinkRef} units="mm" />);

    act(() => sinkRef.current?.({ value: 10, widthPx: 120 }));

    expect(
      screen.getByRole('img', {
        name: 'Viewport scale at the model center plane: 10 mm'
      })
    ).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('ViewportGridReadout', () => {
  it('writes the spacing beside the Grid word and hides without a grid', () => {
    const sinkRef: MutableRefObject<SketchGridReadoutSink | null> = {
      current: null
    };
    render(<ViewportGridReadout sinkRef={sinkRef} />);
    const segment = screen.getByTitle(/Sketch grid spacing/);
    expect(segment).not.toBeVisible();

    act(() => sinkRef.current?.('2 mm'));
    expect(segment).toBeVisible();
    // The sink carries the value alone; the word is markup the compact
    // readout trades for a glyph.
    expect(segment).toHaveTextContent('Grid 2 mm');

    act(() => sinkRef.current?.(null));
    expect(segment).not.toBeVisible();
  });
});
