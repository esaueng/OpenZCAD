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

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled';

/**
 * Saves an export. On a touch screen that can share files (an iPad) it
 * opens the system share sheet, which offers Save to Files, AirDrop and
 * other apps (a slicer, a mail draft); everywhere else, and whenever the
 * sheet is refused (the tap that asked for it has expired, say), it is an
 * ordinary download. Dismissing the sheet saves nothing, as cancelling a
 * save dialog would.
 */
export function saveFile(
  name: string,
  blob: Blob,
  win: Window = window
): Promise<SaveOutcome> {
  const file = shareableFile(name, blob, win);
  if (!file) {
    downloadBlob(name, blob);
    return Promise.resolve('downloaded');
  }
  return win.navigator.share({ files: [file], title: name }).then(
    () => 'shared' as const,
    (error: unknown) => {
      // A DOMException; its name is what says the person dismissed it.
      if ((error as { name?: unknown } | null)?.name === 'AbortError') {
        return 'cancelled' as const;
      }
      downloadBlob(name, blob);
      return 'downloaded' as const;
    }
  );
}

function shareableFile(name: string, blob: Blob, win: Window): File | null {
  if (win.matchMedia?.('(pointer: coarse)').matches !== true) return null;
  const nav = win.navigator;
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') {
    return null;
  }
  const file = new File([blob], name, {
    type: blob.type || 'application/octet-stream'
  });
  try {
    return nav.canShare({ files: [file] }) ? file : null;
  } catch {
    return null;
  }
}
