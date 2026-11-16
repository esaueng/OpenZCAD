import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_API_ORIGIN } from './desktopBridge';
import {
  DESKTOP_API_HOSTNAME,
  HOSTED_REALMS,
  inDeviceListRealm,
  realmForPage,
  realmStorageName
} from './deploymentRealm';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('deployment realms', () => {
  it('names the hosted channels by hostname and nothing else', () => {
    const page = (hostname: string) =>
      realmForPage({ hostname, desktop: false });
    expect(page('zcad.app')).toBe('stable');
    expect(page('stable.zcad.app')).toBe('stable');
    expect(page('ZCAD.app.')).toBe('stable');
    expect(page('beta.zcad.app')).toBe('beta');
    for (const hostname of [
      'dev.zcad.app',
      'feature-x.dev.zcad.app',
      'localhost',
      '127.0.0.1',
      'evilzcad.app',
      'zcad.app.evil.example',
      'cad.example.com',
      '',
      'constructor',
      '__proto__'
    ])
      expect(page(hostname), hostname).toBeNull();
  });

  it('gives the desktop app the realm of the hosted API it calls', () => {
    expect(DESKTOP_API_HOSTNAME).toBe(new URL(CLOUD_API_ORIGIN).hostname);
    expect(realmForPage({ hostname: 'tauri.localhost', desktop: true })).toBe(
      HOSTED_REALMS[new URL(CLOUD_API_ORIGIN).hostname]
    );
  });

  it('keeps beta and unlabelled pages on the names state had before realms', () => {
    expect(realmStorageName('openzcad-e2ee', 'beta')).toBe('openzcad-e2ee');
    expect(realmStorageName('openzcad-e2ee', null)).toBe('openzcad-e2ee');
    expect(realmStorageName('openzcad-e2ee', 'stable')).toBe(
      'openzcad-e2ee@stable'
    );
  });

  it('adds the realm to device-list verification only when there is one', () => {
    expect(inDeviceListRealm({}, undefined)).toEqual({});
    expect(inDeviceListRealm({ pin: 1 }, 'stable')).toEqual({
      pin: 1,
      realm: 'stable'
    });
  });

  it('reads the realm from the page it loads in', async () => {
    vi.stubGlobal('location', { hostname: 'zcad.app' });
    vi.resetModules();
    const stable = await import('./deploymentRealm');
    expect(stable.DEPLOYMENT_REALM).toBe('stable');
    expect(stable.DEVICE_LIST_REALM).toBe('stable');

    vi.stubGlobal('location', { hostname: 'beta.zcad.app' });
    vi.resetModules();
    const beta = await import('./deploymentRealm');
    expect(beta.DEPLOYMENT_REALM).toBe('beta');
    expect(beta.realmStorageName('openzcad-e2ee')).toBe('openzcad-e2ee');
  });
});
