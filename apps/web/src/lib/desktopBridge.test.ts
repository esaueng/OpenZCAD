import { afterEach, describe, expect, it } from 'vitest';
import { isDesktopApp, nativeCadFile } from './desktopBridge';

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown })
    .__TAURI_INTERNALS__;
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
});
