import { useLayoutEffect, type RefObject } from 'react';

/**
 * How far an on-screen keyboard reaches up from the bottom of the layout
 * viewport, in CSS pixels. Browsers that resize only the visual viewport for
 * the keyboard (iOS Safari, Android Chrome since 108) leave `100dvh` and
 * `innerHeight` alone, so a full-height surface would sit behind it. Zero
 * without the Visual Viewport API.
 */
export function keyboardInset(): number {
  const visual = window.visualViewport;
  if (!visual) return 0;
  return Math.max(0, window.innerHeight - visual.height - visual.offsetTop);
}

/**
 * Keeps `--keyboard-inset` on `element` equal to {@link keyboardInset} as the
 * visual viewport changes, calling `onChange` after each update. Returns the
 * cleanup, which stops watching and removes the property.
 */
export function watchKeyboardInset(
  element: HTMLElement,
  onChange?: () => void
): () => void {
  const visual = window.visualViewport;
  const update = () => {
    element.style.setProperty(
      '--keyboard-inset',
      `${Math.round(keyboardInset())}px`
    );
  };
  const onResize = () => {
    update();
    onChange?.();
  };
  update();
  visual?.addEventListener('resize', onResize);
  visual?.addEventListener('scroll', onResize);
  return () => {
    visual?.removeEventListener('resize', onResize);
    visual?.removeEventListener('scroll', onResize);
    element.style.removeProperty('--keyboard-inset');
  };
}

/** {@link watchKeyboardInset} for the mounted element behind `ref`. */
export function useKeyboardInset(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    return watchKeyboardInset(element);
  }, [ref]);
}
