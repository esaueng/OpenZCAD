import {
  growingHolderHistories,
  type GrowingHolderBridge,
  type GrowingHolderPiece
} from '@openzcad/command-system';
import { evaluateExpression, getParameterScope } from '@openzcad/document-core';
import type {
  BodyRepresentation,
  ParamValue,
  ProjectDocument
} from '@openzcad/shared';

const AXES = ['x', 'y', 'z'] as const;

const evaluate = (value: ParamValue, scope: Record<string, number>): number =>
  typeof value === 'number' ? value : evaluateExpression(value, scope);

/** Disposable display only. Never attach this to a document or export it.
 * Covers every intact growing-holder recipe the compiler wrote into the
 * document (`growingHolderHistories` verifies the history against the recipe
 * feature by feature, so an edited history yields no preview). The cached
 * operand meshes already contain the last successful moves; each piece is
 * translated by the change in its move, and each bridge is stretched along
 * its extrusion axis from its old start to its new one, then moved likewise.
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
  // Only the recipe controls have a trustworthy approximation. A change to
  // any other parameter (a bore diameter, a value some unrelated feature
  // reads) stays on the exact-only path, even when a control moved with it.
  const controlled = new Set(
    histories.flatMap(({ recipe }) => [
      recipe.parameter,
      ...(recipe.height ? [recipe.height.parameter] : [])
    ])
  );
  for (const name of new Set([
    ...Object.keys(before.scope),
    ...Object.keys(after.scope)
  ])) {
    if (!controlled.has(name) && before.scope[name] !== after.scope[name])
      return null;
  }
  const previews: BodyRepresentation[] = [];
  for (const history of histories) {
    const { recipe, plan } = history;
    const controls: [string, number][] = [
      [recipe.parameter, recipe.minimumOpening]
    ];
    if (recipe.height)
      controls.push([recipe.height.parameter, recipe.height.minimumHeight]);
    let changed = false;
    for (const [parameter, minimum] of controls) {
      const oldValue = before.scope[parameter];
      const newValue = after.scope[parameter];
      if (
        !Number.isFinite(oldValue) ||
        !Number.isFinite(newValue) ||
        oldValue! < minimum ||
        newValue! < minimum
      )
        return null;
      if (oldValue !== newValue) changed = true;
    }
    if (!changed) return null;
    const result = base.derived.bodyRepresentations[history.resultBodyId];
    const parts = plan.unionOrder.map((key) => ({
      key,
      piece: plan.pieces.find((p) => p.key === key),
      bridge: plan.bridges.find((b) => b.key === key),
      representation: base.derived.bodyRepresentations[history.bodies[key]!]
    }));
    if (
      !result ||
      result.consumed ||
      parts.some(
        (part) => !part.representation || !part.representation.consumed
      )
    )
      return null;
    let rules: {
      mesh: BodyRepresentation['mesh'];
      delta: [number, number, number];
      stretch: {
        axis: 0 | 1 | 2;
        oldStart: number;
        newStart: number;
        ratio: number;
      } | null;
    }[];
    try {
      rules = parts.map((part) => {
        const spec = (part.piece ?? part.bridge) as
          GrowingHolderPiece | GrowingHolderBridge;
        const delta = AXES.map(
          (axis) =>
            evaluate(spec.move[axis], after.scope) -
            evaluate(spec.move[axis], before.scope)
        ) as [number, number, number];
        let stretch = null;
        if (part.bridge) {
          const oldLength = evaluate(part.bridge.distance, before.scope);
          const newLength = evaluate(part.bridge.distance, after.scope);
          const ratio = newLength / oldLength;
          if (!Number.isFinite(ratio) || ratio <= 0)
            throw new Error('bridge vanished');
          stretch = {
            axis: { x: 0, y: 1, z: 2 }[part.bridge.axis] as 0 | 1 | 2,
            oldStart: evaluate(part.bridge.offset, before.scope),
            newStart: evaluate(part.bridge.offset, after.scope),
            ratio
          };
        }
        return { mesh: part.representation!.mesh, delta, stretch };
      });
    } catch {
      return null;
    }
    const vertices = new Float32Array(
      rules.reduce((n, rule) => n + rule.mesh.vertices.length, 0)
    );
    const indices = new Uint32Array(
      rules.reduce((n, rule) => n + rule.mesh.indices.length, 0)
    );
    const bbox = {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity }
    };
    let vertexOffset = 0;
    let indexOffset = 0;
    for (const rule of rules) {
      for (let i = 0; i < rule.mesh.vertices.length; i += 3) {
        for (let component = 0; component < 3; component += 1) {
          let value = rule.mesh.vertices[i + component]!;
          if (rule.stretch && component === rule.stretch.axis)
            value =
              rule.stretch.newStart +
              (value - rule.stretch.oldStart) * rule.stretch.ratio;
          value += rule.delta[component]!;
          if (!Number.isFinite(value)) return null;
          vertices[vertexOffset + i + component] = value;
          const key = AXES[component]!;
          bbox.min[key] = Math.min(bbox.min[key], value);
          bbox.max[key] = Math.max(bbox.max[key], value);
        }
      }
      for (const index of rule.mesh.indices)
        indices[indexOffset++] = index + vertexOffset / 3;
      vertexOffset += rule.mesh.vertices.length;
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
