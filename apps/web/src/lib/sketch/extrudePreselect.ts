interface Point {
  x: number;
  y: number;
}

/** Even-odd point-in-polygon over a closed polyline (last point not repeated). */
function insidePolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The regions Extrude takes when nothing was picked (I42). Every region
 * used to be taken, so a circle drawn inside a rectangle as a hole was
 * extruded too and filled it. A region that sits in another region's hole
 * is that hole's fill; one nested two holes deep is an island again, as in
 * a washer drawn inside a cut-out. So the regions at an even depth are
 * taken. When that would leave none, every region is.
 */
export function regionsOutsideHoles<
  T extends { samplePoint: Point; holes: readonly (readonly Point[])[] }
>(regions: readonly T[]): T[] {
  const depth = (region: T) =>
    regions.filter(
      (other) =>
        other !== region &&
        other.holes.some((hole) => insidePolygon(region.samplePoint, hole))
    ).length;
  const outside = regions.filter((region) => depth(region) % 2 === 0);
  return outside.length > 0 ? outside : [...regions];
}
