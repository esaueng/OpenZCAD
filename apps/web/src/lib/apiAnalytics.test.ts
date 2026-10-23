import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { isAnalyticsEnabled, trackDetail, trackSize } from './analytics';
import { desktopFetch } from './desktopBridge';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

// A real document: loads now refuse one this browser cannot open
// (ADR-024 Phase 1). Its name carries multi-byte UTF-8 for the size check.
const documentText = JSON.stringify(
  createProjectDocument('測試⚙', toUserId('owner'))
);

vi.mock('./analytics', () => ({
  isAnalyticsEnabled: vi.fn(() => true),
  trackDetail: vi.fn(),
  trackSize: vi.fn(),
  durationBucket: vi.fn(() => 'lt_100ms')
}));
vi.mock('./desktopBridge', () => ({ desktopFetch: vi.fn() }));

beforeEach(() => {
  vi.mocked(isAnalyticsEnabled).mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe('project download size observations', () => {
  it.each(['project', 'revision'] as const)(
    'measures the consumed UTF-8 JSON for a successful %s download',
    async (kind) => {
      const text = documentText;
      const response = new Response(text);
      vi.mocked(desktopFetch).mockResolvedValue(response);
      const loaded = kind === 'project'
        ? await api.loadProject('project')
        : await api.loadRevision('project', 'revision');
      expect(loaded).toMatchObject({ name: '測試⚙' });
      expect(response.bodyUsed).toBe(true);
      expect(trackSize).toHaveBeenCalledExactlyOnceWith(
        'transfer_download', new TextEncoder().encode(text).byteLength
      );
    }
  );

  it('keeps successful downloads available without analytics consent', async () => {
    vi.mocked(isAnalyticsEnabled).mockReturnValue(false);
    vi.mocked(desktopFetch).mockResolvedValue(new Response(documentText));
    expect(await api.loadProject('project')).toMatchObject({
      name: '測試⚙'
    });
    expect(trackSize).not.toHaveBeenCalled();
  });

  it('treats a pruned revision as an ordinary null result without failure metrics', async () => {
    vi.mocked(desktopFetch).mockResolvedValue(new Response('{"error":"pruned"}', { status: 404 }));
    expect(await api.loadRevision('project', 'revision')).toBeNull();
    expect(trackDetail).not.toHaveBeenCalled();
    expect(trackSize).not.toHaveBeenCalled();
    vi.mocked(desktopFetch).mockResolvedValue(new Response('{"error":"missing"}', { status: 404 }));
    await expect(api.loadProject('project')).rejects.toBeInstanceOf(ApiError);
    expect(trackDetail).toHaveBeenCalledWith('error_cloud_load');
    expect(trackDetail).toHaveBeenCalledWith('cloud_status', 'other');
  });

  it('does not record unsuccessful or malformed downloads', async () => {
    vi.mocked(desktopFetch).mockResolvedValueOnce(
      new Response('{"error":"unavailable"}', { status: 503 })
    ).mockResolvedValueOnce(new Response('invalid JSON'));
    await expect(api.loadProject('project')).rejects.toBeInstanceOf(ApiError);
    await expect(api.loadRevision('project', 'revision')).rejects.toThrow();
    expect(trackSize).not.toHaveBeenCalled();
  });

  it.each(['projects', 'revisions'] as const)(
    'excludes %s metadata listings from document download observations',
    async (kind) => {
      vi.mocked(desktopFetch).mockResolvedValue(new Response('{}'));
      const loaded = kind === 'projects'
        ? await api.listProjects()
        : await api.listRevisions('project');
      expect(loaded).toEqual({});
      expect(trackSize).not.toHaveBeenCalled();
    }
  );

  it('excludes account responses from project transfer observations', async () => {
    vi.mocked(desktopFetch).mockResolvedValue(new Response('{}'));
    expect(await api.session()).toEqual({});
    expect(trackSize).not.toHaveBeenCalled();
  });
});
