import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ATTACHMENT_MEDIA_TYPES,
  MAX_ASSISTANT_ATTACHMENTS
} from '@openzcad/ai-contracts';
import {
  ACCEPTED_ATTACHMENT_TYPES,
  ATTACHMENT_MAX_EDGE,
  attachmentDataUrl,
  fitScale
} from '../apps/web/src/lib/assistant/attachments';
import {
  PDFJS_ASSET_BASE,
  PDFJS_ASSET_DIRS
} from '../apps/web/src/lib/assistant/pdfjsAssets';

describe('drawing attachments', () => {
  it('scales a drawing down to the long-edge cap and never up', () => {
    // A drawing is only useful if its dimension text survives; the cap exists to
    // keep that legible, so a small scan must not be enlarged into blur either.
    expect(fitScale(4000, 3000)).toBeCloseTo(ATTACHMENT_MAX_EDGE / 4000, 10);
    expect(fitScale(3000, 4000)).toBeCloseTo(ATTACHMENT_MAX_EDGE / 4000, 10);
    expect(fitScale(1000, 800)).toBe(1);
    expect(fitScale(ATTACHMENT_MAX_EDGE, 100)).toBe(1);

    const scaled = fitScale(5000, 2500);
    expect(Math.round(5000 * scaled)).toBe(ATTACHMENT_MAX_EDGE);
    expect(Math.round(2500 * scaled)).toBe(ATTACHMENT_MAX_EDGE / 2);
  });

  it('keeps dimension text legible by capping well above thumbnail size', () => {
    // Below roughly 1600px on the long edge, a "⌀12" callout stops being
    // readable, which is the whole point of the attachment.
    expect(ATTACHMENT_MAX_EDGE).toBeGreaterThanOrEqual(1600);
  });

  it('accepts exactly the wire media types plus PDF', () => {
    const accepted = ACCEPTED_ATTACHMENT_TYPES.split(',');
    for (const mediaType of ASSISTANT_ATTACHMENT_MEDIA_TYPES) {
      expect(accepted).toContain(mediaType);
    }
    // PDFs are rasterized client-side, so the type is accepted by the picker but
    // is deliberately absent from what the worker will take.
    expect(accepted).toContain('application/pdf');
    expect([...ASSISTANT_ATTACHMENT_MEDIA_TYPES]).not.toContain(
      'application/pdf'
    );
    expect(accepted).toHaveLength(ASSISTANT_ATTACHMENT_MEDIA_TYPES.length + 1);
  });

  it('builds a data URL the worker would also accept', () => {
    const url = attachmentDataUrl({
      id: 'att_1',
      label: 'sheet 1',
      mediaType: 'image/png',
      dataBase64: 'QUJD'
    });
    expect(url).toBe('data:image/png;base64,QUJD');
  });

  it('points pdf.js at the asset directories it actually needs', () => {
    expect(PDFJS_ASSET_BASE.startsWith('/')).toBe(true);
    expect(PDFJS_ASSET_BASE.endsWith('/')).toBe(true);
    // standard_fonts is the load-bearing one: without it a sheet using
    // Helvetica never finishes rendering.
    expect([...PDFJS_ASSET_DIRS]).toContain('standard_fonts');
    expect([...PDFJS_ASSET_DIRS]).toContain('cmaps');
    expect([...PDFJS_ASSET_DIRS]).toContain('wasm');
  });

  it('bounds a single request to a reviewable number of sheets', () => {
    expect(MAX_ASSISTANT_ATTACHMENTS).toBeGreaterThan(1);
    expect(MAX_ASSISTANT_ATTACHMENTS).toBeLessThanOrEqual(8);
  });
});
