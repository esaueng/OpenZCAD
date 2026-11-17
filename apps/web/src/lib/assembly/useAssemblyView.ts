import { useMemo } from 'react';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import { useAssemblyRuntime } from './assemblyRuntime';
import { buildAssemblyView, type AssemblyViewModel } from './assemblyView';

/**
 * The assembly view the viewport draws (AS02): null unless the Assemble
 * workspace (or a playing View) is active. Read where the viewer is
 * rendered, so a playback frame re-renders the viewer and not the whole
 * workspace shell around it.
 */
export function useAssemblyView(
  document: ProjectDocument | null
): AssemblyViewModel | null {
  const active = useAssemblyRuntime((s) => s.active);
  const overrides = useAssemblyRuntime((s) => s.overrides);
  const drivers = useAssemblyRuntime((s) => s.drivers);
  const placementOverrides = useAssemblyRuntime((s) => s.placementOverrides);
  const selectedJointId = useAssemblyRuntime((s) => s.selectedJointId);
  const jointTool = useAssemblyRuntime((s) => s.jointTool);
  const motionSetup = useAssemblyRuntime((s) => s.motionSetup);
  const exploded = useAssemblyRuntime((s) => s.exploded);
  const explodeOverrides = useAssemblyRuntime((s) => s.explodeOverrides);
  return useMemo(() => {
    if (!active || !document) return null;
    const representations = document.derived.bodyRepresentations;
    // Live: the body is built and no later boolean consumed it.
    const isLive = (bodyId: BodyId) => {
      const representation = representations[bodyId];
      return !!representation && !representation.consumed;
    };
    return buildAssemblyView(
      document,
      {
        overrides,
        drivers,
        placementOverrides,
        selectedJointId,
        jointTool,
        motionSetup,
        exploded,
        explodeOverrides
      },
      isLive
    );
  }, [
    active,
    document,
    overrides,
    drivers,
    placementOverrides,
    selectedJointId,
    jointTool,
    motionSetup,
    exploded,
    explodeOverrides
  ]);
}
