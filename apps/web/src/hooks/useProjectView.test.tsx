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
    orbitMode: 'free' as const,
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
    act(() => {
      next.result.current.restore('project-section', defaults);
    });
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
    act(() => {
      second.result.current.restore('project-1', defaults);
    });
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
    act(() => {
      second.result.current.restore('project-2', defaults);
    });
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
    act(() => {
      reopened.result.current.restore(projectId, defaults);
    });
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
    act(() => {
      reopened.result.current.restore(projectId, defaults);
    });
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

describe('I03: the remembered view follows the stored unit', () => {
  const defaults = {
    projection: 'perspective' as const,
    showGrid: true,
    displayMode: 'shaded-edges' as const,
    reducedMotion: false,
    zoomToCursor: true,
    middleDrag: 'pan' as const,
    orbitMode: 'free' as const,
    pointerNavigation: 'auto' as const
  };
  const millimetrePose: ViewportCameraState = {
    position: [254, -254, 127],
    target: [25.4, 0, 0],
    orthographicZoom: 2,
    orthographicHalfHeight: 50.8
  };
  const millimetreSection = { plane: 'XY' as const, offset: 12.7 };

  function rememberedInMillimetres(projectId: string) {
    const first = renderHook(() => useProjectView(projectId));
    act(() => {
      first.result.current.restore(projectId, defaults, 'mm');
    });
    act(() => first.result.current.onCameraSettled(projectId, millimetrePose));
    act(() =>
      first.result.current.setSettings((current) => ({
        ...current,
        sectionView: millimetreSection
      }))
    );
    act(() => first.result.current.persistSection(millimetreSection));
    return first;
  }

  it('stamps the unit and rescales the camera and cut on a conversion and its undo', () => {
    const view = rememberedInMillimetres('convert-1');
    expect(workspaceSession.loadProjectView('convert-1')?.units).toBe('mm');

    let rescaled: ReturnType<typeof view.result.current.rescale> = null;
    act(() => {
      rescaled = view.result.current.rescale('mm', 'inch');
    });
    expect(rescaled!.factor).toBeCloseTo(1 / 25.4, 15);
    expect(rescaled!.camera?.position[0]).toBeCloseTo(10, 12);
    expect(rescaled!.sectionView?.offset).toBeCloseTo(0.5, 12);
    expect(view.result.current.settings.sectionView?.offset).toBeCloseTo(
      0.5,
      12
    );
    const stored = workspaceSession.loadProjectView('convert-1');
    expect(stored?.units).toBe('inch');
    expect(stored?.camera?.position[0]).toBeCloseTo(10, 12);
    expect(stored?.camera?.orthographicHalfHeight).toBeCloseTo(2, 12);
    expect(stored?.settings.sectionView?.offset).toBeCloseTo(0.5, 12);

    // Already in inches: a repeated notice changes nothing.
    act(() => {
      rescaled = view.result.current.rescale('mm', 'inch');
    });
    expect(rescaled).toBeNull();

    // Undo.
    act(() => {
      rescaled = view.result.current.rescale('inch', 'mm');
    });
    const undone = workspaceSession.loadProjectView('convert-1');
    expect(undone?.units).toBe('mm');
    expect(undone?.camera?.position[0]).toBeCloseTo(254, 9);
    expect(undone?.settings.sectionView?.offset).toBeCloseTo(12.7, 9);
  });

  it('rescales a view remembered in another unit when the project opens', () => {
    rememberedInMillimetres('convert-2').unmount();
    // Converted elsewhere (another tab or device): opened now in inches.
    const next = renderHook(() => useProjectView('convert-2'));
    act(() => {
      next.result.current.restore('convert-2', defaults, 'inch');
    });
    expect(next.result.current.initialView?.position[0]).toBeCloseTo(10, 12);
    expect(next.result.current.initialView?.target[0]).toBeCloseTo(1, 12);
    expect(next.result.current.settings.sectionView?.offset).toBeCloseTo(
      0.5,
      12
    );
  });

  it('takes a view written before units were recorded to be in the project unit', () => {
    workspaceSession.saveProjectView('legacy', {
      camera: millimetrePose,
      projection: 'perspective',
      settings: {
        showGrid: true,
        displayMode: 'shaded',
        sectionView: millimetreSection
      },
      hiddenBodyIds: []
    });
    const view = renderHook(() => useProjectView('legacy'));
    act(() => {
      view.result.current.restore('legacy', defaults, 'mm');
    });
    expect(view.result.current.initialView).toEqual(millimetrePose);
    expect(view.result.current.settings.sectionView).toEqual(millimetreSection);
  });
});

describe('I03: a view written before it recorded its unit', () => {
  const defaults = {
    projection: 'perspective' as const,
    showGrid: true,
    displayMode: 'shaded-edges' as const,
    reducedMotion: false,
    zoomToCursor: true,
    middleDrag: 'pan' as const,
    orbitMode: 'free' as const,
    pointerNavigation: 'auto' as const
  };
  const legacyView = {
    camera: {
      position: [254, 0, 0] as [number, number, number],
      target: [25.4, 0, 0] as [number, number, number],
      orthographicZoom: 1
    },
    projection: 'perspective' as const,
    settings: {
      showGrid: false,
      displayMode: 'shaded' as const,
      sectionView: { plane: 'XY' as const, offset: 12.7 }
    },
    hiddenBodyIds: []
  };

  it('is read in the unit this device last held the project in', () => {
    // Saved in millimetres here; converted to inches on another device.
    workspaceSession.saveProjectView('elsewhere', legacyView);
    const view = renderHook(() => useProjectView('elsewhere'));
    act(() => {
      view.result.current.restore('elsewhere', defaults, 'inch', 'mm');
    });
    expect(view.result.current.initialView?.position[0]).toBeCloseTo(10, 12);
    expect(view.result.current.settings.sectionView?.offset).toBeCloseTo(
      0.5,
      12
    );
    // And the next write records the unit it is in now.
    act(() =>
      view.result.current.onCameraSettled(
        'elsewhere',
        view.result.current.initialView!
      )
    );
    expect(workspaceSession.loadProjectView('elsewhere')?.units).toBe('inch');
  });

  it('drops its camera and cut when the unit it is in cannot be known', () => {
    workspaceSession.saveProjectView('ambiguous', legacyView);
    const view = renderHook(() => useProjectView('ambiguous'));
    act(() => {
      view.result.current.restore('ambiguous', defaults, 'inch', 'unknown');
    });
    expect(view.result.current.initialView).toBeNull();
    expect(view.result.current.settings.sectionView).toBeUndefined();
    // The rest of the view is unit-free and stays.
    expect(view.result.current.settings.showGrid).toBe(false);
    expect(view.result.current.settings.displayMode).toBe('shaded');
  });

  it('keeps a stamped view when the unit is otherwise unknown', () => {
    workspaceSession.saveProjectView('stamped', { ...legacyView, units: 'mm' });
    const view = renderHook(() => useProjectView('stamped'));
    act(() => {
      view.result.current.restore('stamped', defaults, 'inch', 'unknown');
    });
    expect(view.result.current.initialView?.position[0]).toBeCloseTo(10, 12);
  });
});

describe('I03: an account refresh of the open project in another unit', () => {
  const defaults = {
    projection: 'perspective' as const,
    showGrid: true,
    displayMode: 'shaded-edges' as const,
    reducedMotion: false,
    zoomToCursor: true,
    middleDrag: 'pan' as const,
    orbitMode: 'free' as const,
    pointerNavigation: 'auto' as const
  };
  const onScreen: ViewportCameraState = {
    position: [254, -254, 127],
    target: [25.4, 0, 0],
    orthographicZoom: 1
  };

  it('answers the rescaled pose for the live camera, once', () => {
    const view = renderHook(() => useProjectView('refresh'));
    let request: ReturnType<typeof view.result.current.restore> = null;
    act(() => {
      request = view.result.current.restore('refresh', defaults, 'mm');
    });
    // Opening a project is not a refresh: the viewer mounts on it.
    expect(request).toBeNull();
    act(() => view.result.current.onCameraSettled('refresh', onScreen));
    // Converted on another device; the refresh brings the inch revision.
    act(() => {
      request = view.result.current.restore('refresh', defaults, 'inch', 'mm');
    });
    expect(request!.projection).toBe('perspective');
    expect(request!.pose.position[0]).toBeCloseTo(10, 12);
    expect(request!.pose.target[0]).toBeCloseTo(1, 12);
    expect(view.result.current.snapshot()?.camera.position[0]).toBeCloseTo(
      10,
      12
    );
    // The unit-change hook that follows finds the view already in inches,
    // so the live camera is not rescaled a second time.
    let rescaled: ReturnType<typeof view.result.current.rescale> = null;
    act(() => {
      rescaled = view.result.current.rescale('mm', 'inch');
    });
    expect(rescaled).toBeNull();
    // A refresh in the same unit moves nothing.
    act(() => {
      request = view.result.current.restore('refresh', defaults, 'inch');
    });
    expect(request).toBeNull();
  });

  it('is not a refresh once the project was closed', () => {
    const view = renderHook(() => useProjectView('closed'));
    act(() => {
      view.result.current.restore('closed', defaults, 'mm');
    });
    act(() => view.result.current.onCameraSettled('closed', onScreen));
    act(() => view.result.current.forget());
    let request: ReturnType<typeof view.result.current.restore> = null;
    act(() => {
      request = view.result.current.restore('closed', defaults, 'inch', 'mm');
    });
    expect(request).toBeNull();
  });
});

describe('I03: a view read before it recorded its unit is rewritten at once', () => {
  const defaults = {
    projection: 'perspective' as const,
    showGrid: true,
    displayMode: 'shaded-edges' as const,
    reducedMotion: false,
    zoomToCursor: true,
    middleDrag: 'pan' as const,
    orbitMode: 'free' as const,
    pointerNavigation: 'auto' as const
  };
  const legacy = {
    camera: {
      position: [254, 0, 0] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
      orthographicZoom: 1
    },
    projection: 'perspective' as const,
    settings: {
      showGrid: false,
      displayMode: 'shaded' as const,
      sectionView: { plane: 'XY' as const, offset: 12.7 }
    },
    hiddenBodyIds: []
  };

  it('stamps a rescaled view, so a later open reads it right', () => {
    workspaceSession.saveProjectView('rewrite', legacy);
    const first = renderHook(() => useProjectView('rewrite'));
    act(() => {
      first.result.current.restore('rewrite', defaults, 'inch', 'mm');
    });
    first.unmount();
    const stored = workspaceSession.loadProjectView('rewrite');
    expect(stored?.units).toBe('inch');
    expect(stored?.camera?.position[0]).toBeCloseTo(10, 12);
    expect(stored?.settings.sectionView?.offset).toBeCloseTo(0.5, 12);
    // A later open that would guess inches reads exactly that.
    const next = renderHook(() => useProjectView('rewrite'));
    act(() => {
      next.result.current.restore('rewrite', defaults, 'inch', 'inch');
    });
    expect(next.result.current.settings.sectionView?.offset).toBeCloseTo(
      0.5,
      12
    );
  });

  it('keeps an ambiguous drop dropped', () => {
    workspaceSession.saveProjectView('dropped', legacy);
    const first = renderHook(() => useProjectView('dropped'));
    act(() => {
      first.result.current.restore('dropped', defaults, 'inch', 'unknown');
    });
    first.unmount();
    const stored = workspaceSession.loadProjectView('dropped');
    expect(stored?.units).toBe('inch');
    expect(stored?.camera).toBeNull();
    expect(stored?.settings.sectionView).toBeUndefined();
    expect(stored?.settings.displayMode).toBe('shaded');
  });
});
