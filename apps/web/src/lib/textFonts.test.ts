/**
 * A style a family does not ship falls back down the registry's chain in the
 * geometry path, so the loader must load that fallback face — otherwise the
 * text card's outline (and the document's text) draws nothing at all.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { textDisplayLoops } from '@openzcad/geometry';
import { loadTextFont, loadedFontStyle } from './textFonts';

/** The bundled faces on disk, found from wherever the runner started. */
function fontDirectory(): string {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'packages/geometry/assets/fonts');
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) throw new Error('font assets not found');
  }
}
const FONT_DIR = fontDirectory();

const fetched: string[] = [];
vi.stubGlobal('fetch', async (input: string | URL) => {
  const file = String(input).split('/').pop()!;
  fetched.push(file);
  const bytes = await readFile(path.join(FONT_DIR, file));
  return new Response(bytes);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('text font loading', () => {
  it('resolves a style the family does not ship to the face it falls back to', () => {
    expect(loadedFontStyle('pacifico', 'bold')).toBe('regular');
    expect(loadedFontStyle('oswald', 'italic')).toBe('regular');
    expect(loadedFontStyle('roboto-slab', 'boldItalic')).toBe('bold');
    expect(loadedFontStyle('open-sans', 'bold')).toBe('bold');
  });

  it('loads the regular face for Pacifico bold, and the outline draws', async () => {
    const request = {
      text: 'Boa',
      fontFamily: 'pacifico',
      fontStyle: 'bold' as const,
      size: 10,
      x: 0,
      y: 0,
      rotationDeg: 0
    };
    await loadTextFont('pacifico', 'bold');
    expect(fetched).toContain('pacifico-regular.ttf');
    expect(fetched.some((file) => file.includes('bold'))).toBe(false);
    const loops = textDisplayLoops(request);
    expect(loops?.length ?? 0).toBeGreaterThan(0);
  });
});
