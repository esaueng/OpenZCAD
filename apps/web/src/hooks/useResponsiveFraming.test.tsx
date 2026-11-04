import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useResponsiveFraming } from './useResponsiveFraming';
import {
  defaultPanelLayout,
  notePanelUsed,
  setOption
} from '../lib/panelLayout';

afterEach(() => vi.useRealTimers());

describe('responsive camera framing', () => {
  it('reframes a changed workspace and a resized window after layout settles', async () => {
    vi.useFakeTimers();
    const onFit = vi.fn();
    const props = {
      projectId: 'a',
      mode: 'build',
      layout: defaultPanelLayout(),
      panels: 'open',
      enabled: true,
      onFit
    };
    const { rerender, unmount } = renderHook(useResponsiveFraming, {
      initialProps: props
    });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    rerender({ ...props, mode: 'tweak' });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(1);
    await act(() => window.dispatchEvent(new Event('resize')));
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(2);
    unmount();
    await act(() => window.dispatchEvent(new Event('resize')));
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(2);
  });

  it('does not move the camera during an edit or replay a skipped resize later', async () => {
    vi.useFakeTimers();
    const onFit = vi.fn();
    const props = {
      projectId: 'a',
      mode: 'build',
      layout: defaultPanelLayout(),
      panels: 'open',
      enabled: true,
      onFit
    };
    const { rerender } = renderHook(useResponsiveFraming, {
      initialProps: props
    });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    rerender({ ...props, enabled: false });
    await act(() => window.dispatchEvent(new Event('resize')));
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    rerender({ ...props, enabled: true });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    await act(() => window.dispatchEvent(new Event('resize')));
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(1);
  });

  it('retains a structural fit until a fast edit settles, then retires an explicit fit', async () => {
    vi.useFakeTimers();
    const onFit = vi.fn();
    const props = {
      projectId: 'a',
      mode: 'build',
      layout: defaultPanelLayout(),
      panels: 'open',
      enabled: false,
      onFit
    };
    const { rerender, result } = renderHook(useResponsiveFraming, {
      initialProps: props
    });
    rerender({ ...props, mode: 'tweak' });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    rerender({ ...props, enabled: true, mode: 'tweak' });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledOnce();
    rerender({ ...props, enabled: true, mode: 'build' });
    act(() => result.current.prepare());
    expect(onFit).toHaveBeenCalledTimes(2);
    rerender({ ...props, enabled: false, mode: 'build' });
    await act(() => vi.advanceTimersByTime(200));
    rerender({ ...props, enabled: true, mode: 'build' });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(2);
  });

  it('preserves zoom when focus moves between desktop panels', async () => {
    vi.useFakeTimers();
    const onFit = vi.fn();
    const props = {
      projectId: 'a',
      mode: 'build',
      layout: defaultPanelLayout(),
      panels: 'open',
      enabled: true,
      onFit
    };
    const { rerender } = renderHook(useResponsiveFraming, {
      initialProps: props
    });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    rerender({ ...props, layout: notePanelUsed(props.layout, 'history') });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    rerender({ ...props, layout: setOption(props.layout, 'hidden', true) });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(1);
  });

  it('lets a viewport gesture cancel a pending automatic fit', async () => {
    vi.useFakeTimers();
    const onFit = vi.fn();
    const props = {
      projectId: 'a',
      mode: 'build',
      layout: defaultPanelLayout(),
      panels: 'open',
      enabled: true,
      onFit
    };
    const { rerender } = renderHook(useResponsiveFraming, {
      initialProps: props
    });
    rerender({ ...props, mode: 'tweak' });
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    await act(() =>
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    );
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    canvas.remove();
  });
});
