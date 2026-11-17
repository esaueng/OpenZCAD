import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assertStorableDocument,
  createProjectDocument
} from '@openzcad/document-core';
import {
  drawingAnnotationError,
  isDrawingDimension,
  toUserId,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingSheetImage,
  type ProjectDocument
} from '@openzcad/shared';
import {
  composeSheetAnnotations,
  resolveDrawingAnnotation,
  resolveSheetAnnotations,
  sheetPictures,
  type SheetPictureLookup
} from '../apps/web/src/lib/drawing/annotations';
import {
  DEFAULT_DRAWING_IMAGE_WIDTH_MM,
  draftAnnotation,
  applyAnnotationPick,
  startAnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import {
  SheetPictureUnavailableError,
  jpegInfo,
  sheetPageToDxf,
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  jpegExifOrientation,
  loadPagePictures,
  pagePictures,
  pictureDataUrl,
  pictureJpegBytes
} from '../apps/web/src/lib/drawing/sheetPictures';

/**
 * D02 sheet images (schema v92): one of the project's reference images
 * printed on the paper, at a width, keeping its picture's shape; broken by
 * name when the picture is deleted; written into SVG and PDF from the
 * picture's own bytes, and left out of DXF.
 */

const sheetId = 'dsht_images' as DrawingSheetId;
const pictureId = 'rimg_logo';
const checksum = 'a'.repeat(64);

const pictures: SheetPictureLookup = new Map([
  [
    pictureId,
    {
      name: 'Logo',
      checksumSha256: checksum,
      contentType: 'image/jpeg' as const,
      pixelWidth: 400,
      pixelHeight: 200
    }
  ]
]);

function image(extra: Partial<DrawingSheetImage> = {}): DrawingSheetImage {
  return {
    annotationId: 'dann_logo' as DrawingAnnotationId,
    kind: 'image',
    placementMm: { x: 60, y: 40 },
    referenceImageId: pictureId,
    widthMm: 40,
    ...extra
  };
}

function sheetWith(annotations: DrawingSheet['annotations']): DrawingSheet {
  return {
    sheetId,
    name: 'Images',
    paper: { size: 'A4', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'test' },
    views: [],
    ...(annotations ? { annotations } : {})
  };
}

/** The smallest JPEG header `jpegInfo` reads: SOI, APP0, SOF0 and SOS. */
function jpegHeader(width: number, height: number, components = 3) {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    components,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    0xff,
    0xd9
  ]);
}

describe('sheet image annotations', () => {
  it('validates the shape by name', () => {
    const views = new Set<string>();
    expect(drawingAnnotationError(image(), views, 'Image')).toBeNull();
    expect(isDrawingDimension(image())).toBe(false);
    expect(
      drawingAnnotationError(
        image({ referenceImageId: 'logo' }),
        views,
        'Image'
      )
    ).toMatch(/names no reference image/);
    expect(
      drawingAnnotationError(image({ widthMm: 0.5 }), views, 'Image')
    ).toMatch(/mm wide at most/);
    expect(
      drawingAnnotationError(image({ widthMm: 5000 }), views, 'Image')
    ).toMatch(/mm wide at most/);
    expect(
      drawingAnnotationError({ ...image(), decimals: 2 }, views, 'Image')
    ).toMatch(/states no measured value/);
  });

  it('prints its picture at its width, keeping the picture’s shape', () => {
    const resolution = resolveDrawingAnnotation(
      image(),
      undefined,
      {},
      'mm',
      undefined,
      undefined,
      undefined,
      undefined,
      pictures
    );
    expect(resolution).toMatchObject({
      ok: true,
      resolved: { kind: 'image', widthMm: 40, heightMm: 20, name: 'Logo' }
    });
    const sheet = sheetWith([image()]);
    const resolutions = resolveSheetAnnotations(
      sheet,
      {},
      'mm',
      undefined,
      undefined,
      pictures
    );
    const laid = composeSheetAnnotations(sheet, [], resolutions, 'mm');
    // Centred on its placement.
    expect(laid.images).toEqual([
      {
        x: 40,
        y: 30,
        width: 40,
        height: 20,
        checksumSha256: checksum,
        contentType: 'image/jpeg'
      }
    ]);
    expect(laid.boxes.get(image().annotationId)).toEqual({
      x: 40,
      y: 30,
      width: 40,
      height: 20
    });
    const page = composeSheetPage(
      sheet,
      [],
      { projectName: 'Images', units: 'mm' },
      laid
    );
    expect(page.images).toHaveLength(1);
    // A sheet without pictures composes as before: no `images` at all.
    const plain = composeSheetPage(
      sheetWith(undefined),
      [],
      { projectName: 'Images', units: 'mm' },
      { strokes: [], texts: [] }
    );
    expect('images' in plain).toBe(false);
    // One wholly off the paper is not drawn.
    const off = composeSheetPage(
      sheet,
      [],
      { projectName: 'Images', units: 'mm' },
      {
        ...laid,
        images: laid.images.map((entry) => ({ ...entry, x: 900 }))
      }
    );
    expect('images' in off).toBe(false);
  });

  it('breaks by name when its picture is deleted from the project', () => {
    const resolution = resolveDrawingAnnotation(
      image(),
      undefined,
      {},
      'mm',
      undefined,
      undefined,
      undefined,
      undefined,
      new Map()
    );
    expect(resolution).toMatchObject({
      ok: false,
      reason: 'image-missing',
      message:
        'The picture this image showed has been deleted from the project.'
    });
  });

  it('places from its tool with the chosen picture', () => {
    const tool = startAnnotationTool('image');
    const placed = applyAnnotationPick(tool, null, [80, 50], null, {});
    expect(placed.ok).toBe(true);
    const finished = placed.ok ? placed.tool : tool;
    expect(
      draftAnnotation(finished, 'dann_new' as DrawingAnnotationId, {
        x: 80,
        y: 50
      })
    ).toBeNull();
    expect(
      draftAnnotation(
        { ...finished, pictureId },
        'dann_new' as DrawingAnnotationId,
        { x: 80, y: 50 }
      )
    ).toEqual({
      annotationId: 'dann_new',
      placementMm: { x: 80, y: 50 },
      kind: 'image',
      referenceImageId: pictureId,
      widthMm: DEFAULT_DRAWING_IMAGE_WIDTH_MM
    });
  });

  it('reads the project’s pictures from its reference images', () => {
    const document = {
      referenceImages: {
        images: [
          {
            imageId: pictureId,
            name: 'Logo',
            contentType: 'image/png' as const,
            source: { checksumSha256: checksum },
            pixelWidth: 10,
            pixelHeight: 5
          }
        ]
      }
    };
    expect(sheetPictures(document).get(pictureId)).toEqual({
      name: 'Logo',
      checksumSha256: checksum,
      contentType: 'image/png',
      pixelWidth: 10,
      pixelHeight: 5
    });
  });
});

/** SOI, then an APP1 Exif block whose IFD0 holds one orientation tag. */
function exifJpeg(orientation: number, little = false) {
  const u16 = (value: number) =>
    little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff];
  const u32 = (value: number) =>
    little
      ? [value & 0xff, (value >> 8) & 0xff, 0, 0]
      : [0, 0, (value >> 8) & 0xff, value & 0xff];
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(1),
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0)
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = body.length + 2;
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe1,
    length >> 8,
    length & 0xff,
    ...body,
    ...jpegHeader(40, 30).subarray(2)
  ]);
}

describe('sheet image orientation', () => {
  it('reads a JPEG’s EXIF orientation in either byte order', () => {
    expect(jpegExifOrientation(exifJpeg(6))).toBe(6);
    expect(jpegExifOrientation(exifJpeg(8, true))).toBe(8);
    expect(jpegExifOrientation(jpegHeader(40, 30))).toBe(1);
    expect(jpegExifOrientation(Uint8Array.from([0x89, 0x50]))).toBe(1);
  });

  it('passes an upright JPEG through and draws a turned one upright', async () => {
    const upright = jpegHeader(40, 30);
    const reencoded = Uint8Array.from([1, 2, 3]);
    const calls: Blob[] = [];
    const reencode = async (blob: Blob) => {
      calls.push(blob);
      return reencoded;
    };
    expect(
      await pictureJpegBytes(
        new Blob([upright], { type: 'image/jpeg' }),
        'image/jpeg',
        reencode
      )
    ).toEqual(upright);
    expect(calls).toHaveLength(0);
    // A phone photograph stored sideways: the PDF has no EXIF to turn it.
    expect(
      await pictureJpegBytes(
        new Blob([exifJpeg(6)], { type: 'image/jpeg' }),
        'image/jpeg',
        reencode
      )
    ).toBe(reencoded);
    expect(calls).toHaveLength(1);
    // A PNG is always drawn onto white.
    await pictureJpegBytes(new Blob([upright]), 'image/png', reencode);
    expect(calls).toHaveLength(2);
  });
});

describe('sheet image export', () => {
  const sheet = sheetWith([image()]);
  const laid = composeSheetAnnotations(
    sheet,
    [],
    resolveSheetAnnotations(sheet, {}, 'mm', undefined, undefined, pictures),
    'mm'
  );
  const page = composeSheetPage(
    sheet,
    [],
    { projectName: 'Images', units: 'mm' },
    laid
  );

  it('reads a JPEG’s size and components, and refuses anything else', () => {
    expect(jpegInfo(jpegHeader(400, 200))).toEqual({
      width: 400,
      height: 200,
      components: 3
    });
    expect(jpegInfo(jpegHeader(64, 32, 1)).components).toBe(1);
    expect(() => jpegInfo(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(
      /not a readable JPEG/
    );
  });

  it('embeds the picture in SVG, flipped onto the page, and refuses without it', async () => {
    expect(pagePictures(page.images)).toEqual(
      new Map([[checksum, 'image/jpeg']])
    );
    const bytes = jpegHeader(400, 200);
    const loaded = await loadPagePictures(
      page.images,
      async (wanted) =>
        wanted === checksum ? new Blob([bytes], { type: 'image/jpeg' }) : null,
      pictureDataUrl
    );
    const href = loaded!.get(checksum)!;
    expect(href.startsWith('data:image/jpeg;base64,')).toBe(true);
    const svg = sheetPageToSvg(page, 'Images', loaded!);
    // A4 landscape is 210 high: the image's top edge is 210 − 50 = 160 down.
    expect(svg).toContain(
      `<image x="40" y="160" width="40" height="20" preserveAspectRatio="none" href="${href}"/>`
    );
    expect(() => sheetPageToSvg(page, 'Images')).toThrow(
      SheetPictureUnavailableError
    );
    expect(
      await loadPagePictures(page.images, async () => null, pictureDataUrl)
    ).toBeNull();
  });

  it('draws the picture into the PDF as a DCT image, once per picture', () => {
    const bytes = jpegHeader(400, 200);
    const twice = composeSheetPage(
      sheet,
      [],
      { projectName: 'Images', units: 'mm' },
      { ...laid, images: [...laid.images, { ...laid.images[0]!, x: 100 }] }
    );
    const pdf = new TextDecoder('latin1').decode(
      sheetPageToPdf(twice, 'Images', new Map([[checksum, bytes]]))
    );
    expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(1);
    expect(pdf).toContain(
      '/Width 400 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode'
    );
    expect(pdf).toContain('/XObject << /Im1 7 0 R >>');
    expect(pdf.match(/\/Im1 Do Q/g)).toHaveLength(2);
    // 40 × 20 mm at (40, 30) mm, in points.
    expect(pdf).toContain('q 113.386 0 0 56.693 113.386 85.039 cm /Im1 Do Q');
    // The info dictionary stays last.
    expect(pdf).toMatch(/\/Info 8 0 R/);
    expect(() => sheetPageToPdf(page, 'Images')).toThrow(
      SheetPictureUnavailableError
    );
    // A page without pictures has no XObject.
    const plain = new TextDecoder('latin1').decode(
      sheetPageToPdf({ ...page, images: undefined }, 'Images')
    );
    expect(plain).not.toContain('/XObject');
  });

  it('leaves the picture out of DXF', () => {
    const dxf = sheetPageToDxf(page);
    expect(dxf).not.toContain('IMAGE');
  });

  it('gates sheet images at v92', () => {
    let document: ProjectDocument = createProjectDocument(
      'Images',
      toUserId('test')
    );
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetWith([image()]) })
    );
    document = manager.document;
    expect(() => assertStorableDocument(document)).not.toThrow();
    expect(() =>
      assertStorableDocument({
        ...document,
        // The release before sheet images, whatever came after them.
        schemaVersion: 91
      })
    ).toThrow(/Sheet images require project schema v92/);
  });
});
