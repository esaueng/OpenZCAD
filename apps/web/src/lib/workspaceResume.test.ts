import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWorkspaceSession } from '@openzcad/shared';
import { ApiError } from './api';
import { desktopFetch } from './desktopBridge';
import { workspaceResumeFailure, workspaceSessionApi } from './workspaceResume';

vi.mock('./desktopBridge', () => ({ desktopFetch: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const session = { projectId: 'project_a' } as ProjectWorkspaceSession;

describe('workspace session API failures', () => {
  it.each([
    [400, 'INVALID_SESSION', 'invalid'],
    [401, 'AUTH_REQUIRED', 'auth'],
    [403, 'FORBIDDEN', 'forbidden'],
    [409, undefined, 'document-sync'],
    [409, 'E2EE_VIEW_STATE_AHEAD', 'document-sync'],
    [409, 'UNRELATED_CONFLICT', 'permanent'],
    [503, 'UNAVAILABLE', 'server']
  ] as const)('preserves HTTP %s and its code', async (status, code, kind) => {
    vi.mocked(desktopFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Refused', code }), { status })
    );
    const error = await workspaceSessionApi
      .save(session)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, message: 'Refused', code });
    expect(workspaceResumeFailure(error)).toEqual({
      kind,
      status,
      ...(code ? { code } : {})
    });
  });

  it('retains the status of a non-JSON refusal', async () => {
    vi.mocked(desktopFetch).mockResolvedValue(
      new Response('<html>Unavailable</html>', { status: 502 })
    );
    await expect(workspaceSessionApi.save(session)).rejects.toMatchObject({
      status: 502
    });
  });

  it('preserves load refusals too', async () => {
    vi.mocked(desktopFetch).mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'Sign in', code: 'AUTH_REQUIRED' }),
        { status: 401 }
      )
    );
    await expect(workspaceSessionApi.load('project_a')).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_REQUIRED'
    });
  });

  it('keeps a network failure distinct from an HTTP refusal', async () => {
    const error = new TypeError('Failed to fetch');
    vi.mocked(desktopFetch).mockRejectedValue(error);
    await expect(workspaceSessionApi.save(session)).rejects.toBe(error);
    expect(workspaceResumeFailure(error)).toEqual({ kind: 'network' });
  });
});
