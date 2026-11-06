import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CAD_IMPORT_ACCEPT,
  fileAccept,
  isAppleTouchDevice,
  isStandaloneApp,
  persistStorageForInstalledApp
} from './appleTouch';

const IPAD =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

describe('Apple touch devices', () => {
  it('knows an iPad by its Mac user agent with touch points', () => {
    expect(isAppleTouchDevice({ userAgent: IPAD, maxTouchPoints: 5 })).toBe(
      true
    );
    expect(isAppleTouchDevice({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(
      true
    );
    // A Mac has no touch screen; a touch laptop is not Apple.
    expect(isAppleTouchDevice({ userAgent: IPAD, maxTouchPoints: 0 })).toBe(
      false
    );
    expect(isAppleTouchDevice({ userAgent: WINDOWS, maxTouchPoints: 10 })).toBe(
      false
    );
  });

  it('drops the extension filter only where the Files picker would grey files out', () => {
    expect(
      fileAccept(CAD_IMPORT_ACCEPT, { userAgent: IPAD, maxTouchPoints: 5 })
    ).toBeUndefined();
    expect(
      fileAccept('.openzcad', { userAgent: WINDOWS, maxTouchPoints: 10 })
    ).toBe('.openzcad');
  });
});

describe('installed app storage', () => {
  function fakeWindow(standalone: boolean, storage?: Partial<StorageManager>) {
    return {
      matchMedia: (query: string) => ({
        matches: standalone && query === '(display-mode: standalone)'
      }),
      navigator: { storage }
    } as unknown as Window;
  }

  it('asks to persist storage only as an installed app', async () => {
    const persist = vi.fn(async () => true);
    const persisted = vi.fn(async () => false);
    expect(
      await persistStorageForInstalledApp(
        fakeWindow(false, { persist, persisted })
      )
    ).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(
      await persistStorageForInstalledApp(
        fakeWindow(true, { persist, persisted })
      )
    ).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('does not ask again once granted, and survives a browser without the API', async () => {
    const persist = vi.fn(async () => true);
    expect(
      await persistStorageForInstalledApp(
        fakeWindow(true, { persist, persisted: async () => true })
      )
    ).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    expect(await persistStorageForInstalledApp(fakeWindow(true))).toBe(false);
    expect(isStandaloneApp(fakeWindow(true))).toBe(true);
  });
});

describe('the Home Screen manifest', () => {
  const web = resolve(__dirname, '../..');
  it('is linked from the page and names icons that ship', () => {
    expect(readFileSync(join(web, 'index.html'), 'utf8')).toContain(
      '<link rel="manifest" href="/manifest.webmanifest" />'
    );
    const manifest = JSON.parse(
      readFileSync(join(web, 'public', 'manifest.webmanifest'), 'utf8')
    ) as { display: string; start_url: string; icons: { src: string }[] };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    for (const icon of manifest.icons) {
      expect(existsSync(join(web, 'public', icon.src))).toBe(true);
    }
  });
});
