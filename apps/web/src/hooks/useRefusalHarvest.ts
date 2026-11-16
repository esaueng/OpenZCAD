import { useEffect, useRef, useState } from 'react';
import type { FeatureWarning, ProjectDocument } from '@openzcad/shared';
import type { GeometryWorkerApi } from './useGeometryWorker';
import type { KernelRefusalObservation } from '../lib/analytics';
import type { RefusalCapture, RefusalHarvester } from '../lib/refusalHarvest';
import { splitRefusal } from '../lib/featureValidation';
import type { CommandDiagnostic } from '../lib/interaction/machine';

interface OwnedCapture {
  capture: RefusalCapture;
  owner: string;
  projectId: string;
  version: number;
}

/** Only explicit user edit checks enter here; background rebuilds use syncOnce. */
export function useRefusalHarvest(options: {
  document: ProjectDocument | null;
  currentDocument(): ProjectDocument | null | undefined;
  warnings: readonly FeatureWarning[];
  rebuild: GeometryWorkerApi['syncOnce'];
  track(observation: KernelRefusalObservation): void;
}) {
  const live = useRef(options);
  live.current = options;
  const [held, setHeld] = useState<OwnedCapture | null>(null);
  const heldRef = useRef<OwnedCapture | null>(null);
  const request = useRef({ generation: 0 });
  // The harvester loads in its own chunk, off the launcher's entry chunk.
  // It is asked for on mount, so it is there long before the first edit
  // check; a chunk that fails to load is asked for again by the next check,
  // and until then checks go unobserved rather than fail.
  const harvesterRef = useRef<RefusalHarvester | null>(null);
  const loading = useRef<Promise<RefusalHarvester | null> | null>(null);
  function loadHarvester() {
    return (loading.current ??= import('../lib/refusalHarvest').then(
      ({ createRefusalHarvester }) =>
        (harvesterRef.current ??= createRefusalHarvester({
          track: (value) => live.current.track(value)
        })),
      () => {
        loading.current = null;
        return null;
      }
    ));
  }
  useEffect(() => {
    void loadHarvester();
  }, []);
  const projectId = options.document?.projectId;
  const version = options.document?.version;
  useEffect(() => {
    const pending = request.current;
    ++pending.generation;
    harvesterRef.current?.clear();
    heldRef.current = null;
    setHeld(null);
    // A commit or project switch ends the attempt, including pending replies.
    return () => {
      ++pending.generation;
    };
  }, [projectId, version]);

  async function syncFor(
    owner: string,
    ...args: Parameters<GeometryWorkerApi['syncOnce']>
  ) {
    const base = live.current.currentDocument();
    if (!base || args[0].projectId !== base.projectId)
      return live.current.rebuild(...args);
    const baseline = {
      featureWarnings: live.current.warnings,
      derived: base.derived
    };
    const token = ++request.current.generation;
    heldRef.current = null;
    setHeld(null);
    const harvesterReady = loadHarvester();
    const derived = await live.current.rebuild(...args);
    const harvester = harvesterRef.current ?? (await harvesterReady);
    const current = live.current.currentDocument();
    if (
      !harvester ||
      token !== request.current.generation ||
      !current ||
      current.projectId !== base.projectId ||
      current.version !== base.version
    )
      return derived;
    try {
      const capture = harvester.observe(args[0], derived, baseline);
      const next = capture
        ? {
            capture,
            owner,
            projectId: base.projectId,
            version: base.version
          }
        : null;
      heldRef.current = next;
      setHeld(next);
    } catch {
      // Diagnostics must never fail the edit they observe.
    }
    return derived;
  }

  /** Match the displayed refusal as well as its editing surface and project. */
  function captureFor(
    owner: string,
    diagnostic?: string | CommandDiagnostic | null
  ) {
    const record = heldRef.current;
    const current = live.current.currentDocument();
    if (
      !record ||
      !current ||
      record.owner !== owner ||
      record.projectId !== current.projectId ||
      record.version !== current.version ||
      record.capture.document.projectId !== current.projectId ||
      !diagnostic
    )
      return null;
    const warning = record.capture.warning;
    if (typeof diagnostic === 'string')
      return diagnostic === warning.message ? record.capture : null;
    const plain = splitRefusal(
      warning.message.replace(/^Feature "[^"]+":\s*/, '').trim(),
      warning.kernelRefusal
    );
    return diagnostic.message === plain.message &&
      diagnostic.detail === plain.detail &&
      (!diagnostic.culprit ||
        diagnostic.culprit.featureId === warning.featureId)
      ? record.capture
      : null;
  }

  return {
    // Read state so a new capture, even another refusal, refreshes its surfaces.
    held,
    captureFor,
    reproductionFor(
      owner: string,
      diagnostic: string | CommandDiagnostic | null | undefined,
      save: (capture: RefusalCapture) => void
    ): (() => void) | undefined {
      const capture = captureFor(owner, diagnostic);
      if (!capture) return undefined;
      return () => {
        if (captureFor(owner, diagnostic) === capture) save(capture);
      };
    },
    syncCandidate: ((...args) =>
      syncFor('operation', ...args)) as GeometryWorkerApi['syncOnce'],
    syncParameterCandidate: (name: string, document: ProjectDocument) =>
      syncFor(`parameter:${name}`, document)
  };
}
