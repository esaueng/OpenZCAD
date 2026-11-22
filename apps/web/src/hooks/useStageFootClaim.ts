import { useLayoutEffect, type RefObject } from 'react';

/**
 * The stage's foot claims: a task surface anchored to the foot of the stage
 * (the modeling guide's card, Assemble's animation timeline) publishes how
 * far up from the stage's bottom edge it reaches, and `--stage-foot-claim`
 * (quiet-stage.css) is the highest of them. Where a floating panel shares
 * that foot with it — the one panel a phone shows, Assemble's sidebar on a
 * narrow stage — the panel ends above the claim instead of standing over
 * the surface's controls (design review 16 Nov 2026, UX-001 and UX-003).
 */
export type StageFootClaim =
  '--workspace-tour-claim' | '--motion-timeline-claim';

/** CSS px from the stage's bottom edge up to the surface's top edge. */
export function stageFootClaim(
  stage: Pick<DOMRectReadOnly, 'bottom'>,
  surface: Pick<DOMRectReadOnly, 'top' | 'height'>
): number {
  if (surface.height <= 0) return 0;
  return Math.max(0, Math.ceil(stage.bottom - surface.top));
}

/**
 * Publishes `property` on the enclosing `.viewer-area` while `active`, and
 * keeps it current as the surface or the stage changes size. The card
 * enters with a short rise, so it measures again when that ends. A surface
 * the stylesheet moves without resizing it (the guide lifted over an
 * in-place command's bar) names the cause in `remeasure`.
 */
export function useStageFootClaim(
  ref: RefObject<HTMLElement | null>,
  property: StageFootClaim,
  active: boolean,
  remeasure?: unknown
) {
  useLayoutEffect(() => {
    const surface = ref.current;
    const stage = surface?.closest<HTMLElement>('.viewer-area');
    if (!active || !surface || !stage) return;
    const measure = () => {
      stage.style.setProperty(
        property,
        `${stageFootClaim(
          stage.getBoundingClientRect(),
          surface.getBoundingClientRect()
        )}px`
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(surface);
    observer?.observe(stage);
    surface.addEventListener('animationend', measure);
    surface.addEventListener('transitionend', measure);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      surface.removeEventListener('animationend', measure);
      surface.removeEventListener('transitionend', measure);
      window.removeEventListener('resize', measure);
      stage.style.removeProperty(property);
    };
  }, [ref, property, active, remeasure]);
}
