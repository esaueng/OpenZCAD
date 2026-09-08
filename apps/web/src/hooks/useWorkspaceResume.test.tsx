import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectWorkspaceSession,
  WorkspaceResumeState
} from '@openzcad/shared';
import { workspaceSessionApi } from '../lib/workspaceResume';
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
    expect(result.current.status).toBe('offline');
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(result.current.status).toBe('saved');
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
