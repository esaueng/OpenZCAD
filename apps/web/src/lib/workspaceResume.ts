import {
  parseWorkspaceResumeState,
  type ProjectWorkspaceSession
} from '@openzcad/shared';
import { desktopFetch } from './desktopBridge';

export function workspaceDeviceId(): string {
  const key = 'openzcad-workspace-device:v1';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

export function resumeCandidate(
  sessions: ProjectWorkspaceSession[],
  projectId: string,
  deviceId: string,
  documentVersion: number
): ProjectWorkspaceSession | null {
  const latest = sessions
    .filter(
      (session) =>
        session.schemaVersion === 1 &&
        session.projectId === projectId &&
        session.documentVersion <= documentVersion &&
        Number.isFinite(Date.parse(session.updatedAt)) &&
        parseWorkspaceResumeState(session.state)
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  return latest && latest.deviceId !== deviceId ? latest : null;
}

export const workspaceSessionApi = {
  async load(projectId: string): Promise<ProjectWorkspaceSession[]> {
    const response = await desktopFetch(
      `/api/projects/${encodeURIComponent(projectId)}/workspace-sessions`,
      { credentials: 'same-origin' }
    );
    if (!response.ok) throw new Error('Workspace sessions are unavailable.');
    const data = (await response.json()) as {
      sessions?: ProjectWorkspaceSession[];
    };
    return Array.isArray(data.sessions) ? data.sessions : [];
  },
  async save(
    session: Omit<ProjectWorkspaceSession, 'updatedAt'>
  ): Promise<void> {
    const response = await desktopFetch(
      `/api/projects/${encodeURIComponent(session.projectId)}/workspace-sessions`,
      {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(session)
      }
    );
    if (!response.ok)
      throw new Error(
        'Workspace session sync is pending.'
      );
  }
};
