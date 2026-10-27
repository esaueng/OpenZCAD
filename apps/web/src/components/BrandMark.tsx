import prismFold from '../assets/prism-fold.json';

/**
 * Prism Fold: flat colored planes carry the depth, without strokes or effects.
 * The continuous silhouette under the faces prevents antialiasing hairlines.
 * `compact` trims the padding below 24px; the geometry stays the same.
 * Regenerate exported icons with `pnpm brand:generate` after editing the source.
 */
export function BrandMark({
  compact = false,
  monochrome = false
}: {
  compact?: boolean;
  monochrome?: boolean;
}) {
  const colors: Record<string, string> = prismFold.colors;
  return (
    <svg
      viewBox={compact ? prismFold.compactViewBox : prismFold.viewBox}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={prismFold.silhouette}
        fill={monochrome ? 'currentColor' : colors.front}
      />
      {!monochrome &&
        prismFold.faces.map((face) => (
          <path key={face.name} d={face.d} fill={colors[face.tone]} />
        ))}
    </svg>
  );
}
