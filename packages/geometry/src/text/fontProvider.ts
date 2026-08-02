/**
 * The synchronous font seam.
 *
 * `computeSketchProfileAnalysis` is synchronous and pure — it runs on the UI
 * thread and in the worker on every edit — while font bytes arrive over
 * `fetch` or the filesystem. Something has to bridge that, and threading an
 * async loader through every analysis caller would make the whole sketch
 * pipeline async for one object kind.
 *
 * So the host installs a resolver that answers from already-parsed faces and
 * never blocks. `FontLibrary.peek` is exactly that shape. Loading stays the
 * host's job: preload the faces a document needs, then rebuild.
 *
 * A miss is not a silent failure — the text fast path turns it into a
 * `SketchProfileDiagnostic`, and the extrude that consumes the text fails
 * closed with that diagnostic's message attached.
 */
import type { LoadedFont } from './loader';
import type { FontStyle } from './types';

/** Answers with an already-parsed face, or `undefined`. Must not block. */
export type TextFontProvider = (
  familyOrId: string,
  style: FontStyle
) => LoadedFont | undefined;

let provider: TextFontProvider | null = null;

/** Installs the resolver used by the text fast path. `null` uninstalls it. */
export function setTextFontProvider(next: TextFontProvider | null): void {
  provider = next;
}

export function textFontProvider(): TextFontProvider | null {
  return provider;
}
