/**
 * Whether the viewport should cut rather than ease: the in-app Reduce motion
 * setting, or the OS-level preference. The stylesheet already honours both
 * (`data-reduced-motion` and the media query collapse every CSS animation);
 * the camera glides, sketch fades and inference animation are scripted, and
 * read only the in-app setting, which defaults off, so an OS preference left
 * them running.
 *
 * One shared query object: its `matches` is live, and the render loop asks
 * every frame, so it is not rebuilt per call.
 */
let query: MediaQueryList | null | undefined;

export function reducesMotion(setting: boolean | undefined): boolean {
  if (setting === true) {
    return true;
  }
  if (query === undefined) {
    query =
      typeof globalThis.matchMedia === 'function'
        ? globalThis.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
  }
  return query?.matches === true;
}
