import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAccountProjectResult } from './accountProjectLoad';
import { ApiError } from './api';
import { trackDetail } from './analytics';
import { desktopFetch } from './desktopBridge';

vi.mock('./analytics', () => ({
  isAnalyticsEnabled: vi.fn(() => true),
  trackDetail: vi.fn(),
  trackSize: vi.fn(),
  durationBucket: vi.fn(() => 'lt_100ms')
}));
vi.mock('./desktopBridge', () => ({ desktopFetch: vi.fn() }));

afterEach(() => vi.clearAllMocks());

function localContext() {
  return {
    localDocument: createProjectDocument('Device part', toUserId('local')),
    previouslySynced: false,
    accountProjects: {
      remoteReached: true,
      cloudProjectIds: new Set<string>()
    }
  };
}

describe('account project discovery', () => {
  it('does not probe an account that confirms it has no copy of a local project', async () => {
    const context = localContext();
    const result = await loadAccountProjectResult(
      context.localDocument.projectId,
      context
    );
    expect(result).toEqual({ document: null });
    expect(desktopFetch).not.toHaveBeenCalled();
    expect(trackDetail).not.toHaveBeenCalled();
  });

  it.each([404, 503])(
    'retains a genuine %s failure for a listed account project',
    async (status) => {
      const context = localContext();
      context.accountProjects.cloudProjectIds.add(
        context.localDocument.projectId
      );
      vi.mocked(desktopFetch).mockResolvedValue(
        new Response('{"error":"unavailable"}', { status })
      );
      const result = await loadAccountProjectResult(
        context.localDocument.projectId,
        context
      );
      expect(result.document).toBeNull();
      expect(result.error).toBeInstanceOf(ApiError);
      expect(result.error).toMatchObject({ status });
      expect(trackDetail).toHaveBeenCalledWith('error_cloud_load');
      expect(trackDetail).toHaveBeenCalledWith(
        'cloud_status',
        status === 404 ? 'other' : 'server'
      );
    }
  );

  it('still probes when an account listing was unreachable', async () => {
    const context = localContext();
    context.accountProjects.remoteReached = false;
    vi.mocked(desktopFetch).mockResolvedValue(
      new Response(JSON.stringify(context.localDocument))
    );
    expect(
      await loadAccountProjectResult(context.localDocument.projectId, context)
    ).toEqual({ document: context.localDocument });
    expect(desktopFetch).toHaveBeenCalledOnce();
  });

  it('reports a missing previously synced copy even when it disappeared from the listing', async () => {
    const context = localContext();
    context.previouslySynced = true;
    vi.mocked(desktopFetch).mockResolvedValue(
      new Response('{"error":"Project not found."}', { status: 404 })
    );
    const result = await loadAccountProjectResult(
      context.localDocument.projectId,
      context
    );
    expect(result.error).toMatchObject({ status: 404 });
    expect(trackDetail).toHaveBeenCalledWith('error_cloud_load');
  });

  it.each(['previously synced', 'no local copy'])(
    'starts a %s read without waiting for the listing',
    async (kind) => {
      const context = localContext();
      vi.mocked(desktopFetch).mockResolvedValue(
        new Response(JSON.stringify(context.localDocument))
      );
      const loaded = loadAccountProjectResult(context.localDocument.projectId, {
        localDocument: kind === 'no local copy' ? null : context.localDocument,
        previouslySynced: kind === 'previously synced',
        accountProjects: new Promise<never>(() => undefined)
      });
      expect(desktopFetch).toHaveBeenCalledOnce();
      expect(await loaded).toEqual({ document: context.localDocument });
    }
  );

  it('preserves network failures when discovery cannot confirm a local-only project', async () => {
    const context = localContext();
    context.accountProjects.remoteReached = false;
    const error = new TypeError('Network unavailable');
    vi.mocked(desktopFetch).mockRejectedValue(error);
    expect(
      await loadAccountProjectResult(context.localDocument.projectId, context)
    ).toEqual({ document: null, error });
    expect(trackDetail).toHaveBeenCalledWith('error_cloud_load');
    expect(trackDetail).toHaveBeenCalledWith('cloud_status', 'network');
  });
});
