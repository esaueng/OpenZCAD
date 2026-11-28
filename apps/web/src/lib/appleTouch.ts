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
 * The `accept` that opens the iOS and iPadOS Files picker on every file.
 * With no `accept` at all, WebKit first asked Photo Library or Choose
 * Files, for a picker that wants a project backup or a CAD file (the iPad
 * review). Any file is data, so this filter lists every file and asks for
 * none of the photo sources: WebKit opens Files straight away.
 */
export const APPLE_TOUCH_ANY_FILE_ACCEPT = 'application/octet-stream';

/**
 * A file input's `accept`, or every file on an Apple touch device. The iOS
 * Files picker greys out every file whose type it cannot match to the list,
 * and it knows no type for `.step`, `.openzcad` or `.shapr`, so those could
 * not be chosen at all. Every import checks the format after picking anyway.
 */
export function fileAccept(
  accept: string,
  nav: NavigatorLike = navigator
): string {
  return isAppleTouchDevice(nav) ? APPLE_TOUCH_ANY_FILE_ACCEPT : accept;
}

/**
 * The single-file formats Import CAD files reads, in the order the menu names
 * them. The picker's `accept` and the visible hints are both derived from
 * this, so a format the picker takes cannot drop out of the menu's list: IGES
 * was accepted for months while the File menu still listed only STEP, the
 * meshes and DXF (#2381).
 */
export const CAD_IMPORT_FORMATS: readonly {
  label: string;
  extensions: readonly string[];
}[] = [
  { label: 'STEP', extensions: ['.step', '.stp'] },
  { label: 'IGES', extensions: ['.igs', '.iges'] },
  { label: 'STL', extensions: ['.stl'] },
  { label: '3MF', extensions: ['.3mf'] },
  { label: 'OBJ', extensions: ['.obj'] },
  { label: 'GLB', extensions: ['.glb'] },
  { label: 'PLY', extensions: ['.ply'] },
  { label: 'DXF', extensions: ['.dxf'] }
];

/** Every CAD format the import picker offers, the Shapr3D pair's half too. */
export const CAD_IMPORT_ACCEPT = [
  '.shapr',
  ...CAD_IMPORT_FORMATS.flatMap((format) => format.extensions)
].join(',');

/** The menu's one-line format list: "STEP · IGES · STL · …". */
export const CAD_IMPORT_FORMAT_LINE = CAD_IMPORT_FORMATS.map(
  (format) => format.label
).join(' · ');

const MESH_IMPORT_LABELS = ['STL', '3MF', 'OBJ', 'GLB', 'PLY'];

/**
 * The import action's tooltip, naming the same formats. IGES is qualified:
 * only its exact B-rep solids import; a surface model is refused by name.
 */
export function cadImportTitle(options: { shaprPair: boolean }): string {
  const meshes = CAD_IMPORT_FORMATS.filter((format) =>
    MESH_IMPORT_LABELS.includes(format.label)
  ).map((format) => format.label);
  return (
    `Import STEP, IGES (exact B-rep solids), a mesh file (${meshes.join(', ')}), ` +
    (options.shaprPair
      ? 'a DXF drawing as a sketch, or a paired Shapr3D project and STEP'
      : 'or a DXF drawing')
  );
}

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
