import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder
} from '@openzcad/document-core';
import type {
  BodyId,
  FeatureData,
  BodyRepresentation,
  ProjectDocument
} from '@openzcad/shared';

const widthExpression = 'require_min(opening_width, 16.1)';

/** Disposable display only. Never attach this to a document or export it.
 * Restricted to the prepared seven-feature growing-holder recipe. The cached
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
  const before = getParameterScope(base);
  const after = getParameterScope(next);
  const oldWidth = before.scope.opening_width;
  const width = after.scope.opening_width;
  if (
    before.errors.length ||
    after.errors.length ||
    !Number.isFinite(oldWidth) ||
    !Number.isFinite(width) ||
    oldWidth! < 16.1 ||
    width! < 16.1 ||
    oldWidth === width
  )
    return null;
  const features = listFeaturesInOrder(next);
  if (features.length !== 7 || features.some((f) => f.metadata?.suppressed))
    return null;
  const [left, right, section, bridge, moveLeft, moveRight, union] = features;
  if (
    left!.data.featureKind !== 'imported-step' ||
    right!.data.featureKind !== 'imported-step' ||
    section!.data.featureKind !== 'sketch' ||
    bridge!.data.featureKind !== 'extrude' ||
    moveLeft!.data.featureKind !== 'transform' ||
    moveRight!.data.featureKind !== 'transform' ||
    union!.data.featureKind !== 'boolean'
  )
    return null;
  const extrusion = bridge!.data;
  const sketch = findSketch(next, extrusion.sketchId);
  if (
    !sketch ||
    sketch.sketchId !== section!.data.sketchId ||
    sketch.constraints?.length ||
    sketch.planeRef.type !== 'canonical' ||
    sketch.planeRef.plane !== 'YZ' ||
    sketch.planeRef.offset !== `19 - (${widthExpression}) / 2` ||
    extrusion.distance !== `(${widthExpression}) - 16` ||
    extrusion.symmetric ||
    extrusion.backDistance ||
    (extrusion.operation && extrusion.operation !== 'new-body')
  )
    return null;
  // Fixed numeric line/arc profile only: no parameter-driven section geometry.
  if (
    !sketch.objectIds.length ||
    sketch.objectIds.some((id) => {
      const node = next.nodes[id];
      return (
        node?.kind !== 'sketch-object' ||
        !['line', 'arc'].includes(node.objectKind) ||
        Object.entries(node.data).some(
          ([key, value]) =>
            key !== 'objectKind' &&
            typeof value !== 'boolean' &&
            (typeof value !== 'number' || !Number.isFinite(value))
        )
      );
    })
  )
    return null;
  const matchesMove = (
    data: FeatureData,
    target: BodyId | undefined,
    x: string
  ) =>
    data.featureKind === 'transform' &&
    data.targetBodyId === target &&
    data.transform.translation.x === x &&
    data.transform.translation.y === 0 &&
    data.transform.translation.z === 0 &&
    Object.values(data.transform.rotationDeg).every((v) => v === 0) &&
    (data.transform.scale === undefined || data.transform.scale === 1);
  if (
    !matchesMove(
      moveLeft!.data,
      left!.bodyId,
      `(46 - (${widthExpression})) / 2`
    ) ||
    !matchesMove(
      moveRight!.data,
      right!.bodyId,
      `((${widthExpression}) - 46) / 2`
    )
  )
    return null;
  const boolean = union!.data;
  const ids = [left!.bodyId, bridge!.bodyId, right!.bodyId];
  if (
    boolean.operation !== 'union' ||
    JSON.stringify(boolean.targetBodyIds) !== JSON.stringify(ids) ||
    boolean.activeWhen !== undefined
  )
    return null;
  const result =
    union!.bodyId && base.derived.bodyRepresentations[union!.bodyId];
  const parts = ids.map((id) => id && base.derived.bodyRepresentations[id]);
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
  const delta = (width! - oldWidth!) / 2;
  const oldStart = 19 - oldWidth! / 2;
  const newStart = 19 - width! / 2;
  const ratio = (width! - 16) / (oldWidth! - 16);
  const bbox = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity }
  };
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const [partIndex, part] of operands.entries()) {
    for (let i = 0; i < part.mesh.vertices.length; i += 3) {
      const x = part.mesh.vertices[i]!;
      const px =
        partIndex === 1
          ? newStart + (x - oldStart) * ratio
          : x + (partIndex === 0 ? -delta : delta);
      vertices[vertexOffset + i] = px;
      vertices[vertexOffset + i + 1] = part.mesh.vertices[i + 1]!;
      vertices[vertexOffset + i + 2] = part.mesh.vertices[i + 2]!;
      for (const [offset, axis] of (['x', 'y', 'z'] as const).entries()) {
        const value = vertices[vertexOffset + i + offset]!;
        if (!Number.isFinite(value)) return null;
        bbox.min[axis] = Math.min(bbox.min[axis], value);
        bbox.max[axis] = Math.max(bbox.max[axis], value);
      }
    }
    for (const index of part.mesh.indices)
      indices[indexOffset++] = index + vertexOffset / 3;
    vertexOffset += part.mesh.vertices.length;
  }
  // No exact topology or measurements are claimed for this unjoined display.
  return [
    {
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
    }
  ];
}
