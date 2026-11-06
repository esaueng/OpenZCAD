type Point = Readonly<{ x: number; y: number }>;

/** Proper crossings of non-adjacent chords, with a closed-interval x sweep. */
export function densePolylineCrosses(points: readonly Point[]): boolean {
  const chords = points
    .slice(1)
    .map((point, index) => ({
      index,
      minX: Math.min(points[index]!.x, point.x),
      maxX: Math.max(points[index]!.x, point.x),
      minY: Math.min(points[index]!.y, point.y),
      maxY: Math.max(points[index]!.y, point.y)
    }))
    .sort((a, b) => a.minX - b.minX || a.index - b.index);
  for (let a = 0; a < chords.length; a += 1) {
    const left = chords[a]!;
    for (let b = a + 1; b < chords.length; b += 1) {
      const right = chords[b]!;
      // Sorted lower bounds prove every remaining interval is disjoint too.
      if (right.minX > left.maxX) break;
      const i = Math.min(left.index, right.index);
      const j = Math.max(left.index, right.index);
      if (j < i + 2 || left.maxY < right.minY || right.maxY < left.minY)
        continue;
      // Keep the original chord order and arithmetic, including strict
      // interior parameters. Sweep order must not change floating-point votes.
      const a0 = points[i]!;
      const a1 = points[i + 1]!;
      const b0 = points[j]!;
      const b1 = points[j + 1]!;
      const d = (a1.x - a0.x) * (b1.y - b0.y) - (a1.y - a0.y) * (b1.x - b0.x);
      if (d === 0) continue;
      const r =
        ((b0.x - a0.x) * (b1.y - b0.y) - (b0.y - a0.y) * (b1.x - b0.x)) / d;
      const q =
        ((b0.x - a0.x) * (a1.y - a0.y) - (b0.y - a0.y) * (a1.x - a0.x)) / d;
      if (r > 0 && r < 1 && q > 0 && q < 1) return true;
    }
  }
  return false;
}
