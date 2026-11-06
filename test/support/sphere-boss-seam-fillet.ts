import { CommandManager, commandFactories } from '@openzcad/command-system';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { BodyId, FaceTopology } from '@openzcad/shared';
import { sphereCylinderUnionInputs } from './sphere-cylinder-union';

/**
 * The off-axis boss on a sphere with its seam rounded by an R2 fillet — the
 * owner's 2026-11-05 case. Its band is one freeform face, so a direct wall
 * resize still refuses with the typed `unsupported_neighbor` (nurbs) cause
 * after the sphere-neighbour resize landed (Remus #1558). Tests that need a
 * real, typed direct-edit refusal build on it.
 */
export async function filletedSphereBoss(adapter: ExactKernelAdapter): Promise<{
  manager: CommandManager;
  bodyId: BodyId;
  wall: FaceTopology;
}> {
  const inputs = sphereCylinderUnionInputs();
  const manager = new CommandManager(inputs.document);
  manager.execute(
    commandFactories.booleanBodies({
      name: 'Combine',
      operation: 'union',
      targetBodyIds: [inputs.sphere, inputs.cylinder]
    })
  );
  const unionId = manager.document.bodyOrder.at(-1)!;
  const union = await adapter.syncDocument(manager.document);
  const topology = union.bodyRepresentations[unionId]!.topology!;
  const boss = topology.faces.find(
    (face) => face.geometry?.surfaceType === 'cylinder'
  )!;
  const sphereFaces = new Set(
    topology.faces
      .filter((face) => face.geometry?.surfaceType === 'sphere')
      .map((face) => face.hash)
  );
  const seam = topology.edges.filter(
    (edge) =>
      edge.displayRole !== 'seam' &&
      edge.adjacentFaceHashes?.includes(boss.hash) &&
      edge.adjacentFaceHashes.some((hash) => sphereFaces.has(hash))
  );
  const references = seam.map((edge) => edge.reference);
  manager.execute(
    commandFactories.filletEdges({
      name: 'Fillet seam',
      targetBodyId: unionId,
      edgeHashes: seam.map((edge) => edge.hash),
      ...(references.every((reference) => reference !== undefined)
        ? { edgeReferences: references }
        : {}),
      size: 2
    })
  );
  const bodyId = manager.document.bodyOrder.at(-1)!;
  const filleted = await adapter.syncDocument(manager.document);
  const wall = filleted.bodyRepresentations[bodyId]!.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs((face.geometry.radius ?? 0) - 6) < 1e-6
  )!;
  return { manager, bodyId, wall };
}
