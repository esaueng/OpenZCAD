import { useEffect, useState } from 'react';

interface LoadableSurface {
  isLoaded(): boolean;
  preload(): Promise<void>;
}

/**
 * Whether a surface the user asked for can show yet: its chunk has loaded, or
 * the load failed and the surface's own render should report that. Until
 * then the caller keeps the surface off screen, so an open that beats the
 * idle warm-up shows the whole surface a moment later rather than an empty
 * frame now.
 */
export function useSurfaceReady(
  surface: LoadableSurface,
  wanted: boolean
): boolean {
  const [, setSettled] = useState(0);
  const [failed, setFailed] = useState(false);
  const loaded = surface.isLoaded();
  useEffect(() => {
    if (!wanted || loaded) return;
    let live = true;
    surface.preload().then(
      () => {
        if (live) setSettled((count) => count + 1);
      },
      () => {
        if (live) setFailed(true);
      }
    );
    return () => {
      live = false;
    };
  }, [surface, wanted, loaded]);
  return loaded || failed;
}
