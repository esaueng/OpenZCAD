/**
 * L08: the current model, frozen for a share link without history. Each
 * body the model shows is written on its own in the kernel's exact exchange
 * form (STEP, as File › Export writes it) and becomes one imported solid of
 * a new document (`frozenShareDocument`): the visitor's kernel reads the
 * same exact faces and edges, and nothing of how they were built is there
 * to send.
 */
import {
  BODY_OPACITY_METADATA_KEY,
  chosenBodyColor,
  type ProjectDocument
} from '@openzcad/shared';
import {
  frozenShareDocument,
  listNodesByKind,
  type FrozenShareBody
} from '@openzcad/document-core';

import type { GeometryWorkerApi } from '../hooks/useGeometryWorker';

export type FrozenShareGeometry = Pick<
  GeometryWorkerApi,
  'exportBodies' | 'exportModel'
>;

export async function freezeModelForSharing(
  source: ProjectDocument,
  geometry: FrozenShareGeometry
): Promise<ProjectDocument> {
  // A mesh reference has no exact solid to write; it stays with the owner.
  const shown = (await geometry.exportBodies(source)).filter(
    (body) => !body.meshReference
  );
  if (shown.length === 0)
    throw new Error(
      'This model has no solid body to share. Add a body, or include history.'
    );
  const nodes = new Map(
    listNodesByKind(source, 'body').map((node) => [node.bodyId, node])
  );
  const featureKinds = new Map(
    listNodesByKind(source, 'feature').map((node) => [
      node.featureId,
      node.featureKind
    ])
  );
  const bodies: FrozenShareBody[] = [];
  for (const { bodyId, name } of shown) {
    // Millimetres, the unit the import reads back without asking.
    const written = await geometry.exportModel('step', source, [bodyId], {
      units: 'mm',
      fileName: `${name}.step`
    });
    if (!('text' in written))
      throw new Error(`${name} could not be written for sharing.`);
    const node = nodes.get(bodyId);
    const opacity = node?.metadata?.[BODY_OPACITY_METADATA_KEY];
    bodies.push({
      name,
      stepText: written.text,
      color: chosenBodyColor(
        node?.metadata,
        node ? featureKinds.get(node.featureId) : undefined
      ),
      opacity: typeof opacity === 'number' ? opacity : null
    });
  }
  return frozenShareDocument(source, bodies);
}
