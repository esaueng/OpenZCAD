/**
 * Browser-side font loading for text sketch objects.
 *
 * The geometry package deliberately owns no platform dependency: it exposes a
 * `FontDataSource` seam for bytes and a synchronous `TextFontProvider` seam for
 * already-parsed faces. This module wires both for the browser.
 *
 * Two threads need it, not one. `computeSketchProfileAnalysis` runs on the UI
 * thread (to draw the sketch) *and* in the geometry worker (to build solids),
 * and a Web Worker has its own module instance — so each side installs its own
 * provider against its own library. That is why this is a module of functions
 * rather than a singleton someone passes around.
 *
 * The provider must not block, so loading is a separate step: call
 * `preloadDocumentFonts` and await it before the analysis runs. A face that has
 * not arrived is not a crash — the text fast path emits a
 * `SketchProfileDiagnostic` and any extrude consuming it fails closed with that
 * message, which is the behaviour we want if a font 404s in production.
 */
import { useEffect, useState } from 'react';
import { setTextFontProvider } from '@openzcad/geometry';
import type { FontStyle } from '@openzcad/geometry';
// Type-only: erased at build time, so it creates no static edge to the parser.
import type { FontLibrary } from '@openzcad/geometry/text-loader';
import type { ProjectDocument } from '@openzcad/shared';

/**
 * Loaded on first use, not at module scope.
 *
 * `FontLibrary` pulls in opentype.js, which is a couple of hundred kilobytes
 * of parser that a document with no text never needs. Importing it eagerly put
 * the main bundle over its size budget, so it is fetched the first time a text
 * object actually appears — which for most sessions is never.
 */
let libraryPromise: Promise<FontLibrary> | null = null;

async function fontLibrary(): Promise<FontLibrary> {
  // The loader is imported by its own path, not through the geometry index:
  // that index is statically imported across the app, so a dynamic import of
  // it cannot move anything into a separate chunk (rollup says so, loudly).
  // `setTextFontProvider` comes from the provider module, which has no
  // opentype dependency and is free to stay in the entry bundle.
  libraryPromise ??= import('@openzcad/geometry/text-loader').then(
    ({ FontLibrary, fetchFontDataSource }) => {
      const created = new FontLibrary(fetchFontDataSource());
      setTextFontProvider((family, style) => created.peek(family, style));
      return created;
    }
  );
  return libraryPromise;
}

/**
 * Installs the synchronous provider for this thread. Idempotent, and safe to
 * call defensively at each entry point rather than coordinating — the install
 * rides along with the one-time library load.
 */
export async function installTextFontProvider(): Promise<void> {
  await fontLibrary();
}

/**
 * The font library's first load fetches a separate parser chunk; on a stalled
 * connection that dynamic import can hang forever, and it runs at the front of
 * every geometry rebuild — a hang here used to wedge the whole worker queue.
 * Text degrades to a per-string diagnostic instead.
 */
const FONT_PRELOAD_BUDGET_MS = 10_000;

/**
 * Loads every face the document's text objects name, so the next analysis can
 * resolve them synchronously.
 *
 * Resolves rather than rejects when a face fails: one unavailable font should
 * degrade that one string into a visible diagnostic, not fail the whole
 * rebuild and take the rest of the model with it.
 */
export async function preloadDocumentFonts(
  document: ProjectDocument
): Promise<void> {
  const wanted = new Map<string, { family: string; style: FontStyle }>();
  for (const node of Object.values(document.nodes)) {
    if (node.kind !== 'sketch-object' || node.data.objectKind !== 'text') {
      continue;
    }
    const family = node.data.fontFamily;
    const style = node.data.fontStyle;
    wanted.set(`${family}|${style}`, { family, style });
  }
  // A document with no text never pays for the font parser at all.
  if (wanted.size === 0) {
    return;
  }
  await Promise.race([
    (async () => {
      const library = await fontLibrary();
      await Promise.all(
        [...wanted.values()].map(async ({ family, style }) =>
          library.load(family, style).catch(() => undefined)
        )
      );
    })(),
    new Promise((resolve) => setTimeout(resolve, FONT_PRELOAD_BUDGET_MS))
  ]).catch(() => undefined);
}

/** Loads one face on demand — for previews in the font picker. */
export async function loadTextFont(
  family: string,
  style: FontStyle
): Promise<void> {
  const library = await fontLibrary();
  await library.load(family, style).catch(() => undefined);
}

/**
 * Keeps the UI thread's faces in step with the document and reports a version
 * that changes when new ones land.
 *
 * The sketch overlay is a `useMemo` over a synchronous analysis, so fonts
 * arriving later would otherwise leave the viewport showing a diagnostic until
 * something unrelated invalidated the memo. Depending on the returned version
 * makes "the font finished loading" an ordinary render trigger.
 */
export function useDocumentFonts(document: ProjectDocument | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!document) {
      return;
    }
    let cancelled = false;
    void preloadDocumentFonts(document).then(() => {
      if (!cancelled) {
        setVersion((current) => current + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [document]);
  return version;
}
