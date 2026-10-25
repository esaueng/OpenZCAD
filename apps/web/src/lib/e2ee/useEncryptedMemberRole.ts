/**
 * The signed-in account's role in a shared end-to-end encrypted project
 * (ADR-024 Phase 5, slice 5-4), for the page's edit guards: an editor edits
 * and autosaves through the encrypted store, a viewer gets the read-only UI.
 * The role comes from the project's MLS roles (`memberships.ts`), never the
 * server's mirror. It is read when the project opens, when the window
 * regains focus, every `REFRESH_MS`, and whenever something here learns the
 * role may have moved (`refreshEncryptedMemberRole`: a write the browser or
 * the Worker refused as read-only). The crypto loads only for such a
 * project.
 */
import { useEffect, useState } from 'react';
import type { ProjectAccessRole } from '@openzcad/shared';

/** Judgment: a demotion reaches an open page within this, at the latest. */
export const REFRESH_MS = 20_000;

const listeners = new Set<(projectId: string) => void>();

/** Ask every page guard showing `projectId` to read its role again. */
export function refreshEncryptedMemberRole(projectId: string): void {
  for (const listener of listeners) listener(projectId);
}

/**
 * The account's role in `projectId` while `enabled`, null until known (the
 * page then shows "Waiting for project access"). A read that fails keeps
 * the last answer.
 */
export function useEncryptedMemberRole(
  projectId: string | null,
  enabled: boolean
): ProjectAccessRole | null {
  const [known, setKnown] = useState<{
    projectId: string;
    role: ProjectAccessRole | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled || !projectId) return;
    let cancelled = false;
    let running = false;
    let again = false;
    const read = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        const { encryptedMemberRole } = await import('./memberships');
        const role = await encryptedMemberRole(projectId);
        if (!cancelled) setKnown({ projectId, role });
      } catch {
        // Keep the last answer; the next read tries again.
      } finally {
        running = false;
        if (again && !cancelled) {
          again = false;
          void read();
        }
      }
    };
    void read();
    const onFocus = () => void read();
    const listener = (id: string) => {
      if (id === projectId) void read();
    };
    window.addEventListener('focus', onFocus);
    listeners.add(listener);
    const timer = window.setInterval(() => void read(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      listeners.delete(listener);
      window.clearInterval(timer);
    };
  }, [projectId, enabled]);
  return enabled && known && known.projectId === projectId ? known.role : null;
}
