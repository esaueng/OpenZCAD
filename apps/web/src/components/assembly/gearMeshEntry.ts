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

/** A selected pair, preserving pick order unless one gear is already fixed. */
export function selectedGearMesh(
  document: ProjectDocument,
  selectedIds: readonly string[]
): ReturnType<typeof defaultGearMesh> | null {
  if (selectedIds.length !== 2 || selectedIds[0] === selectedIds[1])
    return null;
  const context = gearMeshCardContext(document);
  if (!context) return null;
  const gears = new Set(gearComponentIds(context));
  return selectedIds.every((id) => gears.has(id))
    ? defaultGearMesh(context, selectedIds)
    : null;
}

/** Opens Place gears on the selected pair, or the fixed and first free gears. */
export function openGearMesh(
  document: ProjectDocument,
  selectedIds: readonly string[] = []
): boolean {
  const context = gearMeshCardContext(document);
  if (!context || gearComponentIds(context).length < 2) return false;
  assemblyRuntime.openGearMesh(
    selectedGearMesh(document, selectedIds) ?? defaultGearMesh(context)
  );
  return true;
}
