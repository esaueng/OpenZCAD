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
