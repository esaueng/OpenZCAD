import { isImportedSourceReference } from './index';
import type {
  ArtifactId,
  Brand,
  ImportedSourceReference,
  SketchPlaneRef
} from './index';

/**
 * I05 reference images (schema v32) — the persisted half shared by the
 * document, the command system and the viewport.
 *
 * A reference image is canonical user content, like a drawing sheet: which
 * picture, on which plane, where on that plane, how large and how opaque. It
 * is never a feature and never a body, so the solid build, the exports and
 * the drawing projection cannot see it. The pixels never enter the document:
 * `source` is the SHA-256 of the file's bytes, which live in the same
 * content-addressed source blob store STEP sources and mesh payloads use and
 * are archived as the `reference-image` artifact named by `artifactId`.
 */

export type ReferenceImageId = Brand<string, 'ReferenceImageId'>;

export const REFERENCE_IMAGE_ID_PREFIX = 'rimg_';

export function createReferenceImageId(): ReferenceImageId {
  return `${REFERENCE_IMAGE_ID_PREFIX}${crypto.randomUUID()}` as ReferenceImageId;
}

export type ReferenceImageContentType = 'image/png' | 'image/jpeg';

export const REFERENCE_IMAGE_CONTENT_TYPES: readonly ReferenceImageContentType[] =
  ['image/png', 'image/jpeg'];

/** The largest image file a project accepts. */
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
/** The longest side, in pixels, the viewport is asked to upload as a texture. */
export const MAX_REFERENCE_IMAGE_PIXELS = 8192;
export const MAX_REFERENCE_IMAGES = 64;
export const MAX_REFERENCE_IMAGE_NAME_LENGTH = 120;
/** Placement bound, in document units: generous, but finite. */
export const MAX_REFERENCE_IMAGE_EXTENT = 1_000_000;
/** The faintest an image may be, so a shown image never vanishes entirely. */
export const MIN_REFERENCE_IMAGE_OPACITY = 0.05;

/**
 * Where an image lies. A canonical plane takes a plain numeric offset (an
 * image follows no parameters), a datum plane is held by id and follows it, a
 * face is held by lineage and follows it, and a face without identity is a
 * fixed frame coincident with it — the same plane references sketches use.
 */
export type ReferenceImagePlane =
  | Extract<SketchPlaneRef, { type: 'datum' }>
  | (Omit<Extract<SketchPlaneRef, { type: 'canonical' }>, 'offset'> & {
      offset: number;
    })
  | Extract<SketchPlaneRef, { type: 'frame' }>
  | Extract<SketchPlaneRef, { type: 'face' }>;

export interface ReferenceImage {
  imageId: ReferenceImageId;
  name: string;
  contentType: ReferenceImageContentType;
  /** The file's bytes, by SHA-256; never embedded. */
  source: ImportedSourceReference;
  /** The archived `reference-image` artifact other devices resolve from. */
  artifactId: ArtifactId;
  pixelWidth: number;
  pixelHeight: number;
  plane: ReferenceImagePlane;
  /** The image centre in the plane's (u, v) coordinates, document units. */
  center: { u: number; v: number };
  /** Counter-clockwise turn about the plane normal, degrees. */
  rotationDeg: number;
  /** Width along the image's own x, document units; height keeps the aspect. */
  width: number;
  /** 0.05–1. */
  opacity: number;
}

/** The document's reference-image section (schema v32). Absent means none. */
export interface ReferenceImageSet {
  images: ReferenceImage[];
}

/** The image's height in document units: its width at the file's aspect. */
export function referenceImageHeight(image: ReferenceImage): number {
  return (image.width * image.pixelHeight) / image.pixelWidth;
}

/**
 * The width an image takes when two points picked on it, in pixels, are
 * `distance` document units apart: the image scales about its centre so the
 * picked span measures the known distance. Null when the picks coincide or
 * the distance is not a positive finite number.
 */
export function calibratedReferenceImageWidth(
  image: Pick<ReferenceImage, 'pixelWidth'>,
  first: { x: number; y: number },
  second: { x: number; y: number },
  distance: number
): number | null {
  const pixels = Math.hypot(second.x - first.x, second.y - first.y);
  if (!(pixels > 1e-9) || !Number.isFinite(distance) || distance <= 0) {
    return null;
  }
  const width = (distance * image.pixelWidth) / pixels;
  return Number.isFinite(width) && width <= MAX_REFERENCE_IMAGE_EXTENT
    ? width
    : null;
}

/**
 * Whether a finalized `reference-image` artifact is one the viewport may be
 * handed: a PNG or JPEG within the file cap. Checked by both artifact stores.
 */
export function isAcceptableReferenceImageArtifact(
  contentType: string,
  bytes: number
): boolean {
  return (
    (REFERENCE_IMAGE_CONTENT_TYPES as readonly string[]).includes(
      contentType
    ) &&
    bytes > 0 &&
    bytes <= MAX_REFERENCE_IMAGE_BYTES
  );
}

/** Recognizes a PNG or JPEG by its leading bytes, never by its file name. */
export function sniffReferenceImageType(
  bytes: Uint8Array
): ReferenceImageContentType | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  return null;
}

/**
 * A PNG's or JPEG's pixel size as its header declares it (the PNG `IHDR`
 * chunk, the JPEG start-of-frame segment), read without decoding, so an
 * oversized picture can be refused before a decoder allocates its bitmap.
 * Null when the header is missing or malformed. A JPEG's EXIF orientation
 * may swap the decoded sides; the longer side is the same either way.
 */
export function referenceImageHeaderSize(
  bytes: Uint8Array
): { width: number; height: number } | null {
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  const u32 = (at: number) => u16(at) * 0x10000 + u16(at + 2);
  const type = sniffReferenceImageType(bytes);
  if (type === 'image/png') {
    // Signature, then the first chunk: length 13, type `IHDR`.
    const ihdr = [0x49, 0x48, 0x44, 0x52];
    if (
      bytes.length < 24 ||
      u32(8) !== 13 ||
      !ihdr.every((value, index) => bytes[12 + index] === value)
    )
      return null;
    return { width: u32(16), height: u32(20) };
  }
  if (type !== 'image/jpeg') return null;
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    while (bytes[at] === 0xff) at += 1;
    if (at >= bytes.length) return null;
    const marker = bytes[at]!;
    at += 1;
    // Markers without a length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // End of image, or scan data before any frame header.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null;
    if (at + 2 > bytes.length) return null;
    const length = u16(at);
    if (length < 2) return null;
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      if (length < 8 || at + 7 > bytes.length) return null;
      return { width: u16(at + 5), height: u16(at + 3) };
    }
    at += length;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown, bound = MAX_REFERENCE_IMAGE_EXTENT) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= bound
  );
}

function isVector(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.z)
  );
}

function isFrame(value: unknown): boolean {
  return (
    isRecord(value) &&
    isVector(value.origin) &&
    isVector(value.xAxis) &&
    isVector(value.yAxis) &&
    isVector(value.zAxis)
  );
}

function isId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function planeError(plane: unknown, where: string): string | null {
  if (!isRecord(plane)) return `${where} has no plane.`;
  switch (plane.type) {
    case 'datum':
      return isId(plane.datumFeatureId)
        ? null
        : `${where} names an invalid datum plane.`;
    case 'canonical':
      return (plane.plane === 'XY' ||
        plane.plane === 'XZ' ||
        plane.plane === 'YZ') &&
        isFiniteNumber(plane.offset) &&
        (plane.basisRevision === undefined || plane.basisRevision === 2)
        ? null
        : `${where} has an invalid principal plane.`;
    case 'frame':
      return isFrame(plane.frame)
        ? null
        : `${where} has an invalid plane frame.`;
    case 'face':
      return isId(plane.bodyId) &&
        typeof plane.faceHash === 'number' &&
        Number.isFinite(plane.faceHash) &&
        (plane.faceReference === undefined || isRecord(plane.faceReference)) &&
        isFiniteNumber(plane.sourceArea, Number.MAX_VALUE) &&
        isVector(plane.sourceCenter) &&
        (plane.sourceCentroid === undefined ||
          isVector(plane.sourceCentroid)) &&
        isVector(plane.sourceNormal) &&
        isFrame(plane.frame)
        ? null
        : `${where} has an invalid face plane.`;
    default:
      return `${where} has an unknown plane type.`;
  }
}

/** Why `value` is not a valid reference image, or null. Shape only. */
export function referenceImageError(value: unknown): string | null {
  if (!isRecord(value)) return 'A reference image is not a record.';
  if (
    typeof value.imageId !== 'string' ||
    !value.imageId.startsWith(REFERENCE_IMAGE_ID_PREFIX) ||
    value.imageId.length > 64
  )
    return 'A reference image has an invalid id.';
  const where = `Reference image ${value.imageId}`;
  if (
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    value.name.length > MAX_REFERENCE_IMAGE_NAME_LENGTH
  )
    return `${where} needs a name of at most ${MAX_REFERENCE_IMAGE_NAME_LENGTH} characters.`;
  if (
    !(REFERENCE_IMAGE_CONTENT_TYPES as readonly unknown[]).includes(
      value.contentType
    )
  )
    return `${where} is not a PNG or JPEG image.`;
  if (
    !isImportedSourceReference(value.source) ||
    value.source.logicalBytes > MAX_REFERENCE_IMAGE_BYTES
  )
    return `${where} has an invalid image reference.`;
  if (!isId(value.artifactId)) return `${where} has an invalid artifact id.`;
  for (const side of [value.pixelWidth, value.pixelHeight]) {
    if (
      typeof side !== 'number' ||
      !Number.isSafeInteger(side) ||
      side < 1 ||
      side > MAX_REFERENCE_IMAGE_PIXELS
    )
      return `${where} has invalid pixel dimensions.`;
  }
  const plane = planeError(value.plane, where);
  if (plane) return plane;
  if (
    !isRecord(value.center) ||
    !isFiniteNumber(value.center.u) ||
    !isFiniteNumber(value.center.v)
  )
    return `${where} has an invalid position.`;
  if (!isFiniteNumber(value.rotationDeg, 360))
    return `${where} has an invalid rotation.`;
  if (!isFiniteNumber(value.width) || (value.width as number) <= 0)
    return `${where} needs a positive width.`;
  if (
    typeof value.opacity !== 'number' ||
    !(value.opacity >= MIN_REFERENCE_IMAGE_OPACITY && value.opacity <= 1)
  )
    return `${where} needs an opacity from ${MIN_REFERENCE_IMAGE_OPACITY} to 1.`;
  return null;
}

/** Why `value` is not a valid reference-image section, or null. */
export function referenceImageSetError(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.images))
    return 'The reference-image section is not an image list.';
  if (value.images.length === 0)
    return 'An empty reference-image section is stored as absent.';
  if (value.images.length > MAX_REFERENCE_IMAGES)
    return `A project holds at most ${MAX_REFERENCE_IMAGES} reference images.`;
  const ids = new Set<string>();
  for (const image of value.images) {
    const error = referenceImageError(image);
    if (error) return error;
    const id = (image as ReferenceImage).imageId;
    if (ids.has(id)) return `Reference image ${id} is listed twice.`;
    ids.add(id);
  }
  return null;
}

/** Fails closed on a malformed reference-image section; absent is valid. */
export function assertReferenceImageSet(value: unknown): void {
  if (value === undefined) return;
  const error = referenceImageSetError(value);
  if (error) throw new Error(error);
}
