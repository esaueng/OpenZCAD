import type { ReactNode } from 'react';

interface StableLabelProps {
  children: ReactNode;
  /**
   * Every label this slot can show. The slot reserves the width of the
   * longest one, so a control whose label swaps with state ("Saving" →
   * "Saved", "Ready" → "Dragging") never changes size and never shoves its
   * neighbours mid-cycle.
   */
  reserve: readonly string[];
  align?: 'start' | 'center';
}

/**
 * The reservation is a `::after` pseudo-element reading `data-reserve`, not a
 * hidden sibling: the element's text content and accessible name stay exactly
 * the visible label, so `getByRole(…, { name })` and `toHaveText` keep
 * working and screen readers never hear the ghost.
 */
export function StableLabel({
  children,
  reserve,
  align = 'start'
}: StableLabelProps) {
  const widest = reserve.reduce(
    (best, candidate) => (candidate.length > best.length ? candidate : best),
    ''
  );
  return (
    <span
      className={`stable-label${align === 'center' ? ' stable-label-center' : ''}`}
      data-reserve={widest}
    >
      <span className="stable-label-text">{children}</span>
    </span>
  );
}
