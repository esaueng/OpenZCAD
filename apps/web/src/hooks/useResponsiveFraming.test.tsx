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
    expect(onFit).toHaveBeenCalledTimes(1);
    rerender({ ...props, mode: 'tweak' });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(2);
    await act(() => window.dispatchEvent(new Event('resize')));
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(3);
    unmount();
    await act(() => window.dispatchEvent(new Event('resize')));
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(3);
  });

  it('does not move the camera during an edit or replay a skipped resize later', async () => {
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
    const { rerender } = renderHook(useResponsiveFraming, {
      initialProps: props
    });
    await act(() => window.dispatchEvent(new Event('resize')));
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    rerender({ ...props, enabled: true });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).not.toHaveBeenCalled();
    await act(() => window.dispatchEvent(new Event('resize')));
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledOnce();
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
    expect(onFit).toHaveBeenCalledOnce();
    rerender({ ...props, layout: notePanelUsed(props.layout, 'history') });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledOnce();
    rerender({ ...props, layout: setOption(props.layout, 'hidden', true) });
    await act(() => vi.advanceTimersByTime(200));
    expect(onFit).toHaveBeenCalledTimes(2);
  });
});
