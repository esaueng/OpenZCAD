/** Counts reserve the last library's shape; no names, IDs or documents. */
export interface LibraryLayout {
  all: number;
  pinned: number;
  attention: number;
  local: number;
  /** Tile positions needing a recovery-copy footer, in grouped order. */
  footers: number[];
  /** Physical tiles after folder grouping and filtering, rather than project counts. */
  groups?: Array<{ label: 'Pinned' | 'Projects' | null; count: number }>;
}

const STORAGE_KEY = 'openzcad.library.layout.v1';
const isCount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 5000;

function isGroup(
  value: unknown
): value is NonNullable<LibraryLayout['groups']>[number] {
  if (!value || typeof value !== 'object') return false;
  const group = value as Record<string, unknown>;
  return (
    (group.label === null ||
      group.label === 'Pinned' ||
      group.label === 'Projects') &&
    isCount(group.count)
  );
}

export function readLibraryLayout(): LibraryLayout | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(STORAGE_KEY) ?? 'null'
    );
    if (!value || typeof value !== 'object') return null;
    const { all, pinned, attention, local, footers, groups } = value as Record<
      string,
      unknown
    >;
    const validGroups =
      Array.isArray(groups) && groups.length <= 2 && groups.every(isGroup);
    const tileCount = validGroups
      ? groups.reduce((count, group) => count + group.count, 0)
      : all;
    if (
      !isCount(all) ||
      !isCount(pinned) ||
      !isCount(attention) ||
      !isCount(local) ||
      pinned > all ||
      attention > all ||
      local > all ||
      !Array.isArray(footers) ||
      !isCount(tileCount) ||
      footers.length > tileCount ||
      !footers.every((index: unknown) => isCount(index) && index < tileCount)
    )
      return null;
    return {
      all,
      pinned,
      attention,
      local,
      footers: footers as number[],
      ...(validGroups ? { groups } : {})
    };
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
