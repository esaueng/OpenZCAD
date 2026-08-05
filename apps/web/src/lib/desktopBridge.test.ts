import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  desktopCollaborationUrl,
  desktopFetch,
  isDesktopApp,
  nativeCadFile,
  protectDesktopClose
} from './desktopBridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));

function markDesktopRuntime() {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
    {};
}

function mockDesktopWindow() {
  let closeHandler:
    ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const unlisten = vi.fn();
  const destroy = vi.fn().mockResolvedValue(undefined);
  const onCloseRequested = vi.fn(
    (handler: (event: { preventDefault(): void }) => Promise<void>) => {
      closeHandler = handler;
      return Promise.resolve(unlisten);
    }
  );
  vi.mocked(getCurrentWindow).mockReturnValue({
    destroy,
    onCloseRequested
  } as unknown as ReturnType<typeof getCurrentWindow>);
  return {
    destroy,
    handler: () => {
      if (!closeHandler) {
        throw new Error('The desktop close handler was not registered.');
      }
      return closeHandler;
    },
    onCloseRequested,
    unlisten
  };
}

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  vi.mocked(invoke).mockReset();
  vi.mocked(getCurrentWindow).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop bridge', () => {
  it('detects the Tauri runtime without changing browser behavior', () => {
    expect(isDesktopApp()).toBe(false);
    markDesktopRuntime();
    expect(isDesktopApp()).toBe(true);
  });

  it('grants the native destroy permission required to finish a close request', () => {
    const capability = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          '../desktop/src-tauri/capabilities/default.json'
        ),
        'utf8'
      )
    ) as { permissions: string[] };

    expect(capability.permissions).toContain('core:window:allow-destroy');
  });

  it('allows an idle desktop close request to finish normally', async () => {
    markDesktopRuntime();
    const appWindow = mockDesktopWindow();
    const preventDefault = vi.fn();

    const unlisten = await protectDesktopClose(() => false);
    await appWindow.handler()({ preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(appWindow.destroy).not.toHaveBeenCalled();
    unlisten();
    expect(appWindow.unlisten).toHaveBeenCalledOnce();
  });

  it('destroys the window when a saving close is confirmed', async () => {
    markDesktopRuntime();
    const appWindow = mockDesktopWindow();
    const preventDefault = vi.fn();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);

    await protectDesktopClose(() => true);
    await appWindow.handler()({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(appWindow.destroy).toHaveBeenCalledOnce();
  });

  it('converts native bytes into a browser File with CAD content type', async () => {
    const file = nativeCadFile({
      name: 'bracket.STEP',
      bytes: [73, 83, 79]
    });
    expect(file.name).toBe('bracket.STEP');
    expect(file.type).toBe('model/step');
    expect(await file.text()).toBe('ISO');
  });

  it('keeps cloud credentials in Rust while returning a fetch response', async () => {
    markDesktopRuntime();
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      contentType: 'application/json',
      body: Array.from(new TextEncoder().encode('{"ok":true}'))
    });

    const response = await desktopFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{"theme":"dark"}'
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('desktop_api_request', {
      request: {
        method: 'PATCH',
        path: '/api/settings',
        contentType: 'application/json',
        body: Array.from(new TextEncoder().encode('{"theme":"dark"}'))
      }
    });
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain(
      'Bearer'
    );
  });

  it('accepts only a ticketed fixed-origin collaboration URL from Rust', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    vi.mocked(invoke).mockResolvedValue(
      `wss://zcad.esau.app/api/projects/proj_native/collaboration?ticket=${'t'.repeat(43)}`
    );

    await expect(desktopCollaborationUrl('proj_native')).resolves.toBe(
      `wss://zcad.esau.app/api/projects/proj_native/collaboration?ticket=${'t'.repeat(43)}`
    );
    expect(invoke).toHaveBeenCalledWith('desktop_collaboration_url', {
      projectId: 'proj_native'
    });
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain(
      'Bearer'
    );

    vi.mocked(invoke).mockResolvedValue(
      `wss://attacker.example/api/projects/proj_native/collaboration?ticket=${'t'.repeat(43)}`
    );
    await expect(desktopCollaborationUrl('proj_native')).rejects.toThrow(
      /not allowed/i
    );
  });
});
