import * as THREE from 'three';
import { createFatLine } from '@openzcad/viewport';

/** CSS pixels, independent of zoom and display density. */
export const SKETCH_CURVE_WIDTH = 2.2;

/** Sketch state colours must not wash out under the solid's tone mapping. */
export function createSketchCurve(
  points: THREE.Vector3[],
  options: Parameters<typeof createFatLine>[1]
) {
  const line = createFatLine(points, options);
  line.material.toneMapped = false;
  return line;
}
