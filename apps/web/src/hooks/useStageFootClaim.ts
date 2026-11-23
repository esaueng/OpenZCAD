import { useLayoutEffect, useRef, type RefObject } from 'react';

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
 * enters with a short rise, so it measures again when that ends. It also
 * measures again when the stage's own style changes: the stylesheet moves
 * the guide above an in-place command's bar by the height the bar publishes
 * there, which moves it without resizing it (#1947).
 *
 * `onGrow` hears each time the claim reaches higher than it did (from
 * nothing when the surface comes up), with where the surface and the stage
 * stand then: a surface that rises over the model can ask for it to be
 * framed clear again.
 */
export function useStageFootClaim(
  ref: RefObject<HTMLElement | null>,
  property: StageFootClaim,
  active: boolean,
  onGrow?: (surface: DOMRect, stage: DOMRect) => void
) {
  const onGrowRef = useRef(onGrow);
  onGrowRef.current = onGrow;
  useLayoutEffect(() => {
    const surface = ref.current;
    const stage = surface?.closest<HTMLElement>('.viewer-area');
    if (!active || !surface || !stage) return;
    let reached = 0;
    const measure = () => {
      const stageRect = stage.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const height = stageFootClaim(stageRect, surfaceRect);
      const claim = `${height}px`;
      // Unchanged, left alone: the write would wake the style observer below.
      if (stage.style.getPropertyValue(property) !== claim) {
        stage.style.setProperty(property, claim);
      }
      if (height > reached) onGrowRef.current?.(surfaceRect, stageRect);
      reached = height;
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(surface);
    observer?.observe(stage);
    const restyled =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(measure);
    restyled?.observe(stage, { attributes: true, attributeFilter: ['style'] });
    surface.addEventListener('animationend', measure);
    surface.addEventListener('transitionend', measure);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      restyled?.disconnect();
      surface.removeEventListener('animationend', measure);
      surface.removeEventListener('transitionend', measure);
      window.removeEventListener('resize', measure);
      stage.style.removeProperty(property);
    };
  }, [ref, property, active]);
}
