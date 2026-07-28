/**
 * Where pdf.js finds the runtime data it fetches while rasterizing a drawing.
 *
 * Shared by `vite.config.ts` — which serves these in dev and copies them into
 * the build — and by the attachment pipeline that passes them to pdf.js. Kept
 * import-free so the Vite config can load it without pulling in app code.
 */
export const PDFJS_ASSET_BASE = '/pdfjs/';

/**
 * `standard_fonts` is not optional: a sheet using a standard font (Helvetica and
 * friends, common in CAD exports) never finishes rendering without it — font
 * loading stalls and `page.render()` simply never resolves. `cmaps` covers CJK
 * text and `wasm` covers JBIG2/JPX images in scanned sheets.
 */
export const PDFJS_ASSET_DIRS = ['standard_fonts', 'cmaps', 'wasm'] as const;
