import type { ProjectDocument, SketchNode } from '@openzcad/shared';

/** Distinguish repeated authored names without renaming saved geometry. */
export function sketchObjectLabels(
  document: ProjectDocument,
  sketch: Pick<SketchNode, 'objectIds'>
): Map<string, string> {
  const objects = sketch.objectIds.flatMap((id) => {
    const node = document.nodes[id];
    return node?.kind === 'sketch-object'
      ? [{ id, name: node.name || node.data.objectKind }]
      : [];
  });
  const counts = new Map<string, number>();
  for (const { name } of objects) counts.set(name, (counts.get(name) ?? 0) + 1);
  const used = new Set(objects.map(({ name }) => name));
  const next = new Map<string, number>();
  return new Map(
    objects.map(({ id, name }) => {
      if (counts.get(name) === 1) return [id, name];
      let index = next.get(name) ?? 1;
      while (used.has(`${name} ${index}`)) index += 1;
      const label = `${name} ${index}`;
      used.add(label);
      next.set(name, index + 1);
      return [id, label];
    })
  );
}
