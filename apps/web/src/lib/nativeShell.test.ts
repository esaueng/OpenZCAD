import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_PROJECT_FRAME_CONTENT_TYPE } from '@openzcad/shared';

/**
 * The iPhone and iPad app's web side (ADR-026): its cloud requests go to the
 * native proxy on the private origin, project requests with a single-send
 * handle, and its session operations go over `openzcadNative`.
 */

type Reply = Record<string, unknown>;
const HANDLE = 'h'.repeat(43);
const NEXT_HANDLE = 'n'.repeat(43);

let replies: Record<string, (() => Reply)[]>;
let posted: { v: number; op: string }[];
let fetches: { url: string; init: RequestInit }[];
let fetchResponses: Response[];

function enterShell(withHandler = true) {
  vi.stubGlobal('location', {
    protocol: 'zcad-ipad:',
    href: 'zcad-ipad://app/',
    origin: 'zcad-ipad://app'
  });
  if (withHandler) {
    (globalThis as { webkit?: unknown }).webkit = {
      messageHandlers: {
        openzcadNative: {
          postMessage: async (message: { v: number; op: string }) => {
            posted.push(message);
            const queue = replies[message.op];
            const next = queue?.length ? queue.shift()! : undefined;
            return next
              ? next()
              : {
                  ok: false,
                  error: { name: 'NotSupportedError', message: 'unscripted' }
                };
          }
        }
      }
    };
  }
}

function reply(op: string, ...results: Reply[]) {
  replies[op] = [
    ...(replies[op] ?? []),
    ...results.map((result) => () => result)
  ];
}

async function load() {
  vi.resetModules();
  const shell = await import('./nativeShell');
  const bridge = await import('./desktopBridge');
  const { projectRequest } = await import('./projectWriteGate');
  // A project's own document write, declared as the app declares it.
  const documentWrite = (init: RequestInit) =>
    projectRequest({ projectId: 'proj_a', payload: 'plaintext' }, init);
  return { shell, bridge, projectRequest, documentWrite };
}

beforeEach(() => {
  replies = {};
  posted = [];
  fetches = [];
  fetchResponses = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      fetches.push({ url, init });
      return fetchResponses.shift() ?? new Response('{}', { status: 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { webkit?: unknown }).webkit;
});

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe('native shell detection', () => {
  it('offers a native session only in the app with its message handler', async () => {
    let { shell } = await load();
    expect(shell.isIosShell()).toBe(false);
    expect(shell.nativeSessionAvailable()).toBe(false);

    enterShell(false);
    ({ shell } = await load());
    expect(shell.isIosShell()).toBe(true);
    // An older app without the bridge stays offline-only.
    expect(shell.nativeSessionAvailable()).toBe(false);
    await expect(shell.nativeSignIn()).rejects.toMatchObject({
      name: 'NotSupportedError'
    });

    enterShell();
    ({ shell } = await load());
    expect(shell.nativeSessionAvailable()).toBe(true);
  });

  it('signs in only over bridge version 1, with the error the app names', async () => {
    enterShell();
    const { shell } = await load();
    reply('capabilities', {
      ok: true,
      result: { bridge: 1, passkeys: 'unsupported' }
    });
    reply('session.signIn', {
      ok: false,
      error: { name: 'NotAllowedError', message: 'Sign-in was cancelled.' }
    });
    await expect(shell.nativeSignIn()).rejects.toMatchObject({
      name: 'NotAllowedError',
      message: 'Sign-in was cancelled.'
    });
    reply('session.signIn', { ok: true, result: { signedIn: true } });
    await expect(shell.nativeSignIn()).resolves.toBe(true);
    expect(posted).toEqual([
      { v: 1, op: 'capabilities' },
      { v: 1, op: 'session.signIn' },
      { v: 1, op: 'session.signIn' }
    ]);
  });

  it('refuses to sign in over another bridge version', async () => {
    enterShell();
    const { shell } = await load();
    reply('capabilities', { ok: true, result: { bridge: 2 } });
    await expect(shell.nativeSignIn()).rejects.toMatchObject({
      name: 'NotSupportedError'
    });
    expect(posted.map((message) => message.op)).toEqual(['capabilities']);
  });

  it('accepts only an opaque handle from session.prepare', async () => {
    enterShell();
    const { shell } = await load();
    reply(
      'session.prepare',
      { ok: true, result: { handle: HANDLE } },
      { ok: true, result: { handle: null } },
      { ok: true, result: { handle: 'Bearer token' } }
    );
    await expect(shell.nativePrepare()).resolves.toBe(HANDLE);
    await expect(shell.nativePrepare()).resolves.toBeNull();
    await expect(shell.nativePrepare()).rejects.toThrow();
  });
});

describe('shell cloud requests', () => {
  it('sends an ordinary request to the proxy without a handle or cookies', async () => {
    enterShell();
    const { bridge } = await load();
    await bridge.desktopFetch('/api/session', { credentials: 'same-origin' });
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url).toBe('/api/session');
    expect(fetches[0]!.init.credentials).toBe('omit');
    expect(fetches[0]!.init.redirect).toBe('error');
    expect(header(fetches[0]!.init, 'x-openzcad-prepared')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('sends a project write once with exactly the handle readied for it', async () => {
    enterShell();
    const { bridge, documentWrite } = await load();
    reply('session.prepare', { ok: true, result: { handle: HANDLE } });
    await bridge.desktopFetch(
      '/api/projects/proj_a/document',
      documentWrite({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
    );
    expect(fetches).toHaveLength(1);
    expect(header(fetches[0]!.init, 'x-openzcad-prepared')).toBe(HANDLE);
    expect(posted).toEqual([{ v: 1, op: 'session.prepare' }]);
  });

  it('readies a new handle once after a 401, then returns the second answer', async () => {
    enterShell();
    const { bridge, documentWrite } = await load();
    reply(
      'session.prepare',
      { ok: true, result: { handle: HANDLE } },
      { ok: true, result: { handle: NEXT_HANDLE } }
    );
    fetchResponses = [
      new Response('{}', { status: 401 }),
      new Response('{}', { status: 401 })
    ];
    const response = await bridge.desktopFetch(
      '/api/projects/proj_a/document',
      documentWrite({ method: 'PUT', body: '{}' })
    );
    expect(response.status).toBe(401);
    expect(
      fetches.map((entry) => header(entry.init, 'x-openzcad-prepared'))
    ).toEqual([HANDLE, NEXT_HANDLE]);
  });

  it('marks a signed-out project request with an empty handle', async () => {
    enterShell();
    const { bridge, documentWrite } = await load();
    reply('session.prepare', { ok: true, result: { handle: null } });
    fetchResponses = [new Response('{}', { status: 401 })];
    const response = await bridge.desktopFetch(
      '/api/projects/proj_a/document',
      documentWrite({ method: 'PUT', body: '{}' })
    );
    expect(response.status).toBe(401);
    expect(fetches).toHaveLength(1);
    expect(header(fetches[0]!.init, 'x-openzcad-prepared')).toBe('');
  });

  it('readies a handle for a declared upload and never forwards one the page set', async () => {
    enterShell();
    const { bridge, projectRequest } = await load();
    reply('session.prepare', { ok: true, result: { handle: HANDLE } });
    await bridge.desktopFetch(
      '/api/uploads',
      projectRequest(
        { projectId: 'proj_upload', payload: 'plaintext' },
        {
          method: 'POST',
          headers: { 'x-openzcad-prepared': 'forged' },
          body: '{}'
        }
      )
    );
    expect(header(fetches[0]!.init, 'x-openzcad-prepared')).toBe(HANDLE);
  });

  it('sends a Blob body as bytes, which the scheme task receives whole', async () => {
    enterShell();
    const { bridge } = await load();
    await bridge.desktopFetch('/api/settings', {
      method: 'PATCH',
      body: new Blob(['{"theme":"dark"}'])
    });
    const body = fetches[0]!.init.body;
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(body as ArrayBuffer)).toBe(
      '{"theme":"dark"}'
    );
  });

  it('sends only API paths on the cloud origin, as paths', async () => {
    enterShell();
    const { bridge } = await load();
    await bridge.desktopFetch('https://zcad.app/api/health');
    expect(fetches[0]!.url).toBe('/api/health');
    await expect(
      bridge.desktopFetch('https://attacker.example/api/health')
    ).rejects.toThrow(/not allowed/);
    expect(fetches).toHaveLength(1);
  });

  it('asks for a legacy frame by query, as the proxy forwards no accept header', async () => {
    enterShell();
    const { bridge } = await load();
    await bridge.desktopFetch('/api/projects/proj_legacy', {
      headers: { accept: LEGACY_PROJECT_FRAME_CONTENT_TYPE }
    });
    expect(fetches[0]!.url).toBe('/api/projects/proj_legacy?storage=raw');
  });

  it('builds a room URL only from a well-formed ticket', async () => {
    enterShell();
    const { bridge } = await load();
    reply(
      'session.prepare',
      { ok: true, result: { handle: HANDLE } },
      { ok: true, result: { handle: HANDLE } }
    );
    const ticket = 't'.repeat(43);
    fetchResponses = [
      new Response(JSON.stringify({ ticket, expiresAt: Date.now() + 60_000 })),
      new Response(
        JSON.stringify({ ticket: 'short', expiresAt: Date.now() + 60_000 })
      )
    ];
    await expect(bridge.desktopCollaborationUrl('proj_room')).resolves.toBe(
      `wss://zcad.app/api/projects/proj_room/collaboration?ticket=${ticket}`
    );
    expect(fetches[0]!.url).toBe(
      '/api/projects/proj_room/collaboration/ticket'
    );
    expect(header(fetches[0]!.init, 'x-openzcad-prepared')).toBe(HANDLE);
    await expect(bridge.desktopCollaborationUrl('proj_room')).rejects.toThrow(
      /invalid/
    );
  });
});
