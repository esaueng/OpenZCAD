import { growingHolderHistories } from '@openzcad/command-system';
import { getParameterScope } from '@openzcad/document-core';
import type { BodyRepresentation, ProjectDocument } from '@openzcad/shared';

/** Disposable display only. Never attach this to a document or export it.
 * Covers every intact growing-holder recipe the compiler wrote into the
 * document (`growingHolderHistories` verifies the history against the recipe
 * feature by feature, so an edited history yields no preview). The cached
 * operand meshes already contain the last successful translations; apply only
 * the delta from that validated document, including across rapid edits/undo.
 */
export function growingHolderPreview(
  base: ProjectDocument | null,
  next: ProjectDocument | null
): BodyRepresentation[] | null {
  if (
    !base ||
    !next ||
    base.projectId !== next.projectId ||
    base.units !== next.units ||
    base.derived.warnings.length
  )
    return null;
  if (
    JSON.stringify(base.featureOrder) !== JSON.stringify(next.featureOrder) ||
    JSON.stringify(base.bodyOrder) !== JSON.stringify(next.bodyOrder)
  )
    return null;
  // Any structural edit, suppression, source replacement or sketch edit opts out.
  const structure = (doc: ProjectDocument) =>
    Object.values(doc.nodes).filter((node) => node.kind !== 'parameter');
  if (JSON.stringify(structure(base)) !== JSON.stringify(structure(next)))
    return null;
  const histories = growingHolderHistories(next);
  if (!histories.length) return null;
  const before = getParameterScope(base);
  const after = getParameterScope(next);
  if (before.errors.length || after.errors.length) return null;
  const previews: BodyRepresentation[] = [];
  for (const history of histories) {
    const { recipe, plan } = history;
    const oldWidth = before.scope[recipe.parameter];
    const width = after.scope[recipe.parameter];
    if (
      !Number.isFinite(oldWidth) ||
      !Number.isFinite(width) ||
      oldWidth! < recipe.minimumOpening ||
      width! < recipe.minimumOpening ||
      oldWidth === width
    )
      return null;
    const result = base.derived.bodyRepresentations[history.resultBodyId];
    const ids = [
      history.negativeEndBodyId,
      history.bridgeBodyId,
      history.positiveEndBodyId
    ];
    const parts = ids.map((id) => base.derived.bodyRepresentations[id]);
    if (
      !result ||
      result.consumed ||
      parts.some((part) => !part || !part.consumed)
    )
      return null;
    const operands = parts as BodyRepresentation[];
    const vertices = new Float32Array(
      operands.reduce((n, p) => n + p.mesh.vertices.length, 0)
    );
    const indices = new Uint32Array(
      operands.reduce((n, p) => n + p.mesh.indices.length, 0)
    );
    const axis = plan.axisIndex;
    const sectionLength = recipe.cuts[1] - recipe.cuts[0];
    const delta = (width! - oldWidth!) / 2;
    const oldStart = recipe.cuts[0] + (recipe.sourceOpening - oldWidth!) / 2;
    const newStart = recipe.cuts[0] + (recipe.sourceOpening - width!) / 2;
    const ratio =
      (sectionLength + width! - recipe.sourceOpening) /
      (sectionLength + oldWidth! - recipe.sourceOpening);
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    const bbox = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const [partIndex, part] of operands.entries()) {
      for (let i = 0; i < part.mesh.vertices.length; i += 3) {
        for (let component = 0; component < 3; component += 1) {
          let value = part.mesh.vertices[i + component]!;
          if (component === axis)
            value =
              partIndex === 1
                ? newStart + (value - oldStart) * ratio
                : value + (partIndex === 0 ? -delta : delta);
          if (!Number.isFinite(value)) return null;
          vertices[vertexOffset + i + component] = value;
          const key = (['x', 'y', 'z'] as const)[component]!;
          bbox.min[key] = Math.min(bbox.min[key], value);
          bbox.max[key] = Math.max(bbox.max[key], value);
        }
      }
      for (const index of part.mesh.indices)
        indices[indexOffset++] = index + vertexOffset / 3;
      vertexOffset += part.mesh.vertices.length;
    }
    // No exact topology or measurements are claimed for this unjoined display.
    previews.push({
      bodyId: result.bodyId,
      name: result.name,
      source: result.source,
      color: result.color,
      opacity: result.opacity,
      consumed: false,
      exportableStep: false,
      faceCount: 0,
      volume: 0,
      bbox,
      mesh: { kind: 'mesh', vertices, indices }
    });
  }
  return previews;
}
