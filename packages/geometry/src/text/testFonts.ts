/**
 * Shared test fixtures for the text module. Node-only (it reads the bundled
 * asset directory), so it is not exported from the package index.
 */
import { FontLibrary } from './loader';
import { nodeFontDataSource } from './nodeFontSource';
import type { LoadedFont } from './loader';
import type { FontStyle, TextLoop, TextPoint, TextRegion } from './types';

const library = new FontLibrary(nodeFontDataSource());

export function loadTestFont(
  familyOrId: string,
  style: FontStyle = 'regular'
): Promise<LoadedFont> {
  return library.load(familyOrId, style);
}

/** Every family id in the bundled set, in registry order. */
export const TEST_FAMILY_IDS = [
  'inter',
  'open-sans',
  'lora',
  'roboto-slab',
  'jetbrains-mono',
  'oswald',
  'pacifico'
] as const;

export function loopStart(loop: TextLoop): TextPoint {
  const first = loop.segments[0];
  if (!first) {
    throw new Error('loop has no segments');
  }
  return first.a;
}

export function loopEnd(loop: TextLoop): TextPoint {
  const last = loop.segments[loop.segments.length - 1];
  if (!last) {
    throw new Error('loop has no segments');
  }
  return last.b;
}

export function allLoops(region: TextRegion): TextLoop[] {
  return [region.outer, ...region.holes];
}

/**
 * Shoelace area of a loop's control polygon endpoints — an independent check
 * on the exact Green's-theorem area's *sign*, computed a different way.
 */
export function endpointShoelace(loop: TextLoop): number {
  let twice = 0;
  for (const segment of loop.segments) {
    twice += segment.a.x * segment.b.y - segment.b.x * segment.a.y;
  }
  return twice / 2;
}
