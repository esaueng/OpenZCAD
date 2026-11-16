/**
 * Which hosted deployment this page belongs to (docs/release-channels.md).
 *
 * The beta and stable Workers share code but nothing else: each has its own
 * database, so the same email signs in as the same user id on both, with
 * different accounts behind it. A browser keeps per-account state (device
 * keys, device-list pins, sequence floors, unsynced edits) under that user
 * id, so state written for one deployment must never be read for the other.
 * That happened when zcad.app moved from the beta Worker to stable: the
 * browser still held beta's device-list pin, stable reported no keys, and
 * encryption refused to set up because the pin said keys had disappeared.
 *
 * The realm comes from the page's own hostname, which no server response
 * can change, and the desktop app's from the hosted API it is built to call.
 * The table must follow every change to the Workers' routes;
 * `test/release-channels.test.ts` ties it to both configs.
 *
 * The realm does two things:
 * - `realmStorageName` keeps each realm's local state apart. Beta keeps the
 *   unlabelled names, since state written before realms existed belongs to
 *   it: zcad.app and beta.zcad.app both served beta until the stable cutover.
 * - New identities bind their device list to the realm (`DeviceListEntry.realm`),
 *   and verification refuses a list bound to another realm.
 *
 * Previews, development, tests and self-hosted deployments have no realm:
 * their state keeps the unlabelled names and their lists stay unbound.
 */
export type DeploymentRealm = 'beta' | 'stable';

/** Hostnames of the hosted channels, as served by their Workers. */
export const HOSTED_REALMS: Readonly<Record<string, DeploymentRealm>> =
  Object.freeze({
    'beta.zcad.app': 'beta',
    'zcad.app': 'stable',
    'stable.zcad.app': 'stable'
  });

/** The hostname the desktop app's hosted API lives at (`CLOUD_API_ORIGIN`). */
export const DESKTOP_API_HOSTNAME = 'zcad.app';

/** Realms whose local state keeps the names it had before realms existed. */
const UNLABELLED_REALMS: ReadonlySet<DeploymentRealm | null> = new Set([
  null,
  'beta'
]);

export function realmForPage(page: {
  readonly hostname: string;
  readonly desktop: boolean;
}): DeploymentRealm | null {
  const hostname = page.desktop
    ? DESKTOP_API_HOSTNAME
    : page.hostname.toLowerCase().replace(/\.$/, '');
  return Object.hasOwn(HOSTED_REALMS, hostname)
    ? HOSTED_REALMS[hostname]!
    : null;
}

function currentRealm(): DeploymentRealm | null {
  const hostname = globalThis.location?.hostname;
  return realmForPage({
    hostname: typeof hostname === 'string' ? hostname : '',
    // The same check as `isDesktopApp` (desktopBridge.ts), inlined so the
    // storage modules that read the realm do not load the bridge.
    desktop: typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  });
}

/** This page's realm; null outside the hosted channels. */
export const DEPLOYMENT_REALM: DeploymentRealm | null = currentRealm();

/**
 * The realm new device lists are bound to and existing ones are checked
 * against, as `verifyDeviceList` and `DeviceListEntry` take it.
 */
export const DEVICE_LIST_REALM: string | undefined =
  DEPLOYMENT_REALM ?? undefined;

/** `verifyDeviceList` options with this page's realm added, when it has one. */
export function inDeviceListRealm<T extends object>(
  options: T,
  realm: string | undefined = DEVICE_LIST_REALM
): T & { readonly realm?: string } {
  return realm === undefined ? options : { ...options, realm };
}

/**
 * The name of a piece of per-account local state (an IndexedDB database or
 * a localStorage key prefix) for `realm`: unchanged for beta and for pages
 * outside the hosted channels, `<name>@<realm>` otherwise.
 */
export function realmStorageName(
  name: string,
  realm: DeploymentRealm | null = DEPLOYMENT_REALM
): string {
  return UNLABELLED_REALMS.has(realm) ? name : `${name}@${realm}`;
}
