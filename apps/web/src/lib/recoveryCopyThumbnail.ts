import { listFeaturesInOrder } from '@openzcad/document-core';
import type { BodyRepresentation, ProjectDocument } from '@openzcad/shared';
import type { ProjectThumbnailRecord } from './localProjectStore';

interface RecoveryCopyThumbnailHost {
  loadCached(projectId: string): Promise<ProjectThumbnailRecord | null>;
  save(
    projectId: string,
    thumbnail: { source: string | null; version: number; updatedAt: string }
  ): Promise<void>;
  render(bodies: BodyRepresentation[]): Promise<string | null>;
}

/**
 * Gives a recovery copy the card preview its source already had.
 *
 * The shelf never loads a document to draw a tile, so a project whose
 * thumbnail record is never written stays a placeholder until it is opened —
 * and a recovery copy is exactly that: a clone saved from the conflict dialog,
 * never opened. This runs at write time, while the source's meshes are still
 * in memory: the source's cached image is reused when it matches the version
 * being cloned, and otherwise the copy's own derived bodies are rendered.
 *
 * The record is keyed on the copy's document version, the version the
 * workspace's capture treats as already drawn. That is why a copy that
 * cannot be drawn gets no record rather than a null one: "Keep mine" clones
 * the account copy, which travels without its projection, so it has features
 * but no meshes. A null keyed to its version would list as "No geometry" and
 * stop the capture from ever replacing it; no record lists as a placeholder
 * and is written the first time the copy is opened and left. The cloud
 * artifact id is deliberately not carried over, because it belongs to the
 * source project.
 */
export async function seedRecoveryCopyThumbnail(
  source: ProjectDocument,
  copy: ProjectDocument,
  host: RecoveryCopyThumbnailHost
): Promise<void> {
  const cached = await host.loadCached(source.projectId).catch(() => null);
  if (cached && cached.version === source.version && cached.source) {
    await host.save(copy.projectId, {
      source: cached.source,
      version: copy.version,
      updatedAt: copy.derived.updatedAt
    });
    return;
  }
  const bodies = Object.values(copy.derived.bodyRepresentations).filter(
    (body) => !body.consumed
  );
  if (bodies.length === 0 && listFeaturesInOrder(copy).length > 0) {
    return;
  }
  let image: string | null;
  try {
    image = await host.render(bodies);
  } catch {
    return;
  }
  await host.save(copy.projectId, {
    source: image,
    version: copy.version,
    updatedAt: copy.derived.updatedAt
  });
}
