import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectDocument } from '@openzcad/shared';
import type { AutoFrameRequest } from '../lib/autoFrame';

/** A local commit owns its fit request only until the document is replaced. */
export function useLocalAutoFrame(
  document: ProjectDocument | null,
  exactGeometryReady: boolean,
  previewing: boolean
) {
  const baseline = useRef<{
    projectId: string;
    version: number;
    before: ProjectDocument['derived']['bodyRepresentations'];
  } | null>(null);
  const [autoFrame, setAutoFrame] = useState<AutoFrameRequest | null>(null);
  const recordLocalCommit = useCallback(
    (
      next: ProjectDocument,
      before: ProjectDocument['derived']['bodyRepresentations']
    ) => {
      baseline.current = {
        projectId: next.projectId,
        version: next.version,
        before
      };
    },
    []
  );
  const clearAutoFrame = useCallback(() => {
    // Cancel synchronously: a pending rebuild effect must see the replacement
    // even before React publishes its document and queued-request updates.
    baseline.current = null;
    setAutoFrame(null);
  }, []);
  const representations = document?.derived.bodyRepresentations;
  const projectId = document?.projectId;
  const version = document?.version;
  useEffect(() => {
    const pending = baseline.current;
    if (
      !pending ||
      !representations ||
      version === undefined ||
      !exactGeometryReady ||
      previewing ||
      representations === pending.before
    ) {
      return;
    }
    if (projectId === pending.projectId && version < pending.version) {
      return;
    }
    baseline.current = null;
    if (projectId === pending.projectId) {
      // Topology-reference normalization can advance the local version after
      // its rebuild without changing geometry. Replacements cancel above,
      // so that newer local result still belongs to this commit.
      setAutoFrame({ before: pending.before, after: representations });
    }
  }, [representations, projectId, version, exactGeometryReady, previewing]);
  return { autoFrame, recordLocalCommit, clearAutoFrame };
}
