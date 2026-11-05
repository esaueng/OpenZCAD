import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewportCameraState } from '@openzcad/viewport';
import * as workspaceSession from '../lib/workspaceSession';
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
  it('saves the latest pose when reload interrupts the settle timer', () => {
    const { result, unmount } = renderHook(() =>
      useProjectView('reload-camera')
    );
    act(() => result.current.onCameraChange('reload-camera', transientPose));
    expect(workspaceSession.loadProjectView('reload-camera')).toBeNull();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(workspaceSession.loadProjectView('reload-camera')?.camera).toEqual(
      transientPose
    );
    unmount();
  });
  it('keeps a transient pose in memory and writes only the settled pose', async () => {
    const writes = vi.spyOn(localStorage, 'setItem');
    const { result } = renderHook(() => useProjectView('project-1'));

    act(() => result.current.onCameraChange('project-1', transientPose));
    expect(writes).not.toHaveBeenCalled();
    expect(workspaceSession.loadProjectView('project-1')).toBeNull();

    // A surrounding setting can synchronously consume the latest in-memory
    // pose without waiting for the camera's durable settle callback.
    act(() =>
      result.current.setSettings((current) => ({
        ...current,
        showGrid: false
      }))
    );
    await waitFor(() => expect(writes).toHaveBeenCalledTimes(1));
    expect(workspaceSession.loadProjectView('project-1')?.camera).toEqual(
      transientPose
    );

    writes.mockClear();
    act(() => result.current.onCameraChange('project-1', settledPose));
    expect(writes).not.toHaveBeenCalled();

    act(() => result.current.onCameraSettled('project-1', settledPose));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(workspaceSession.loadProjectView('project-1')?.camera).toEqual(
      settledPose
    );
  });
});

describe('remembered views on this device', () => {
  const defaults = {
    projection: 'perspective' as const,
    showGrid: true,
    displayMode: 'shaded-edges' as const,
    reducedMotion: false,
    zoomToCursor: true,
    middleDrag: 'pan' as const,
    pointerNavigation: 'auto' as const
  };

  it('persists only the settled cut, then restores its plane, offset and direction', async () => {
    const writes = vi.spyOn(workspaceSession, 'saveProjectView');
    const first = renderHook(() => useProjectView('project-section'));
    act(() =>
      first.result.current.onCameraSettled('project-section', settledPose)
    );
    writes.mockClear();
    for (let offset = 0; offset < 6; offset++) {
      act(() =>
        first.result.current.setSettings((current) => ({
          ...current,
          sectionView: { plane: 'YZ', offset }
        }))
      );
    }
    expect(writes).not.toHaveBeenCalled();
    const sectionView = { plane: 'YZ' as const, offset: -3.125, flipped: true };
    act(() =>
      first.result.current.setSettings((current) => ({
        ...current,
        sectionView
      }))
    );
    expect(writes).not.toHaveBeenCalled();
    act(() => first.result.current.persistSection(sectionView));
    expect(writes).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        workspaceSession.loadProjectView('project-section')?.settings
          .sectionView
      ).toEqual(sectionView)
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
      expect(
        workspaceSession.loadProjectView('project-1')?.sketchVisibility
      ).toEqual({
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
    expect(
      workspaceSession.loadProjectView('project-1')?.sketchVisibility
    ).toEqual({
      'sketch-a': false
    });

    // Another project starts with none.
    act(() => second.result.current.restore('project-2', defaults));
    expect(second.result.current.sketchVisibility).toEqual({});
  });

  it('restores hidden datums and images only for their project', () => {
    const projectId = 'references';
    const first = renderHook(() => useProjectView(projectId));
    act(() => first.result.current.onCameraSettled(projectId, settledPose));
    act(() => {
      first.result.current.setHiddenDatumIds(new Set(['plane-a', 'axis-b']));
      first.result.current.setHiddenReferenceImageIds(new Set(['image-a']));
    });
    first.unmount();

    const reopened = renderHook(({ id }) => useProjectView(id), {
      initialProps: { id: projectId }
    });
    act(() => reopened.result.current.restore(projectId, defaults));
    expect(reopened.result.current.hiddenDatumIds).toEqual(
      new Set(['plane-a', 'axis-b'])
    );
    expect(reopened.result.current.hiddenReferenceImageIds).toEqual(
      new Set(['image-a'])
    );
    expect(reopened.result.current.snapshot()).not.toHaveProperty(
      'hiddenReferences'
    );

    act(() =>
      reopened.result.current.apply({
        camera: transientPose,
        projection: 'orthographic',
        settings: { showGrid: false, displayMode: 'wireframe' },
        hiddenBodyIds: []
      })
    );
    expect(
      workspaceSession.loadProjectView(projectId)?.hiddenReferences
    ).toEqual({
      datumIds: ['plane-a', 'axis-b'],
      imageIds: ['image-a']
    });

    act(() => {
      reopened.result.current.restore('other-project', defaults);
      reopened.rerender({ id: 'other-project' });
    });
    expect(reopened.result.current.hiddenDatumIds).toEqual(new Set());
    expect(reopened.result.current.hiddenReferenceImageIds).toEqual(new Set());
    expect(
      workspaceSession.loadProjectView(projectId)?.hiddenReferences
    ).toEqual({
      datumIds: ['plane-a', 'axis-b'],
      imageIds: ['image-a']
    });
  });

  it('remembers and clears hidden references before the viewport has a pose', () => {
    const projectId = 'reference-only';
    const first = renderHook(() => useProjectView(projectId));
    act(() =>
      first.result.current.setHiddenReferenceImageIds(new Set(['image-a']))
    );
    expect(workspaceSession.loadProjectView(projectId)).toMatchObject({
      camera: null,
      hiddenReferences: { datumIds: [], imageIds: ['image-a'] }
    });
    first.unmount();

    const reopened = renderHook(() => useProjectView(projectId));
    act(() => reopened.result.current.restore(projectId, defaults));
    expect(reopened.result.current.initialView).toBeNull();
    expect(reopened.result.current.hiddenReferenceImageIds).toEqual(
      new Set(['image-a'])
    );
    act(() => reopened.result.current.setHiddenReferenceImageIds(new Set()));
    expect(workspaceSession.loadProjectView(projectId)).not.toHaveProperty(
      'hiddenReferences'
    );
  });
});
