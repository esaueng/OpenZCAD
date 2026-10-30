import type {
  BodyId,
  BodyRepresentation,
  ProjectDocument
} from '@openzcad/shared';

/**
 * A proposed, explicit drawing Update through one-to-one finishing features.
 * No names, geometric proximity, split halves, copies or boolean operands are
 * guessed. Edge references keep their witnesses and still have to resolve.
 */
export function drawingBodyReplacements(
  document: ProjectDocument,
  bodies: Readonly<Record<string, BodyRepresentation | undefined>>,
  ids: readonly BodyId[]
): { from: BodyId; to: BodyId }[] | null {
  const successors = new Map<BodyId, BodyId[]>();
  for (const node of Object.values(document.nodes)) {
    if (node.kind !== 'feature' || !node.bodyId || !bodies[node.bodyId])
      continue;
    const data = node.data;
    switch (data.featureKind) {
      case 'fillet':
      case 'chamfer':
      case 'hole':
      case 'shell':
      case 'solid-offset':
      case 'draft': {
        const targets = successors.get(data.targetBodyId) ?? [];
        targets.push(node.bodyId);
        successors.set(data.targetBodyId, targets);
        break;
      }
      case 'gear':
        // Teeth cut into a body replace it, as a hole does.
        if (data.targetBodyId !== undefined) {
          const targets = successors.get(data.targetBodyId) ?? [];
          targets.push(node.bodyId);
          successors.set(data.targetBodyId, targets);
        }
        break;
    }
  }
  const replacements: { from: BodyId; to: BodyId }[] = [];
  for (const from of ids) {
    let to = from;
    const seen = new Set<BodyId>();
    while (!bodies[to] || bodies[to]?.consumed) {
      if (seen.has(to)) return null;
      seen.add(to);
      const next = successors.get(to);
      if (next?.length !== 1) return null;
      to = next[0]!;
    }
    if (to !== from) replacements.push({ from, to });
  }
  return replacements;
}
