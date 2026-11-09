/**
 * Binary (1024-based) sizes, matching storage limits. Account uses the app's
 * short KB/MB/GB labels; existing explicit IEC labels remain available.
 * Shared with Project properties so precision and unit selection stay aligned.
 */
export function formatBytes(
  bytes: number,
  unitStyle: 'short' | 'iec' = 'short'
): string {
  const units =
    unitStyle === 'iec'
      ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
      : ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  // Rounding near a boundary must not leave a label such as "1,024 MB".
  if (Math.round(value * 10) / 10 >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}
