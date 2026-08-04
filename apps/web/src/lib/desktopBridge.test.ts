import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  desktopCollaborationUrl,
  desktopFetch,
  isDesktopApp,
  nativeCadFile
} from './desktopBridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
  vi.mocked(invoke).mockReset();
});

describe('desktop bridge', () => {
  it('detects the Tauri runtime without changing browser behavior', () => {
    expect(isDesktopApp()).toBe(false);
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    expect(isDesktopApp()).toBe(true);
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
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
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
