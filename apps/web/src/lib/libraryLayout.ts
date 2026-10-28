/** Counts reserve the last library's shape; no names, IDs or documents. */
export interface LibraryLayout {
  all: number;
  pinned: number;
  attention: number;
  local: number;
  /** Tile positions needing a recovery-copy footer, in grouped order. */
  footers: number[];
}

const STORAGE_KEY = 'openzcad.library.layout.v1';
const isCount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 5000;

export function readLibraryLayout(): LibraryLayout | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? 'null'
    );
    if (!value || typeof value !== 'object') return null;
    const { all, pinned, attention, local, footers } = value as Record<
      string,
      unknown
    >;
    if (
      !isCount(all) ||
      !isCount(pinned) ||
      !isCount(attention) ||
      !isCount(local) ||
      pinned > all ||
      attention > all ||
      local > all ||
      !Array.isArray(footers) ||
      footers.length > all ||
      !footers.every((index: unknown) => isCount(index) && index < all)
    )
      return null;
    return { all, pinned, attention, local, footers: footers as number[] };
  } catch {
    return null;
  }
}

export function saveLibraryLayout(layout: LibraryLayout) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage is optional. First visits use the ordinary placeholder layout.
  }
}
