import { useMemo } from 'react';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import { useAssemblyRuntime } from '../../lib/assembly/assemblyRuntime';
import {
  buildAssemblyView,
  type AssemblyViewModel
} from '../../lib/assembly/assemblyView';

/** A body is live while it is listed and no later feature consumed it. */
export function isLiveBody(document: ProjectDocument, bodyId: BodyId): boolean {
  const body = document.derived.bodyRepresentations[bodyId];
  return Boolean(body && !body.consumed);
}

/**
 * The assembly as the panels show it: saved content plus the transient
 * values on screen (a drag, a sweep), without the joint tool's preview
 * joint. Null while the document has no assembly.
 */
export function useAssemblyModel(
  document: ProjectDocument
): AssemblyViewModel | null {
  const overrides = useAssemblyRuntime((s) => s.overrides);
  const placementOverrides = useAssemblyRuntime((s) => s.placementOverrides);
  const selectedJointId = useAssemblyRuntime((s) => s.selectedJointId);
  return useMemo(
    () =>
      buildAssemblyView(
        document,
        {
          overrides,
          placementOverrides,
          selectedJointId,
          jointTool: null,
          motionSetup: null
        },
        (bodyId) => isLiveBody(document, bodyId)
      ),
    [document, overrides, placementOverrides, selectedJointId]
  );
}
