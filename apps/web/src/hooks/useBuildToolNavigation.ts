import { useEffect, useRef, useState } from 'react';
import type { ToolId } from '../lib/tools';

/** An explicit search choice may cross modes; project permissions still win. */
export function useBuildToolNavigation({
  mode,
  projectId,
  canBuild,
  onSwitch,
  onLaunch,
  onPrepare,
  onExpired
}: {
  mode: string;
  projectId: string | null;
  canBuild: boolean;
  onSwitch(): void;
  onLaunch(tool: ToolId): void;
  /** Frame the newly rendered workspace before the tool owns its camera. */
  onPrepare?(): void;
  onExpired?(): void;
}) {
  const callbacks = useRef({ onLaunch, onPrepare, onExpired });
  callbacks.current = { onLaunch, onPrepare, onExpired };
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
      // First render and frame the destination; then let the tool take over.
      // Launching in this effect skipped responsive framing under the new
      // tool's camera guard, leaving the model behind Build's panels.
      let launchFrame = 0;
      const prepareFrame = requestAnimationFrame(() => {
        callbacks.current.onPrepare?.();
        launchFrame = requestAnimationFrame(() => {
          setPending(null);
          callbacks.current.onLaunch(pending.tool);
        });
      });
      return () => {
        cancelAnimationFrame(prepareFrame);
        cancelAnimationFrame(launchFrame);
      };
    } else {
      // A refused switch must not arm a tool for a later, unrelated visit.
      const timeout = setTimeout(() => {
        setPending((current) => (current === pending ? null : current));
        callbacks.current.onExpired?.();
      }, 1000);
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
