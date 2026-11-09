import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../components/AppShell';
import { ToastHost } from '../components/Toast';
import {
  TOAST_EXIT_MS,
  TOAST_LIFETIME_MS,
  type ToastModel
} from '../lib/toasts';
import {
  useWorkspaceResumeNotice,
  WORKSPACE_RESUME_NOTICE,
  WORKSPACE_RESUME_NOTICE_GRACE_MS
} from './useWorkspaceResumeNotice';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Notice({ failed }: { failed: boolean }) {
  const [toast, setToast] = useState<ToastModel | null>(null);
  const announce = useCallback(
    (message: string) => setToast({ id: 1, message }),
    []
  );
  const dismiss = useCallback(() => setToast(null), []);
  useWorkspaceResumeNotice(failed, 'project_a', 'user_a', announce);
  return (
    <AppShell
      topBar={null}
      toolBar={null}
      sidebar={null}
      assistant={null}
      inspector={null}
      sidebarWidth={252}
      assistantWidth={360}
      viewer={<ToastHost toast={toast} onDismiss={dismiss} />}
    />
  );
}

describe('workspace resume notice', () => {
  it('announces once after a grace period and cancels when a retry recovers in time', () => {
    const announce = vi.fn();
    const { rerender } = renderHook(
      ({ failed }) =>
        useWorkspaceResumeNotice(failed, 'project_a', 'user_a', announce),
      { initialProps: { failed: true } }
    );
    act(() => {
      vi.advanceTimersByTime(WORKSPACE_RESUME_NOTICE_GRACE_MS - 1);
    });
    expect(announce).not.toHaveBeenCalled();
    rerender({ failed: false });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(announce).not.toHaveBeenCalled();
    rerender({ failed: true });
    act(() => {
      vi.advanceTimersByTime(WORKSPACE_RESUME_NOTICE_GRACE_MS);
    });
    expect(announce).toHaveBeenCalledExactlyOnceWith(WORKSPACE_RESUME_NOTICE);
    rerender({ failed: true });
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(announce).toHaveBeenCalledOnce();
    rerender({ failed: false });
    rerender({ failed: true });
    act(() => {
      vi.advanceTimersByTime(WORKSPACE_RESUME_NOTICE_GRACE_MS);
    });
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending announcement when the account/project changes or unmounts', () => {
    const announce = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ projectId, userId, failed }) =>
        useWorkspaceResumeNotice(failed, projectId, userId, announce),
      {
        initialProps: { projectId: 'project_a', userId: 'user_a', failed: true }
      }
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    rerender({ projectId: 'project_b', userId: 'user_b', failed: false });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(announce).not.toHaveBeenCalled();
    rerender({ projectId: 'project_b', userId: 'user_b', failed: true });
    unmount();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(announce).not.toHaveBeenCalled();
  });

  it.each(['dismiss', 'expire'])(
    'renders inside the viewer ToastHost and can %s without reappearing',
    (action) => {
      const { container, rerender } = render(<Notice failed />);
      act(() => {
        vi.advanceTimersByTime(WORKSPACE_RESUME_NOTICE_GRACE_MS);
      });
      const toast = container.querySelector('.viewer-area .toast')!;
      expect(toast).toHaveTextContent(WORKSPACE_RESUME_NOTICE);
      expect(container.querySelectorAll('.toast')).toHaveLength(1);
      if (action === 'dismiss')
        fireEvent.click(toast.querySelector('.toast-dismiss')!);
      else
        act(() => {
          vi.advanceTimersByTime(TOAST_LIFETIME_MS);
        });
      act(() => {
        vi.advanceTimersByTime(TOAST_EXIT_MS);
      });
      expect(container.querySelector('.toast')).toBeNull();
      rerender(<Notice failed />);
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(container.querySelector('.toast')).toBeNull();
    }
  );
});
