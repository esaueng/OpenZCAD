import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import worker from '../apps/web/worker/index';
import { FREECAD_WORKER_CSP } from '../apps/web/worker/freecadWorkerAsset';

describe('FreeCAD worker CSP isolation', () => {
  it.each(['GET', 'HEAD'])(
    'replaces the asset policy only for a JS worker (%s)',
    async (method) => {
      const fetch = vi.fn(
        async () =>
          new Response(method === 'HEAD' ? null : 'worker code', {
            headers: {
              'content-type': 'text/javascript',
              'Content-Security-Policy': "script-src 'self'",
              'cache-control': 'public, max-age=31536000, immutable'
            }
          })
      );
      const response = await worker.fetch(
        new Request(
          'https://app.example/assets/freecadImportWorker-abc123.js',
          { method }
        ),
        { ASSETS: { fetch } }
      );
      expect(response.headers.get('content-security-policy')).toBe(
        FREECAD_WORKER_CSP
      );
      expect(response.headers.get('cache-control')).toContain('immutable');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(fetch).toHaveBeenCalledOnce();
    }
  );
  it('keeps the strict policy on a missing chunk SPA fallback', async () => {
    const strict = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'";
    const response = await worker.fetch(
      new Request('https://app.example/assets/freecadImportWorker-missing.js'),
      {
        ASSETS: {
          fetch: async () =>
            new Response('<html>SPA</html>', {
              headers: {
                'content-type': 'text/html',
                'content-security-policy': strict
              }
            })
        }
      }
    );
    expect(response.headers.get('content-security-policy')).toBe(strict);
  });
  it('refuses writes without accessing the asset binding', async () => {
    const fetch = vi.fn();
    const response = await worker.fetch(
      new Request('https://app.example/assets/freecadImportWorker-abc.js', {
        method: 'POST'
      }),
      { ASSETS: { fetch } }
    );
    expect(response.status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('routes only the dedicated worker prefix in all deployment configurations', () => {
    for (const file of [
      'wrangler.jsonc',
      'apps/web/wrangler.jsonc',
      'wrangler.selfhost.example.jsonc'
    ]) {
      expect(readFileSync(file, 'utf8')).toContain(
        '"/assets/freecadImportWorker-*"'
      );
    }
    const headers = readFileSync('apps/web/public/_headers', 'utf8');
    expect(headers).not.toContain("'unsafe-eval'");
    expect(headers).toContain('https://static.cloudflareinsights.com');
    expect(headers).toContain('https://cloudflareinsights.com');
  });
});
