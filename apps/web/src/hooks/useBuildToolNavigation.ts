import { useEffect, useRef, useState } from 'react';
import type { ToolId } from '../lib/tools';

/** An explicit search choice may cross modes; project permissions still win. */
export function useBuildToolNavigation({
  mode,
  projectId,
  canBuild,
  onSwitch,
  onLaunch
}: {
  mode: string;
  projectId: string | null;
  canBuild: boolean;
  onSwitch(): void;
  onLaunch(tool: ToolId): void;
}) {
  const launch = useRef(onLaunch);
  launch.current = onLaunch;
  const [pending, setPending] = useState<{
    projectId: string;
    tool: ToolId;
    fromMode: string;
  } | null>(null);

  useEffect(() => {
    if (!pending) return;
    if (
      !canBuild ||
      pending.projectId !== projectId ||
      (mode !== 'build' && mode !== pending.fromMode)
    ) {
      setPending(null);
    } else if (mode === 'build') {
      // Launch only after the new mode's edit guards and availability render.
      setPending(null);
      launch.current(pending.tool);
    } else {
      // A refused switch must not arm a tool for a later, unrelated visit.
      const timeout = setTimeout(
        () => setPending((current) => (current === pending ? null : current)),
        1000
      );
      return () => clearTimeout(timeout);
    }
  }, [canBuild, mode, pending, projectId]);

  return (tool: ToolId) => {
    if (!canBuild || !projectId) return;
    if (mode === 'build') {
      onLaunch(tool);
    } else {
      setPending({ projectId, tool, fromMode: mode });
      onSwitch();
    }
  };
}
