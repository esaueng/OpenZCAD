import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewportCameraState } from '@openzcad/viewport';
import { loadProjectView } from '../lib/workspaceSession';
import { useProjectView } from './useProjectView';

const transientPose: ViewportCameraState = {
  position: [40, 30, 20],
  target: [2, 3, 4],
  orthographicZoom: 1,
  orthographicHalfHeight: 90
};

const settledPose: ViewportCameraState = {
  position: [28, -16, 35],
  target: [7, 5, 3],
  orthographicZoom: 1.25,
  orthographicHalfHeight: 72
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('project camera pose persistence', () => {
  it('keeps a transient pose in memory and writes only the settled pose', async () => {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useProjectView('project-1'));

    act(() => result.current.onCameraChange('project-1', transientPose));
    expect(writes).not.toHaveBeenCalled();
    expect(loadProjectView('project-1')).toBeNull();

    // A surrounding setting can synchronously consume the latest in-memory
    // pose without waiting for the camera's durable settle callback.
    act(() =>
      result.current.setSettings((current) => ({
        ...current,
        showGrid: false
      }))
    );
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    expect(loadProjectView('project-1')?.camera).toEqual(transientPose);

    writes.mockClear();
    act(() => result.current.onCameraChange('project-1', settledPose));
    expect(writes).not.toHaveBeenCalled();

    act(() => result.current.onCameraSettled('project-1', settledPose));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(loadProjectView('project-1')?.camera).toEqual(settledPose);
  });
});

describe('sketch visibility on this device', () => {
  const defaults = {
    projection: 'perspective' as const,
    showGrid: true,
    displayMode: 'shaded-edges' as const,
    reducedMotion: false,
    zoomToCursor: true,
    middleDrag: 'pan' as const,
    pointerNavigation: 'auto' as const
  };

  it('persists the plane, exact offset and flipped side without a camera gesture', async () => {
    const first = renderHook(() => useProjectView('project-section'));
    act(() =>
      first.result.current.onCameraSettled('project-section', settledPose)
    );
    const sectionView = { plane: 'YZ' as const, offset: -3.125, flipped: true };
    act(() =>
      first.result.current.setSettings((current) => ({
        ...current,
        sectionView
      }))
    );
    await waitFor(() =>
      expect(loadProjectView('project-section')?.settings.sectionView).toEqual(
        sectionView
      )
    );
    first.unmount();
    const next = renderHook(() => useProjectView('project-section'));
    act(() => next.result.current.restore('project-section', defaults));
    expect(next.result.current.settings.sectionView).toEqual(sectionView);
  });

  it('survives a reload, and a view from another device keeps it', async () => {
    const first = renderHook(() => useProjectView('project-1'));
    act(() => first.result.current.onCameraSettled('project-1', settledPose));
    act(() => first.result.current.setSketchVisibility({ 'sketch-a': false }));
    await waitFor(() =>
      expect(loadProjectView('project-1')?.sketchVisibility).toEqual({
        'sketch-a': false
      })
    );
    first.unmount();

    // A reload: a fresh hook restores the project's remembered choices.
    const second = renderHook(() => useProjectView('project-1'));
    act(() => second.result.current.restore('project-1', defaults));
    expect(second.result.current.sketchVisibility).toEqual({
      'sketch-a': false
    });

    // The account's resume state carries no sketch choices.
    act(() =>
      second.result.current.apply({
        camera: transientPose,
        projection: 'orthographic',
        settings: { showGrid: false, displayMode: 'wireframe' },
        hiddenBodyIds: []
      })
    );
    expect(second.result.current.sketchVisibility).toEqual({
      'sketch-a': false
    });
    expect(loadProjectView('project-1')?.sketchVisibility).toEqual({
      'sketch-a': false
    });

    // Another project starts with none.
    act(() => second.result.current.restore('project-2', defaults));
    expect(second.result.current.sketchVisibility).toEqual({});
  });
});
