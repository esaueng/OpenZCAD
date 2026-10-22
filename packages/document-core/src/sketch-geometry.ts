import { deepClone, type ProjectDocument } from '@openzcad/shared';

type Geometry = NonNullable<ProjectDocument['derived']['sketchGeometry']>;
const views = new WeakMap<
  ProjectDocument,
  { geometry: Geometry; view: ProjectDocument }
>();

/**
 * The current exact sketch geometry for readers. Authored nodes, expressions,
 * commands and history remain on the original document; this view must never
 * be used as an edit or persistence base.
 */
export function resolvedSketchDocument(
  document: ProjectDocument
): ProjectDocument {
  const geometry = document.derived?.sketchGeometry;
  if (
    !geometry ||
    geometry.projectId !== document.projectId ||
    geometry.documentVersion !== document.version
  )
    return document;
  const cached = views.get(document);
  if (cached?.geometry === geometry) return cached.view;
  let nodes: ProjectDocument['nodes'] | undefined;
  for (const [objectId, data] of Object.entries(geometry.objects)) {
    const node = document.nodes[objectId];
    if (
      node?.kind !== 'sketch-object' ||
      node.data.objectKind !== data.objectKind
    )
      continue;
    nodes ??= { ...document.nodes };
    nodes[objectId] = { ...node, data: deepClone(data) };
  }
  const view = nodes ? { ...document, nodes } : document;
  views.set(document, { geometry, view });
  views.set(view, { geometry, view });
  return view;
}
