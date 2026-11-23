import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelForPage } from './releaseChannel';

const page = (
  hostname: string,
  extra: { desktop?: boolean; devServer?: boolean } = {}
) => ({
  hostname,
  desktop: extra.desktop ?? false,
  devServer: extra.devServer ?? false
});

describe('release channel for the brand tag', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('names the hosted channels by their hostnames', () => {
    expect(channelForPage(page('zcad.app'))).toBe('stable');
    expect(channelForPage(page('stable.zcad.app'))).toBe('stable');
    expect(channelForPage(page('ZCAD.app.'))).toBe('stable');
    expect(channelForPage(page('beta.zcad.app'))).toBe('beta');
  });

  it('gives the desktop app the channel of the API it calls', () => {
    expect(channelForPage(page('tauri.localhost', { desktop: true }))).toBe(
      'stable'
    );
  });

  it('calls development servers, local builds and Previews dev', () => {
    expect(channelForPage(page('zcad.app', { devServer: true }))).toBe('dev');
    expect(channelForPage(page('localhost'))).toBe('dev');
    expect(channelForPage(page('127.0.0.1'))).toBe('dev');
    expect(channelForPage(page('127.0.0.2'))).toBe('dev');
    expect(channelForPage(page('127.255.10.1'))).toBe('dev');
    expect(channelForPage(page('[::1]'))).toBe('dev');
    expect(channelForPage(page('app.localhost'))).toBe('dev');
    expect(channelForPage(page('my-branch.dev.zcad.app'))).toBe('dev');
  });

  it('keeps self-hosted deployments on the tag they had', () => {
    expect(channelForPage(page('cad.example.com'))).toBe('beta');
    expect(channelForPage(page('dev.zcad.app.example.com'))).toBe('beta');
    expect(channelForPage(page('127.0.0.1.example.com'))).toBe('beta');
    expect(channelForPage(page('127.0.0.256'))).toBe('beta');
  });

  it('reads the channel from the page it loads in', async () => {
    vi.stubGlobal('location', { hostname: 'zcad.app' });
    vi.stubEnv('DEV', false);
    vi.resetModules();
    const { RELEASE_CHANNEL } = await import('./releaseChannel');
    expect(RELEASE_CHANNEL).toBe('stable');
    vi.unstubAllEnvs();
  });
});
