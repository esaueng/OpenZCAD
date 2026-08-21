import { describe, expect, it, vi } from 'vitest';
import {
  buildShareLinkUrl,
  createProjectShareLinkClient,
  sharedAssetUrl
} from './projectShareClient';
import { ProjectSharingApiError } from './projectSharing';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('project share link client', () => {
  it('calls every share-link route with encoded identifiers and typed bodies', async () => {
    const shareLink = {
      shareLinkId: 'share_1',
      projectId: 'project/one',
      mode: 'tweak',
      createdAt: 1,
      revokedAt: null
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ shareLink, token: 'secret' }, 201))
      .mockResolvedValueOnce(jsonResponse({ shareLinks: [shareLink] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({
          project: { projectId: 'project/one', name: 'One', mode: 'tweak' },
          document: {}
        })
      );
    const client = createProjectShareLinkClient(fetcher);

    await expect(
      client.createProjectShareLink('project/one', 'tweak')
    ).resolves.toMatchObject({ token: 'secret' });
    await expect(
      client.listProjectShareLinks('project/one')
    ).resolves.toEqual([shareLink]);
    await client.revokeProjectShareLink('project/one', 'share/1');
    await expect(client.fetchSharedProject('token_value')).resolves.toMatchObject(
      { project: { name: 'One' } }
    );

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/projects/project%2Fone/share-links',
      '/api/projects/project%2Fone/share-links',
      '/api/projects/project%2Fone/share-links/share%2F1',
      '/api/share/token_value'
    ]);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ mode: 'tweak' })
    });
    // The anonymous route must never carry an authenticated session.
    expect(fetcher.mock.calls[3]![1]).toMatchObject({ credentials: 'omit' });
  });

  it('resolves null for unknown or revoked share tokens and throws otherwise', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ error: 'Share link not found.' }, 404)
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: 'Internal error' }, 500)
      );
    const client = createProjectShareLinkClient(fetcher);

    await expect(client.fetchSharedProject('gone_token')).resolves.toBeNull();
    await expect(client.fetchSharedProject('bad_token')).rejects.toMatchObject({
      name: 'ProjectSharingApiError',
      status: 500
    });
  });

  it('surfaces route error payloads as typed errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'Project sharing is disabled for this account.', code: 'FEATURE_DISABLED' },
          501
        )
      );
    const client = createProjectShareLinkClient(fetcher);
    const failure = await client
      .createProjectShareLink('project_x', 'tweak')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProjectSharingApiError);
    expect(failure).toMatchObject({
      status: 501,
      code: 'FEATURE_DISABLED',
      message: 'Project sharing is disabled for this account.'
    });
  });

  it('builds fragment share URLs and asset URLs', () => {
    const token = 'a'.repeat(43);
    expect(buildShareLinkUrl(token)).toBe(
      `${location.origin}/#share=${token}`
    );
    expect(sharedAssetUrl(token, 'asset/1')).toBe(
      `/api/share/${token}/assets/asset%2F1`
    );
    expect(() => sharedAssetUrl('  ', 'asset_1')).toThrow(
      'Share token is required.'
    );
  });
});
