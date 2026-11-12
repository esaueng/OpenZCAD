import { assemblyComponentBodies } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { assemblyRuntime } from '../../lib/assembly/assemblyRuntime';
import {
  defaultGearMesh,
  gearComponentIds,
  gearMeshContext,
  type GearMeshContext
} from '../../lib/assembly/gearMesh';
import { isLiveBody } from './useAssemblyModel';

/** The saved assembly as Mesh gears reads it. */
export function gearMeshCardContext(
  document: ProjectDocument
): GearMeshContext | null {
  const bodies = assemblyComponentBodies(document, (bodyId) =>
    isLiveBody(document, bodyId)
  );
  return gearMeshContext(
    document,
    (componentId) => bodies.get(componentId) ?? null
  );
}

/** How many components show a gear: Mesh gears needs two. */
export function assemblyGearCount(document: ProjectDocument): number {
  const context = gearMeshCardContext(document);
  return context ? gearComponentIds(context).length : 0;
}

/** Opens Mesh gears on the fixed gear and the first free one. */
export function openGearMesh(document: ProjectDocument): boolean {
  const context = gearMeshCardContext(document);
  if (!context || gearComponentIds(context).length < 2) return false;
  assemblyRuntime.openGearMesh(defaultGearMesh(context));
  return true;
}
