/**
 * A byte count in binary units, named as such (KiB, MiB, GiB), with at most
 * one decimal, or a dash for a missing value. Settings and Project
 * properties label sizes the same way.
 */
export function formatByteSize(bytes: number): string {
  // A field an older or partial response leaves out must not take the
  // page down with it.
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}
