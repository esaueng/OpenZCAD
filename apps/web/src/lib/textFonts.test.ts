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
import {
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  documentFontsArrived,
  loadTextFont,
  loadedFontStyle
} from './textFonts';

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
const unreachable = new Set<string>();
const stalled = new Set<string>();
vi.stubGlobal('fetch', async (input: string | URL) => {
  const file = String(input).split('/').pop()!;
  fetched.push(file);
  if (unreachable.has(file)) throw new TypeError('Failed to fetch');
  if (stalled.has(file)) return new Promise<Response>(() => undefined);
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

  /** A sketch with one text object per named family, regular style. */
  function textDocument(...families: string[]) {
    return addSketchFeature(
      createProjectDocument('Late faces', toUserId('user')),
      {
        name: 'Label',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: families.map((fontFamily, index) => ({
          objectKind: 'text' as const,
          text: 'Late',
          fontFamily,
          fontStyle: 'regular' as const,
          size: 10,
          x: 0,
          y: index * 20
        }))
      }
    ).document;
  }

  it('reports a late face only once it has actually loaded', async () => {
    const document = textDocument('lora');
    // A face that cannot load is no reason for the worker to rebuild.
    unreachable.add('lora-regular.ttf');
    expect(await documentFontsArrived(document)).toBe(false);
    unreachable.clear();
    expect(await documentFontsArrived(document)).toBe(true);
    // Nothing is missing any more, so nothing new can arrive.
    expect(await documentFontsArrived(document)).toBe(false);
  });

  it('reports the first missing face to land without waiting on a stalled one', async () => {
    // Text drawn with the face that loads is buildable now, whatever the
    // stalled face does; the rebuild this triggers watches it again.
    stalled.add('oswald-regular.ttf');
    await expect(
      documentFontsArrived(textDocument('oswald', 'roboto-slab'))
    ).resolves.toBe(true);
  });

  it('does not count a failed face as arrived while another is stalled', async () => {
    unreachable.add('jetbrains-mono-regular.ttf');
    const outcome = await Promise.race([
      documentFontsArrived(textDocument('oswald', 'jetbrains-mono')),
      new Promise((resolve) => setTimeout(resolve, 50, 'still waiting'))
    ]);
    expect(outcome).toBe('still waiting');
    unreachable.clear();
  });

  it('loads the font parser afresh after its chunk failed to load', async () => {
    vi.resetModules();
    let attempts = 0;
    vi.doMock('@openzcad/geometry/text-loader', () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('Failed to fetch dynamically imported module');
      }
      return {
        FontLibrary: class {
          peek() {
            return undefined;
          }
        },
        fetchFontDataSource: () => async () => new Uint8Array()
      };
    });
    try {
      const fresh = await import('./textFonts');
      await expect(fresh.installTextFontProvider()).rejects.toThrow(
        /Failed to fetch|error when mocking/
      );
      // The chunk is reachable again; a memoized rejection would leave text
      // unbuildable for the worker's life, whatever recovery re-ran.
      await expect(fresh.installTextFontProvider()).resolves.toBeUndefined();
      expect(attempts).toBe(2);
    } finally {
      vi.doUnmock('@openzcad/geometry/text-loader');
      vi.resetModules();
    }
  });

  it.each(['resolve', 'reject'] as const)(
    'retries a stalled parser import and ignores its late %s',
    async (lateOutcome) => {
      vi.useFakeTimers();
      vi.resetModules();
      let release!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const held = new Promise((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
      const created = vi.fn();
      const module = {
        FontLibrary: class {
          constructor() {
            created();
          }
          peek() {
            return undefined;
          }
        },
        fetchFontDataSource: () => async () => new Uint8Array()
      };
      vi.doMock('@openzcad/geometry/text-loader', () => held);
      try {
        const fresh = await import('./textFonts');
        let failure: unknown;
        void fresh.installTextFontProvider().catch((error: unknown) => {
          failure = error;
        });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/timed out/i);
        expect(created).not.toHaveBeenCalled();

        // Production retries use a fresh query URL. Release the mock module
        // map here while retaining this textFonts instance and its memo.
        vi.doUnmock('@openzcad/geometry/text-loader');
        vi.resetModules();
        const fetchedBefore = fetched.filter(
          (file) => file === 'lora-regular.ttf'
        ).length;
        await fresh.loadTextFont('lora', 'regular');
        expect(
          fetched.filter((file) => file === 'lora-regular.ttf')
        ).toHaveLength(fetchedBefore + 1);
        if (lateOutcome === 'resolve') release(module);
        else reject(new Error('The old parser request failed late.'));
        await vi.advanceTimersByTimeAsync(0);
        await fresh.loadTextFont('lora', 'regular');
        expect(created).not.toHaveBeenCalled();
        expect(
          fetched.filter((file) => file === 'lora-regular.ttf')
        ).toHaveLength(fetchedBefore + 1);
      } finally {
        release(module);
        vi.useRealTimers();
        vi.doUnmock('@openzcad/geometry/text-loader');
        vi.resetModules();
      }
    }
  );
});
