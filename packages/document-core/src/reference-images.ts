import {
  assertReferenceImageSet,
  deepClone,
  type ProjectDocument,
  type ReferenceImage,
  type ReferenceImageId
} from '@openzcad/shared';

/**
 * I05 reference-image commands. Each carries explicit data — the whole image
 * record on insert, the changed placement fields on update — so undo, redo
 * and replay reproduce the same placement without the pixels, which stay in
 * the source blob store and the image's artifact.
 */

export interface ReferenceImageAddInput {
  image: ReferenceImage;
}

export interface ReferenceImageUpdateInput {
  imageId: ReferenceImageId;
  name?: string;
  plane?: ReferenceImage['plane'];
  center?: ReferenceImage['center'];
  rotationDeg?: number;
  width?: number;
  opacity?: number;
}

export interface ReferenceImageDeleteInput {
  imageId: ReferenceImageId;
}

/** A turn in (−180, 180], so equal placements store equal angles. */
export function normalizedReferenceImageRotation(degrees: number): number {
  const turned = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return turned === -180 ? 180 : turned;
}

function withReferenceImages(
  document: ProjectDocument,
  edit: (images: ReferenceImage[]) => ReferenceImage[]
): ProjectDocument {
  const before = document.referenceImages?.images ?? [];
  const images = edit(deepClone(before));
  // An edit that changes nothing returns the same document, which the
  // command manager records as no edit: no version, no undo entry, no save.
  if (JSON.stringify(images) === JSON.stringify(before)) return document;
  const referenceImages = images.length > 0 ? { images } : undefined;
  assertReferenceImageSet(referenceImages);
  const { referenceImages: _previous, ...rest } = document;
  return {
    ...rest,
    // Fresh arrays, as for drawings: the command manager appends to the log
    // of the returned document, and a shared array would leak the command
    // into the previous one.
    commandLog: [...document.commandLog],
    revisions: [...document.revisions],
    checkpoints: [...document.checkpoints],
    ...(referenceImages ? { referenceImages } : {}),
    version: document.version + 1
  };
}

function imageIndex(images: ReferenceImage[], imageId: ReferenceImageId) {
  const index = images.findIndex((image) => image.imageId === imageId);
  if (index < 0) throw new Error(`Reference image ${imageId} not found.`);
  return index;
}

export function findReferenceImage(
  document: ProjectDocument,
  imageId: ReferenceImageId
): ReferenceImage | undefined {
  return document.referenceImages?.images.find(
    (image) => image.imageId === imageId
  );
}

export function addReferenceImage(
  document: ProjectDocument,
  input: ReferenceImageAddInput
): ProjectDocument {
  return withReferenceImages(document, (images) => {
    if (images.some((image) => image.imageId === input.image.imageId))
      throw new Error(`Reference image ${input.image.imageId} already exists.`);
    return [
      ...images,
      {
        ...deepClone(input.image),
        name: input.image.name.trim(),
        rotationDeg: normalizedReferenceImageRotation(input.image.rotationDeg)
      }
    ];
  });
}

export function updateReferenceImage(
  document: ProjectDocument,
  input: ReferenceImageUpdateInput
): ProjectDocument {
  return withReferenceImages(document, (images) => {
    const image = images[imageIndex(images, input.imageId)]!;
    if (input.name !== undefined) image.name = input.name.trim();
    if (input.plane) image.plane = deepClone(input.plane);
    if (input.center) image.center = { u: input.center.u, v: input.center.v };
    if (input.rotationDeg !== undefined)
      image.rotationDeg = normalizedReferenceImageRotation(input.rotationDeg);
    if (input.width !== undefined) image.width = input.width;
    if (input.opacity !== undefined) image.opacity = input.opacity;
    return images;
  });
}

export function deleteReferenceImage(
  document: ProjectDocument,
  input: ReferenceImageDeleteInput
): ProjectDocument {
  return withReferenceImages(document, (images) => {
    images.splice(imageIndex(images, input.imageId), 1);
    return images;
  });
}
