import {
  createReferenceImageId,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGE_NAME_LENGTH,
  MAX_REFERENCE_IMAGE_PIXELS,
  sniffReferenceImageType,
  UNIT_TO_MM,
  type ArtifactId,
  type ProjectDocument,
  type ReferenceImage,
  type ReferenceImagePlane
} from '@openzcad/shared';
import type { ArchiveArtifactInput } from './archiveArtifact';
import { LOCAL_ARTIFACT_ID_PREFIX } from './importArchival';
import {
  deleteSourceBlobIfUnreferenced,
  ensureLocalProjectStorage,
  loadSourceBlob,
  putSourceBlob,
  sha256Hex
} from './localProjectStore';
import { addReferenceImage } from '@openzcad/document-core';

/*
 * I05: reading a picture into a reference image, and its bytes back out.
 * Lazy on purpose — the workspace shell only reaches this when the user
 * inserts an image or the viewport draws one.
 */

/** The width a new image takes: 100 mm, in the document's units. */
const DEFAULT_WIDTH_MM = 100;

export interface PrepareReferenceImageInput {
  file: File;
  document: ProjectDocument;
  plane: ReferenceImagePlane;
  /**
   * Uploads the picture as the image's `reference-image` artifact. It
   * throws where there is no account copy to archive into; the image then
   * keeps a device-local artifact id, exactly as an import does.
   */
  archive(input: ArchiveArtifactInput): Promise<string>;
  /** Decodes the picture to read its size; a seam for tests. */
  measure?: (blob: Blob) => Promise<{ width: number; height: number }>;
}

async function measureBitmap(
  blob: Blob
): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function imageName(fileName: string, document: ProjectDocument): string {
  const stem =
    fileName
      .replace(/\.[^.]*$/, '')
      .trim()
      .slice(0, MAX_REFERENCE_IMAGE_NAME_LENGTH - 4) || 'Image';
  const taken = new Set(
    (document.referenceImages?.images ?? []).map((image) => image.name)
  );
  if (!taken.has(stem)) return stem;
  for (let index = 2; ; index += 1) {
    const candidate = `${stem} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Checks, stores and (where it can) archives a picture, and returns the
 * image record to insert. The bytes go to the content-addressed source blob
 * store before anything else, so the document only ever names them by hash.
 * Refusals throw with the sentence to show.
 */
export async function prepareReferenceImage({
  file,
  document,
  plane,
  archive,
  measure = measureBitmap
}: PrepareReferenceImageInput): Promise<ReferenceImage> {
  if (file.size > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(
      `${file.name} is larger than ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MB. Insert a smaller picture.`
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffReferenceImageType(bytes);
  if (!contentType) {
    throw new Error(`${file.name} is not a PNG or JPEG image.`);
  }
  const body = new Blob([bytes], { type: contentType });
  let size: { width: number; height: number };
  try {
    size = await measure(body);
  } catch {
    throw new Error(`${file.name} could not be read as an image.`);
  }
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    Math.max(size.width, size.height) > MAX_REFERENCE_IMAGE_PIXELS
  ) {
    throw new Error(
      `${file.name} is ${size.width} × ${size.height} pixels; pictures up to ${MAX_REFERENCE_IMAGE_PIXELS} pixels on a side can be placed.`
    );
  }
  // The whole insert is checked before a byte is stored or uploaded: a
  // refusal (the project already holds the most images it may, a plane the
  // section cannot hold) must not leave an unreferenced picture behind on
  // this device or in the account.
  const candidate: ReferenceImage = {
    imageId: createReferenceImageId(),
    name: imageName(file.name, document),
    contentType,
    source: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: await sha256Hex(bytes),
      logicalBytes: bytes.byteLength
    },
    artifactId:
      `${LOCAL_ARTIFACT_ID_PREFIX}${crypto.randomUUID()}` as ArtifactId,
    pixelWidth: size.width,
    pixelHeight: size.height,
    plane,
    center: { u: 0, v: 0 },
    rotationDeg: 0,
    width: DEFAULT_WIDTH_MM / UNIT_TO_MM[document.units],
    opacity: 0.6
  };
  addReferenceImage(document, { image: candidate });
  if ((await ensureLocalProjectStorage()) !== 'ready') {
    // Never embedded: without the blob store the picture has nowhere to live.
    throw new Error(
      'This browser is not letting OpenZCAD store files, so the picture cannot be kept with the project.'
    );
  }
  const source = await putSourceBlob(bytes);
  let artifactId: string = candidate.artifactId;
  try {
    artifactId = await archive({
      fileName: file.name || 'image',
      contentType,
      kind: 'reference-image',
      body,
      metadata: { checksumSha256: source.checksumSha256 }
    });
  } catch {
    // Kept on this device; the next account save archives it.
  }
  return { ...candidate, source, artifactId: artifactId as ArtifactId };
}

/**
 * Releases the bytes an insert stored when its command did not commit after
 * all (the project was locked or changed underneath it). Cleanup keeps them
 * while any saved project or undo history still names the checksum. The
 * account artifact, if one was made, stays: like a refused import's upload,
 * it is unreferenced and counts toward storage until the project goes.
 */
export async function discardReferenceImageBytes(
  image: ReferenceImage
): Promise<void> {
  await deleteSourceBlobIfUnreferenced({
    checksumSha256: image.source.checksumSha256
  }).catch(() => false);
}

/**
 * A picture's bytes: this device's source store first, then the image's
 * archived artifact (checksum-verified and cached here by the resolver).
 * Null when neither has them — a device-only image opened elsewhere.
 */
export async function loadReferenceImageBlob(
  image: ReferenceImage
): Promise<Blob | null> {
  let bytes: Uint8Array | null = await loadSourceBlob(
    image.source.checksumSha256
  );
  if (!bytes && !image.artifactId.startsWith(LOCAL_ARTIFACT_ID_PREFIX)) {
    const { resolveExactSourceBytes } = await import('./exactSourceResolver');
    bytes = await resolveExactSourceBytes(image.source, {
      artifactId: image.artifactId,
      sourceName: image.name
    }).catch(() => null);
  }
  return bytes
    ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: image.contentType })
    : null;
}
