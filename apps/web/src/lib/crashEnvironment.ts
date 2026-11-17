import { APP_BUILD } from './appBuild';
import { KERNEL_BUILD } from './kernelBuild';

/**
 * Which build and browser a report comes from. Read only by what loads after
 * startup (the page-load line, a crash card's Copy details), so it stays out
 * of the entry chunk.
 */

/** The app commit this bundle was built from (`unknown` outside Vite). */
export const APP_BUILD_COMMIT: string = APP_BUILD.sourceCommit;

/** The build line every report and the session entry share. */
export function buildDescription(): string {
  return `OpenZCAD ${APP_BUILD.version} (${APP_BUILD_COMMIT.slice(0, 12)}) · Remus ${KERNEL_BUILD.packageVersion} (${KERNEL_BUILD.sourceCommit.slice(0, 12)})`;
}

export interface EnvironmentSource {
  navigator?: Pick<
    Navigator,
    'userAgent' | 'hardwareConcurrency' | 'language'
  > & {
    deviceMemory?: number;
  };
  innerWidth?: number;
  innerHeight?: number;
  devicePixelRatio?: number;
}

/**
 * The browser and window a report came from: enough to tell a Firefox-only
 * or a high-DPI-only failure apart, nothing that names the user.
 */
export function environmentDescription(
  source: EnvironmentSource = globalThis
): string[] {
  const lines: string[] = [];
  const nav = source.navigator;
  if (nav?.userAgent) lines.push(`Browser ${nav.userAgent}`);
  if (source.innerWidth && source.innerHeight) {
    lines.push(
      `Window ${source.innerWidth}×${source.innerHeight} @${source.devicePixelRatio ?? 1}x`
    );
  }
  const hardware = [
    nav?.hardwareConcurrency ? `${nav.hardwareConcurrency} cores` : null,
    nav?.deviceMemory ? `${nav.deviceMemory} GB memory` : null
  ].filter(Boolean);
  if (hardware.length > 0) lines.push(`Device ${hardware.join(', ')}`);
  return lines;
}
