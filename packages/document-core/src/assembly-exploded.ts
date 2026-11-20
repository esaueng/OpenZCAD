import {
  assemblyExplodeOffset,
  solveAssembly,
  transformToMatrix4,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import { assemblyComponentBodies } from './assembly';
import { isLiveAssemblyBody } from './assembly-bom';

/**
 * AS03 exploded drawing views (schema v112): where an exploded view draws
 * each body, as a column-major 4×4 world matrix by body id. A body some
 * component shows is placed at that component's solved pose (the stored
 * joint values) with its stored exploded offset applied after it, the
 * translation the Assemble viewport shows exploded (`T(offset) · pose`).
 * A body no component shows is absent: it is drawn where it was modelled.
 * When lineage leaves two components on one body, the later one in display
 * order places it, as the viewport does.
 */
export function assemblyExplodedMatrices(
  document: ProjectDocument,
  isLive: (bodyId: BodyId) => boolean = (bodyId) =>
    isLiveAssemblyBody(document, bodyId)
): Map<BodyId, number[]> {
  const matrices = new Map<BodyId, number[]>();
  const set = document.assembly;
  if (!set) return matrices;
  const solution = solveAssembly(set);
  const bodies = assemblyComponentBodies(document, isLive);
  for (const component of set.components) {
    const bodyId = bodies.get(component.id);
    const pose = solution.poses.get(component.id);
    if (!bodyId || !pose) continue;
    const offset = assemblyExplodeOffset(set, component.id);
    matrices.set(
      bodyId,
      transformToMatrix4(
        offset
          ? {
              t: {
                x: pose.t.x + offset.x,
                y: pose.t.y + offset.y,
                z: pose.t.z + offset.z
              },
              q: pose.q
            }
          : pose
      )
    );
  }
  return matrices;
}

/**
 * A key for the placements an exploded view draws `bodyIds` at: identical
 * placements give identical keys, so a sheet's model fence moves exactly
 * when a part of an exploded view is posed or pulled out differently.
 * Rounded to 1e-9 of the matrix entries, well below any drawn difference.
 */
export function explodedPlacementKey(
  matrices: ReadonlyMap<BodyId, readonly number[]>,
  bodyIds: readonly BodyId[]
): string {
  return [...new Set(bodyIds)]
    .sort()
    .map((bodyId) => {
      const matrix = matrices.get(bodyId);
      return matrix
        ? `${bodyId}:${matrix.map((value) => Math.round(value * 1e9) / 1e9).join(',')}`
        : `${bodyId}:-`;
    })
    .join(';');
}
