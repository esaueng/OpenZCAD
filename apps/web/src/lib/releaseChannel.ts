import { realmForPage } from './deploymentRealm';

/**
 * The channel the brand's tag names (docs/release-channels.md).
 *
 * - `stable`: the stable Worker (`zcad.app`, `stable.zcad.app`) and the
 *   desktop app, which calls the stable API.
 * - `beta`: the beta Worker (`beta.zcad.app`) and any other host, so a
 *   self-hosted deployment keeps the tag it always had.
 * - `dev`: a development server, a local build (`localhost`, loopback) or a
 *   Worker Preview (`<name>.dev.zcad.app`), all of which run unreleased code.
 */
export type ReleaseChannel = 'stable' | 'beta' | 'dev';

/** Worker Previews (docs/previews.md). */
const PREVIEW_SUFFIX = '.dev.zcad.app';

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]'
]);

export function channelForPage(page: {
  readonly hostname: string;
  readonly desktop: boolean;
  readonly devServer: boolean;
}): ReleaseChannel {
  if (page.devServer) return 'dev';
  const realm = realmForPage(page);
  if (realm) return realm;
  const hostname = page.hostname.toLowerCase().replace(/\.$/, '');
  if (
    LOOPBACK_HOSTS.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith(PREVIEW_SUFFIX)
  ) {
    return 'dev';
  }
  return 'beta';
}

export const CHANNEL_LABELS: Readonly<Record<ReleaseChannel, string>> =
  Object.freeze({ stable: 'Stable', beta: 'Beta', dev: 'Dev' });

function currentChannel(): ReleaseChannel {
  const hostname = globalThis.location?.hostname;
  return channelForPage({
    hostname: typeof hostname === 'string' ? hostname : '',
    desktop: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
    devServer: import.meta.env.DEV === true
  });
}

/** This page's channel, fixed for the page's life. */
export const RELEASE_CHANNEL: ReleaseChannel = currentChannel();
