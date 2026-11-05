/**
 * Saving a file the browser way: an anchor download from a blob URL.
 *
 * The URL outlives the click. WebKit (Safari, every iPad browser) reads the
 * blob after `click()` returns, so revoking it at once could cancel the save;
 * Chromium copes either way. A minute is far longer than any read takes, and
 * the blob is only held that long.
 */
export const DOWNLOAD_URL_LIFETIME_MS = 60_000;

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}
