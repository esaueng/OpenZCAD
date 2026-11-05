/**
 * iPadOS and iOS quirks that only a platform check can address (L02 slice 7,
 * docs/plans/ipad-touch-plan-2026-11-05.md). Input behaviour is still chosen
 * per event by `pointerType`; this is only for the file picker and storage.
 */

interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
}

/**
 * Every browser on iPad and iPhone is WebKit. iPadOS reports a Mac user agent
 * by default, so a Mac with touch points is an iPad (no Mac has a touch
 * screen).
 */
export function isAppleTouchDevice(nav: NavigatorLike = navigator): boolean {
  return (
    /\b(iPad|iPhone|iPod)\b/.test(nav.userAgent) ||
    (/\bMacintosh\b/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1)
  );
}

/**
 * A file input's `accept`, or none on an Apple touch device. The iOS Files
 * picker greys out every file whose type it cannot match to the list, and it
 * knows no type for `.step`, `.openzcad` or `.shapr`, so those could not be
 * chosen at all. Every import checks the format after picking anyway.
 */
export function fileAccept(
  accept: string,
  nav: NavigatorLike = navigator
): string | undefined {
  return isAppleTouchDevice(nav) ? undefined : accept;
}

/** Every CAD format the import picker offers. */
export const CAD_IMPORT_ACCEPT =
  '.shapr,.stl,.step,.stp,.3mf,.obj,.glb,.ply,.dxf';

/** Running as an installed app (Home Screen, or a desktop PWA window). */
export function isStandaloneApp(win: Window = window): boolean {
  return (
    win.matchMedia?.('(display-mode: standalone)').matches === true ||
    (win.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Asks the browser to keep this origin's storage (the local projects in
 * IndexedDB) under pressure. Only for an installed app: Firefox would ask a
 * desktop visitor in a permission prompt, and a Home Screen app is where a
 * person has said they mean to keep using this.
 */
export async function persistStorageForInstalledApp(
  win: Window = window
): Promise<boolean> {
  if (!isStandaloneApp(win)) return false;
  const storage = win.navigator.storage;
  if (!storage?.persist) return false;
  try {
    if (await storage.persisted?.()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
