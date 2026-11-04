import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBuildToolNavigation } from './useBuildToolNavigation';

describe('search navigation to Build', () => {
  it('does not launch a refused search choice on a later manual mode switch', async () => {
    vi.useFakeTimers();
    const onLaunch = vi.fn();
    const props = {
      mode: 'view',
      projectId: 'a',
      canBuild: true,
      onSwitch: vi.fn(),
      onLaunch
    };
    const { result, rerender } = renderHook(useBuildToolNavigation, {
      initialProps: props
    });
    act(() => result.current('box'));
    await act(() => vi.advanceTimersByTime(600));
    // App renders during a refused switch; a fresh launch callback must not
    // keep restarting the pending intent's expiry.
    rerender({ ...props, onLaunch: vi.fn() });
    await act(() => vi.advanceTimersByTime(600));
    rerender({ ...props, mode: 'build' });
    expect(onLaunch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels the pending intent when another mode is chosen', () => {
    const onLaunch = vi.fn();
    const props = {
      mode: 'view',
      projectId: 'a',
      canBuild: true,
      onSwitch: vi.fn(),
      onLaunch
    };
    const { result, rerender } = renderHook(useBuildToolNavigation, {
      initialProps: props
    });
    act(() => result.current('box'));
    rerender({ ...props, mode: 'tweak' });
    rerender({ ...props, mode: 'build' });
    expect(onLaunch).not.toHaveBeenCalled();
  });
  it('waits for Build before launching against the new mode', () => {
    const onSwitch = vi.fn();
    const onLaunch = vi.fn();
    const props = {
      mode: 'tweak',
      projectId: 'project-a',
      canBuild: true,
      onSwitch,
      onLaunch
    };
    const { result, rerender } = renderHook(useBuildToolNavigation, {
      initialProps: props
    });
    act(() => result.current('fillet'));
    expect(onSwitch).toHaveBeenCalledOnce();
    expect(onLaunch).not.toHaveBeenCalled();
    rerender({ ...props, mode: 'build' });
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith('fillet');
    rerender({ ...props, mode: 'build' });
    expect(onLaunch).toHaveBeenCalledOnce();
  });

  it('never carries a queued tool into another project', () => {
    const onLaunch = vi.fn();
    const props = {
      mode: 'view',
      projectId: 'project-a',
      canBuild: true,
      onSwitch: vi.fn(),
      onLaunch
    };
    const { result, rerender } = renderHook(useBuildToolNavigation, {
      initialProps: props
    });
    act(() => result.current('box'));
    rerender({ ...props, mode: 'build', projectId: 'project-b' });
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('refuses read-only sessions and permissions revoked during the switch', () => {
    const onSwitch = vi.fn();
    const onLaunch = vi.fn();
    const props = {
      mode: 'tweak',
      projectId: 'project-a',
      canBuild: false,
      onSwitch,
      onLaunch
    };
    const { result, rerender } = renderHook(useBuildToolNavigation, {
      initialProps: props
    });
    act(() => result.current('box'));
    expect(onSwitch).not.toHaveBeenCalled();
    rerender({ ...props, canBuild: true });
    act(() => result.current('box'));
    rerender({ ...props, mode: 'build' });
    expect(onLaunch).not.toHaveBeenCalled();
  });
});
