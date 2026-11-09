import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectWorkspaceSession,
  WorkspaceResumeState
} from '@openzcad/shared';
import { workspaceSessionApi } from '../lib/workspaceResume';
import { ApiError } from '../lib/api';
import { useWorkspaceResume } from './useWorkspaceResume';

const state: WorkspaceResumeState = {
  camera: { position: [10, 20, 30], target: [0, 0, 0], orthographicZoom: 1 },
  projection: 'orthographic',
  settings: { showGrid: false, displayMode: 'shaded' },
  hiddenBodyIds: [],
  selectedBodyIds: [],
  workspaceMode: 'build',
  panels: {
    sidebarSections: {},
    assistantCollapsed: true,
    viewModeRailOpen: true
  }
};
const remote: ProjectWorkspaceSession = {
  schemaVersion: 1,
  projectId: 'project_a',
  deviceId: 'other_device',
  sessionId: 'other_session',
  sequence: 1,
  documentVersion: 2,
  deviceLabel: 'Desktop',
  updatedAt: new Date().toISOString(),
  state
};
const options = () => ({
  projectId: 'project_a',
  userId: 'user_a',
  documentVersion: 2,
  synced: true,
  getState: () => state,
  applyState: vi.fn(),
  resetView: vi.fn()
});

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.spyOn(workspaceSessionApi, 'load').mockResolvedValue([remote]);
  vi.spyOn(workspaceSessionApi, 'save').mockResolvedValue();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('workspace resume', () => {
  it('offers the other device once and resumes only after the user chooses', async () => {
    const props = options();
    const { result, unmount } = renderHook(() => useWorkspaceResume(props));
    await act(async () => {});
    expect(result.current.candidate?.deviceId).toBe('other_device');
    expect(props.applyState).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(workspaceSessionApi.save).not.toHaveBeenCalled();
    act(() => result.current.choose(true));
    expect(props.applyState).toHaveBeenCalledWith(state);
    expect(result.current.candidate).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(workspaceSessionApi.save).toHaveBeenCalledOnce();
    unmount();
  });

  it('declines without deleting remote state or changing the model', async () => {
    const props = options();
    const { result, unmount } = renderHook(() => useWorkspaceResume(props));
    await act(async () => {});
    act(() => result.current.choose(false));
    expect(props.resetView).toHaveBeenCalledOnce();
    expect(props.applyState).not.toHaveBeenCalled();
    expect(remote.documentVersion).toBe(2);
    unmount();
  });

  it('does not interrupt work with a late response or leak it after an account switch', async () => {
    let resolve!: (sessions: ProjectWorkspaceSession[]) => void;
    vi.mocked(workspaceSessionApi.load).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { result, rerender, unmount } = renderHook(
      (props) => useWorkspaceResume(props),
      { initialProps: options() }
    );
    await act(() => window.dispatchEvent(new Event('keyup')));
    await act(async () => resolve([remote]));
    expect(result.current.candidate).toBeNull();
    rerender({ ...options(), userId: 'user_b' });
    await act(async () => resolve([remote]));
    expect(workspaceSessionApi.save).not.toHaveBeenCalled();
    unmount();
  });

  it('waits for durable model sync and retries failures without letting idle time create newer sessions', async () => {
    vi.mocked(workspaceSessionApi.load).mockResolvedValue([]);
    vi.mocked(workspaceSessionApi.save)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue();
    const { result, rerender, unmount } = renderHook(
      (props) => useWorkspaceResume(props),
      { initialProps: { ...options(), synced: false } }
    );
    await act(async () => {});
    await act(() => window.dispatchEvent(new Event('keyup')));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(workspaceSessionApi.save).not.toHaveBeenCalled();
    await act(async () => rerender(options()));
    expect(result.current.status).toBe('failed');
    expect(result.current.lastFailure?.kind).toBe('network');
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.status).toBe('saved');
    expect(result.current.lastFailure).toBeNull();
    const first = vi.mocked(workspaceSessionApi.save).mock.calls[0]?.[0];
    expect(vi.mocked(workspaceSessionApi.save).mock.calls[1]?.[0]).toBe(first);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(2);
    unmount();
  });
  it('does not promote an idle session when the page is closed or reloaded', async () => {
    vi.mocked(workspaceSessionApi.load).mockResolvedValue([]);
    const { unmount } = renderHook(() => useWorkspaceResume(options()));
    await act(async () => {});
    await act(() => window.dispatchEvent(new Event('keyup')));
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(workspaceSessionApi.save).toHaveBeenCalledOnce();
    await act(() => window.dispatchEvent(new Event('pagehide')));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(workspaceSessionApi.save).toHaveBeenCalledOnce();
    unmount();
  });
});

const activity = async () => {
  await act(() => window.dispatchEvent(new Event('pointerup')));
  await act(async () => vi.advanceTimersByTimeAsync(1500));
};

describe('workspace resume acknowledgements and retries', () => {
  beforeEach(() => {
    vi.mocked(workspaceSessionApi.load).mockResolvedValue([]);
  });

  it('retains the failure through new activity and an in-flight retry, then clears on acknowledgement', async () => {
    let resolve!: () => void;
    vi.mocked(workspaceSessionApi.save)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          })
      );
    const props = options();
    const { result, unmount } = renderHook(() => useWorkspaceResume(props));
    await activity();
    const failure = result.current.lastFailure;
    expect(failure?.kind).toBe('network');
    props.getState = () => ({ ...state, projection: 'perspective' });
    await activity();
    expect(workspaceSessionApi.save).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('failed');
    expect(result.current.lastFailure).toBe(failure);
    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(2);
    expect(result.current.lastFailure).toBe(failure);
    expect(
      vi.mocked(workspaceSessionApi.save).mock.calls[1]?.[0].state.projection
    ).toBe('perspective');
    await act(async () => resolve());
    expect(result.current.status).toBe('saved');
    expect(result.current.lastFailure).toBeNull();
    unmount();
  });

  it('backs off repeated server failures and does not let activity bypass the delay', async () => {
    vi.mocked(workspaceSessionApi.save).mockRejectedValue(
      new ApiError(503, 'Unavailable', 'UNAVAILABLE')
    );
    const { result, unmount } = renderHook(() => useWorkspaceResume(options()));
    await activity();
    expect(result.current.lastFailure).toEqual({
      kind: 'server',
      status: 503,
      code: 'UNAVAILABLE'
    });
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(workspaceSessionApi.save).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(2);
    await activity();
    await act(async () => vi.advanceTimersByTimeAsync(8499));
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(3);
  });

  it.each([
    [400, 'invalid'],
    [401, 'auth'],
    [403, 'forbidden']
  ] as const)(
    'surfaces HTTP %s without retrying it on timers, activity, or model sync',
    async (status, kind) => {
      vi.mocked(workspaceSessionApi.save).mockRejectedValue(
        new ApiError(status, 'Refused')
      );
      const { result, rerender, unmount } = renderHook(
        (props) => useWorkspaceResume(props),
        { initialProps: options() }
      );
      await activity();
      expect(result.current.lastFailure).toEqual({ kind, status });
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      rerender({ ...options(), synced: false });
      await act(async () => rerender(options()));
      await activity();
      expect(workspaceSessionApi.save).toHaveBeenCalledOnce();
      expect(result.current.status).toBe('failed');
      unmount();
    }
  );

  it('waits after a version-fence 409 for a later model-sync acknowledgement', async () => {
    vi.mocked(workspaceSessionApi.save)
      .mockRejectedValueOnce(new ApiError(409, 'Sync the project first.'))
      .mockResolvedValue();
    const { result, rerender, unmount } = renderHook(
      (props) => useWorkspaceResume(props),
      { initialProps: options() }
    );
    await activity();
    expect(result.current.lastFailure).toEqual({
      kind: 'document-sync',
      status: 409
    });
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    await activity();
    rerender({ ...options(), documentVersion: 3 });
    await activity();
    expect(workspaceSessionApi.save).toHaveBeenCalledOnce();
    rerender({ ...options(), documentVersion: 3, synced: false });
    expect(result.current.lastFailure?.kind).toBe('document-sync');
    await act(async () => rerender({ ...options(), documentVersion: 3 }));
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(workspaceSessionApi.save).mock.calls[1]?.[0].documentVersion
    ).toBe(3);
    expect(result.current.lastFailure).toBeNull();
    unmount();
  });

  it('observes a model acknowledgement that arrives while a fenced PUT is in flight', async () => {
    let reject!: (reason: unknown) => void;
    vi.mocked(workspaceSessionApi.save).mockImplementationOnce(
      () =>
        new Promise<void>((_done, fail) => {
          reject = fail;
        })
    );
    const { result, rerender, unmount } = renderHook(
      (props) => useWorkspaceResume(props),
      { initialProps: options() }
    );
    await activity();
    rerender({ ...options(), synced: false });
    rerender(options());
    await act(async () => reject(new ApiError(409, 'Sync first.')));
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(2);
    expect(result.current.lastFailure).toBeNull();
    unmount();
  });

  it('skips acknowledged normalized state while retaining changes to view or document version', async () => {
    const props = options();
    props.getState = () => ({ ...state, hiddenBodyIds: ['b', 'a'] });
    const { rerender, unmount } = renderHook(
      (props) => useWorkspaceResume(props),
      { initialProps: props }
    );
    await activity();
    rerender({
      ...props,
      getState: () => ({
        ...state,
        hiddenBodyIds: ['a', 'b'],
        settings: { ...state.settings, xray: false }
      })
    });
    await activity();
    await activity();
    expect(workspaceSessionApi.save).toHaveBeenCalledOnce();
    rerender({ ...props, documentVersion: 3 });
    await activity();
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(2);
    rerender({
      ...props,
      documentVersion: 3,
      getState: () => ({
        ...state,
        camera: { ...state.camera, position: [40, 50, 60] }
      })
    });
    await activity();
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('coalesces repeated activity during a request and flushes newer state when it completes', async () => {
    let resolve!: () => void;
    vi.mocked(workspaceSessionApi.save).mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    const props = options();
    const { result, unmount } = renderHook(() => useWorkspaceResume(props));
    await activity();
    await activity();
    expect(workspaceSessionApi.save).toHaveBeenCalledOnce();
    props.getState = () => ({ ...state, projection: 'perspective' });
    await activity();
    await act(async () => resolve());
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('saved');
    unmount();
  });

  it('preserves selection order when the active body changes', async () => {
    const props = options();
    props.getState = () => ({ ...state, selectedBodyIds: ['a', 'b'] });
    const { unmount } = renderHook(() => useWorkspaceResume(props));
    await activity();
    props.getState = () => ({ ...state, selectedBodyIds: ['b', 'a'] });
    await activity();
    expect(workspaceSessionApi.save).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(workspaceSessionApi.save).mock.calls[1]?.[0].state
        .selectedBodyIds
    ).toEqual(['b', 'a']);
    unmount();
  });
});
