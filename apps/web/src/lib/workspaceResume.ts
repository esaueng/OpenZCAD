import {
  parseWorkspaceResumeState,
  type ProjectWorkspaceSession
} from '@openzcad/shared';
import { desktopFetch } from './desktopBridge';
import { projectRequest } from './projectWriteGate';
import { ApiError, isEncryptedProject } from './api';

export interface WorkspaceResumeFailure {
  kind:
    | 'network'
    | 'server'
    | 'document-sync'
    | 'invalid'
    | 'auth'
    | 'forbidden'
    | 'permanent';
  status?: number;
  code?: string;
}

export function workspaceResumeFailure(error: unknown): WorkspaceResumeFailure {
  if (!(error instanceof ApiError)) return { kind: 'network' };
  const { status, code } = error;
  const kind =
    status >= 500
      ? 'server'
      : status === 409 && (!code || code === 'E2EE_VIEW_STATE_AHEAD')
        ? 'document-sync'
        : status === 400
          ? 'invalid'
          : status === 401
            ? 'auth'
            : status === 403
              ? 'forbidden'
              : 'permanent';
  return { kind, status, ...(code ? { code } : {}) };
}

async function refusal(response: Response): Promise<ApiError> {
  let payload: Record<string, unknown> = {};
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && !Array.isArray(body))
      payload = body as Record<string, unknown>;
  } catch {
    // A proxy's non-JSON error must still retain its HTTP status.
  }
  return new ApiError(
    response.status,
    typeof payload.error === 'string'
      ? payload.error
      : 'Workspace view sync failed.',
    typeof payload.code === 'string' ? payload.code : undefined,
    payload
  );
}

/** An encrypted project's view state: signed, encrypted envelopes (slice 4-7). */
const encryptedViewStates = async () =>
  (await import('./e2ee/encryptedProjects')).encryptedViewStates();

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
    if (isEncryptedProject(projectId)) {
      return (await encryptedViewStates()).load(projectId);
    }
    const response = await desktopFetch(
      `/api/projects/${encodeURIComponent(projectId)}/workspace-sessions`,
      { credentials: 'same-origin' }
    );
    if (!response.ok) throw await refusal(response);
    const data = (await response.json()) as {
      sessions?: ProjectWorkspaceSession[];
    };
    return Array.isArray(data.sessions) ? data.sessions : [];
  },
  async save(
    session: Omit<ProjectWorkspaceSession, 'updatedAt'>
  ): Promise<void> {
    if (isEncryptedProject(session.projectId)) {
      return (await encryptedViewStates()).save(session);
    }
    const response = await desktopFetch(
      `/api/projects/${encodeURIComponent(session.projectId)}/workspace-sessions`,
      // Checked again at its send: refused if pinned meanwhile.
      projectRequest(
        { projectId: session.projectId, payload: 'plaintext' },
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(session)
        }
      )
    );
    if (!response.ok) throw await refusal(response);
  }
};
