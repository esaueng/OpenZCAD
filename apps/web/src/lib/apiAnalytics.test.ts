import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { isAnalyticsEnabled, trackDetail, trackSize } from './analytics';
import { desktopFetch } from './desktopBridge';

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
      const text = '{ "name": "測試⚙", "version": 1 }';
      const response = new Response(text);
      vi.mocked(desktopFetch).mockResolvedValue(response);
      const loaded = kind === 'project'
        ? await api.loadProject('project')
        : await api.loadRevision('project', 'revision');
      expect(loaded).toEqual(JSON.parse(text));
      expect(response.bodyUsed).toBe(true);
      expect(trackSize).toHaveBeenCalledExactlyOnceWith(
        'transfer_download', new TextEncoder().encode(text).byteLength
      );
    }
  );

  it('keeps successful downloads available without analytics consent', async () => {
    vi.mocked(isAnalyticsEnabled).mockReturnValue(false);
    vi.mocked(desktopFetch).mockResolvedValue(new Response('{"version":1}'));
    expect(await api.loadProject('project')).toEqual({ version: 1 });
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
