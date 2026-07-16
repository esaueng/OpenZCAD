/**
 * Isometric Z-cube mark, drawn inline so it inherits currentColor.
 *
 * Two optical sizes. The default Z spans 5.2 of 24 units, which reads well from
 * ~30 device pixels up but goes soft below that: the diagonal runs out of pixels
 * to travel through. `compact` enlarges the Z and thins the cube so the letter
 * survives small renders — use it wherever the mark is drawn under ~24px CSS.
 * public/favicon.svg carries the compact geometry; update both together.
 */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9L12 2.5Z"
        stroke="currentColor"
        strokeWidth={compact ? 1.6 : 1.5}
        strokeLinejoin="round"
      />
      <path
        d={compact ? 'M7.9 8.4h8.2l-8.2 7.2h8.2' : 'M8.2 9.4h7.6l-7.6 5.2h7.6'}
        stroke="currentColor"
        strokeWidth={compact ? 2.1 : 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
