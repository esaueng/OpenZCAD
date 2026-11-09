import { useEffect } from 'react';

export const WORKSPACE_RESUME_NOTICE_GRACE_MS = 3000;
export const WORKSPACE_RESUME_NOTICE = "Workspace view isn't syncing.";

/** One expiring, dismissible notice per failure episode, through the viewer's ToastHost. */
export function useWorkspaceResumeNotice(
  failed: boolean,
  projectId: string | null,
  userId: string | null,
  announce: (message: string) => void
) {
  useEffect(() => {
    if (!failed || !projectId || !userId) return;
    const timer = setTimeout(
      () => announce(WORKSPACE_RESUME_NOTICE),
      WORKSPACE_RESUME_NOTICE_GRACE_MS
    );
    return () => clearTimeout(timer);
  }, [failed, projectId, userId, announce]);
}
