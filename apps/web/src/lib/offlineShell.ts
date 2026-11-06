import { isStandaloneApp } from './appleTouch';

/**
 * Registers the offline shell (public/sw.js) for an installed app: a Home
 * Screen app on an iPad has no address bar to reload from, and should open
 * the last version it ran when the network is gone. A browser tab, the
 * desktop shell and test builds never register it.
 */
export function registerOfflineShell(win: Window = window): void {
  if (import.meta.env.DEV || import.meta.env.VITE_E2E === '1') return;
  // The desktop shell's own marker, read here rather than through
  // desktopBridge: this runs from the entry, which must not pull that
  // module (and the shared package behind it) into the first load.
  if ('__TAURI_INTERNALS__' in win || !isStandaloneApp(win)) return;
  const workers = win.navigator.serviceWorker as
    ServiceWorkerContainer | undefined;
  if (!workers) return;
  workers.register('/sw.js', { scope: '/' }).catch(() => {
    // Offline launch is a convenience; a refused registration loses nothing.
  });
}
