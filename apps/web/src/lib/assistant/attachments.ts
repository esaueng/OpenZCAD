/**
 * Turning a file the user dropped into images the model can read.
 *
 * Two rules drive the shape of this module. Drawings are rasterized in the
 * browser — including PDFs — so the worker only ever handles a short image
 * allowlist and the user sees the exact pixels the model will see. And the long
 * edge is kept large, because the thing being read is dimension text: downscale
 * a drawing to a chat-sized thumbnail and "⌀12" becomes unreadable.
 */
import {
  MAX_ASSISTANT_ATTACHMENTS,
  MAX_ASSISTANT_ATTACHMENT_BYTES,
  type AssistantAttachmentMediaType
} from '@openzcad/ai-contracts';
import type { AssistantAttachmentPreview } from './conversation';
import { PDFJS_ASSET_BASE } from './pdfjsAssets';

/** Long-edge pixels kept for a drawing. Below ~1600 dimension text degrades. */
export const ATTACHMENT_MAX_EDGE = 2048;
/** Rasterization target for a PDF page, before the long-edge clamp. */
const PDF_RENDER_SCALE = 2.4;
const JPEG_QUALITY = 0.92;
let pdfWorkerPortPromise: Promise<Worker> | null = null;

export const ACCEPTED_ATTACHMENT_TYPES =
  'image/png,image/jpeg,image/webp,application/pdf';

export class AttachmentError extends Error {}

/** How long a single PDF stage may take before it is called a failure. */
const PDF_STAGE_TIMEOUT_MS = 20_000;

/**
 * Bounds a pdf.js stage. Without this, a worker that cannot start leaves the
 * promise pending and the user sees a paperclip that silently did nothing —
 * strictly worse than an error they can act on.
 */
async function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AttachmentError(message)),
          PDF_STAGE_TIMEOUT_MS
        );
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** Scale factor that brings the long edge down to the cap, never up. */
export function fitScale(
  width: number,
  height: number,
  maxEdge = ATTACHMENT_MAX_EDGE
): number {
  const longest = Math.max(width, height);
  return longest > maxEdge ? maxEdge / longest : 1;
}

/**
 * PNG keeps line art crisp but a photographed drawing can be enormous, so fall
 * back to JPEG when the lossless encoding would blow the per-image budget.
 */
async function encode(canvas: HTMLCanvasElement): Promise<{
  mediaType: AssistantAttachmentMediaType;
  dataBase64: string;
}> {
  for (const [mediaType, quality] of [
    ['image/png', undefined],
    ['image/jpeg', JPEG_QUALITY]
  ] as const) {
    const dataUrl = canvas.toDataURL(mediaType, quality);
    const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if ((dataBase64.length / 4) * 3 <= MAX_ASSISTANT_ATTACHMENT_BYTES) {
      return { mediaType, dataBase64 };
    }
  }
  throw new AttachmentError(
    'That drawing is too large even re-encoded. Crop it or reduce its resolution.'
  );
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new AttachmentError(`${file.name} could not be decoded.`));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fromImageFile(
  file: File,
  id: string
): Promise<AssistantAttachmentPreview[]> {
  const image = await loadImage(file);
  const scale = fitScale(image.naturalWidth, image.naturalHeight);
  const canvas = canvasOf(image.naturalWidth * scale, image.naturalHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new AttachmentError('This browser cannot process images.');
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const encoded = await encode(canvas);
  return [{ id, label: file.name, ...encoded }];
}

function sharedPdfWorkerPort(): Promise<Worker> {
  pdfWorkerPortPromise ??= import(
    'pdfjs-dist/build/pdf.worker.min.mjs?worker'
  ).then(({ default: PdfWorker }) => new PdfWorker());
  return pdfWorkerPortPromise;
}

async function fromPdfFile(
  file: File,
  id: string,
  pageBudget: number
): Promise<AssistantAttachmentPreview[]> {
  // Loaded on demand: a text-only conversation should never pay for the PDF
  // engine, which dwarfs the rest of this bundle.
  const pdfjs = await import('pdfjs-dist');
  // Hand pdf.js a live port from a bundler-built worker rather than a URL it has
  // to instantiate itself; a `workerSrc` URL it cannot start leaves rendering
  // pending forever instead of failing.
  pdfjs.GlobalWorkerOptions.workerPort = await sharedPdfWorkerPort();

  const data = new Uint8Array(await file.arrayBuffer());
  const loading = pdfjs.getDocument({
    data,
    // Served by the `openzcad-pdfjs-assets` Vite plugin. `standardFontDataUrl`
    // is not optional: a sheet using Helvetica renders forever without it.
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    wasmUrl: `${PDFJS_ASSET_BASE}wasm/`
  });
  const pdf = await withTimeout(
    loading.promise,
    `${file.name} could not be opened as a PDF.`
  );
  try {
    const pages = Math.min(pdf.numPages, Math.max(1, pageBudget));
    const rendered: AssistantAttachmentPreview[] = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: PDF_RENDER_SCALE });
      const viewport = page.getViewport({
        scale: PDF_RENDER_SCALE * fitScale(base.width, base.height)
      });
      const canvas = canvasOf(viewport.width, viewport.height);
      const context = canvas.getContext('2d');
      if (!context) {
        throw new AttachmentError('This browser cannot render PDF pages.');
      }
      // Drawings are line art on white; without this the transparent areas
      // encode as black and the dimensions disappear.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      // pdf.js takes `canvas` OR `canvasContext` — supplying both is the
      // documented conflicting case and never resolves.
      //
      // `intent: 'print'` matters more than it looks. The default display intent
      // drives pdf.js's paint loop with requestAnimationFrame, which a browser
      // stops entirely in a hidden tab — so a user who attached a drawing and
      // switched away would come back to nothing. Print intent uses a microtask
      // loop, and is the right intent for an offscreen raster anyway.
      await withTimeout(
        page.render({ canvas, viewport, intent: 'print' }).promise,
        `Page ${pageNumber} of ${file.name} could not be rendered.`
      );
      rendered.push({
        id: `${id}_p${pageNumber}`,
        label:
          pdf.numPages > 1
            ? `${file.name} page ${pageNumber}`
            : file.name,
        ...(await encode(canvas))
      });
    }
    if (pdf.numPages > pages) {
      throw new AttachmentError(
        `${file.name} has ${pdf.numPages} pages; only the first ${pages} fit in one request. Split it or attach the sheet you need.`
      );
    }
    return rendered;
  } finally {
    // The shared external worker stays alive; this releases only the document.
    await loading.destroy();
  }
}

/**
 * Converts one dropped file into attachments. A PDF becomes one attachment per
 * page, which is why this returns a list.
 */
export async function attachmentsFromFile(
  file: File,
  id: string,
  remainingSlots = MAX_ASSISTANT_ATTACHMENTS
): Promise<AssistantAttachmentPreview[]> {
  if (remainingSlots <= 0) {
    throw new AttachmentError(
      `A request carries at most ${MAX_ASSISTANT_ATTACHMENTS} drawings.`
    );
  }
  if (file.type === 'application/pdf') {
    return fromPdfFile(file, id, remainingSlots);
  }
  if (file.type.startsWith('image/')) {
    return fromImageFile(file, id);
  }
  throw new AttachmentError(
    `${file.name || 'That file'} is not a drawing. Attach a PNG, JPEG, WebP, or PDF.`
  );
}

export function attachmentDataUrl(
  attachment: AssistantAttachmentPreview
): string {
  return `data:${attachment.mediaType};base64,${attachment.dataBase64}`;
}
