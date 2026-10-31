import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { serveAssetFallback } from '../apps/web/worker/assetFallback';

const shell = () =>
  new Response('<!doctype html><title>OpenZCAD</title>', {
    headers: {
      'content-type': 'text/html',
      'content-security-policy': "default-src 'self'"
    }
  });

describe('asset miss fallback', () => {
  it('answers a chunk a newer deploy renamed with an uncacheable 404', async () => {
    const fetch = vi.fn(async () => shell());
    const response = await worker.fetch(
      new Request('https://app.example/assets/ViewModeBar-OLDHASH.js'),
      { ASSETS: { fetch } }
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).not.toMatch(/html/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD'])(
    'opens the app shell for any other path (%s)',
    async (method) => {
      const fetch = vi.fn(async (_request: Request) => shell());
      const response = await worker.fetch(
        new Request('https://app.example/some/deep/link?project=1', {
          method,
          headers: { accept: 'text/html' }
        }),
        { ASSETS: { fetch } }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html');
      const asked = fetch.mock.calls[0]![0];
      expect(new URL(asked.url).pathname).toBe('/');
      expect(asked.method).toBe(method);
    }
  );

  it('refuses writes to a non-API path', async () => {
    const fetch = vi.fn();
    const response = await worker.fetch(
      new Request('https://app.example/somewhere', { method: 'POST' }),
      { ASSETS: { fetch } }
    );
    expect(response.status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns a missing FreeCAD worker into the same uncacheable 404', async () => {
    const response = await worker.fetch(
      new Request('https://app.example/assets/freecadImportWorker-gone.js'),
      {
        ASSETS: {
          fetch: async () =>
            new Response('Not found', {
              status: 404,
              headers: {
                'cache-control': 'public, max-age=31536000, immutable'
              }
            })
        }
      }
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['/api/definitely-not-a-route', '/healthz'])(
    'leaves %s to the Worker routes without reading the binding',
    async (path) => {
      const assets = vi.fn();
      expect(
        await serveAssetFallback(
          new Request(`https://app.example${path}`),
          assets
        )
      ).toBeNull();
      expect(assets).not.toHaveBeenCalled();
    }
  );
});
