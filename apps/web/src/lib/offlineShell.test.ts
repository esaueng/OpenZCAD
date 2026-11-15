import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * public/sw.js runs as written, against an in-memory Cache Storage and a
 * scripted network, so the fetch strategy is tested as shipped.
 */
const source = readFileSync(
  join(resolve(__dirname, '../..'), 'public', 'sw.js'),
  'utf8'
);
const ORIGIN = 'https://openzcad.test';

class MemoryCache {
  readonly entries = new Map<string, Response>();
  async match(request: Request | string) {
    const key =
      typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    return this.entries.get(key)?.clone();
  }
  async put(request: Request | string, response: Response) {
    const key =
      typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    this.entries.delete(key);
    this.entries.set(key, response);
  }
  async delete(request: Request) {
    return this.entries.delete(request.url);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

function load(network: (request: Request) => Promise<Response>) {
  const cache = new MemoryCache();
  const listeners = new Map<string, (event: unknown) => void>();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
    registration: {}
  };
  const caches = {
    open: async () => cache,
    keys: async () => ['openzcad-shell-v0', 'openzcad-shell-v1', 'other-app'],
    delete: async () => true
  };
  // Its own global scope, as a worker has; only what it uses is provided.
  runInNewContext(source, {
    self,
    caches,
    fetch: network,
    URL,
    Promise,
    Math
  });
  /** What the worker answers, or undefined when it lets the request pass. */
  const fetchEvent = async (
    url: string,
    init: RequestInit & { mode?: string } = {}
  ) => {
    // A page can't construct a navigation request; mark one afterwards.
    const { mode, ...rest } = init;
    const request = new Request(new URL(url, ORIGIN).href, rest);
    if (mode) Object.defineProperty(request, 'mode', { value: mode });
    let answer: Promise<Response> | undefined;
    listeners.get('fetch')!({
      request,
      respondWith: (response: Promise<Response>) => {
        answer = response;
      }
    });
    return answer;
  };
  return { cache, fetchEvent };
}

const ok = (body: string, contentType = 'text/html; charset=utf-8') => {
  const response = new Response(body, {
    status: 200,
    headers: { 'content-type': contentType }
  });
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
};

describe('the offline shell worker', () => {
  it('loads pages from the network and keeps the last one for offline', async () => {
    let online = true;
    const { fetchEvent } = load(async () => {
      if (!online) throw new TypeError('offline');
      return ok('<html>v2</html>');
    });
    expect(await (await fetchEvent('/', { mode: 'navigate' }))!.text()).toBe(
      '<html>v2</html>'
    );
    online = false;
    expect(
      await (await fetchEvent('/projects/abc', { mode: 'navigate' }))!.text()
    ).toBe('<html>v2</html>');
  });

  it('serves hashed assets from the cache once fetched', async () => {
    let fetches = 0;
    const { fetchEvent } = load(async () => {
      fetches += 1;
      return ok('wasm');
    });
    await (await fetchEvent('/assets/remus_wasm_bg-abc.wasm'))!.text();
    expect(
      await (await fetchEvent('/assets/remus_wasm_bg-abc.wasm'))!.text()
    ).toBe('wasm');
    expect(fetches).toBe(1);
  });

  it('leaves the API, other origins and writes to the network', async () => {
    const { fetchEvent } = load(async () => ok('x'));
    expect(await fetchEvent('/api/projects')).toBeUndefined();
    expect(
      await fetchEvent('https://challenges.cloudflare.com/t.js')
    ).toBeUndefined();
    expect(
      await fetchEvent('/assets/a.js', { method: 'POST', body: 'x' })
    ).toBeUndefined();
  });

  it('keeps only the app shell for offline launches', async () => {
    let online = true;
    const { cache, fetchEvent } = load(async (request) => {
      if (!online) throw new TypeError('offline');
      const path = new URL(request.url).pathname;
      if (path === '/privacy.html') return ok('<html>privacy</html>');
      if (path.startsWith('/api/') || path === '/healthz')
        return ok('{"user":"someone"}', 'application/json');
      if (path === '/manifest.webmanifest')
        return ok('{}', 'application/manifest+json');
      if (path === '/projects/json') return ok('{}', 'application/json');
      return ok('<html>shell</html>');
    });
    await fetchEvent('/projects/abc', { mode: 'navigate' });
    for (const path of [
      '/privacy.html',
      '/api/session',
      '/healthz',
      '/manifest.webmanifest',
      '/projects/json'
    ])
      await fetchEvent(path, { mode: 'navigate' });
    expect([...cache.entries.keys()]).toEqual([`${ORIGIN}/`]);
    online = false;
    expect(await (await fetchEvent('/', { mode: 'navigate' }))!.text()).toBe(
      '<html>shell</html>'
    );
  });

  it('keeps no failed response', async () => {
    const { cache, fetchEvent } = load(
      async () => new Response('', { status: 500 })
    );
    await fetchEvent('/assets/broken.js');
    await fetchEvent('/', { mode: 'navigate' });
    expect(cache.entries.size).toBe(0);
  });
});
