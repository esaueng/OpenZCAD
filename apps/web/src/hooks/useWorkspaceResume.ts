import { useEffect, useRef, useState } from 'react';
import {
  parseWorkspaceResumeState,
  type ProjectWorkspaceSession,
  type WorkspaceResumeState
} from '@openzcad/shared';
import {
  resumeCandidate,
  workspaceDeviceId,
  workspaceSessionApi,
  workspaceResumeFailure,
  type WorkspaceResumeFailure
} from '../lib/workspaceResume';

interface Options {
  projectId: string | null;
  userId: string | null;
  documentVersion: number;
  synced: boolean;
  getState(): WorkspaceResumeState | null;
  applyState(state: WorkspaceResumeState): void;
  resetView(): void;
}

/** Workspace snapshots follow deliberate activity, never remote camera updates or idle heartbeats. */
export function useWorkspaceResume(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [candidate, setCandidate] = useState<ProjectWorkspaceSession | null>(
    null
  );
  const [status, setStatus] = useState<'saved' | 'pending' | 'failed' | null>(
    null
  );
  const [lastFailure, setLastFailure] = useState<WorkspaceResumeFailure | null>(
    null
  );
  const wake = useRef<(() => void) | null>(null);
  const capture = useRef<(() => void) | null>(null);
  const { projectId, userId } = options;

  useEffect(() => {
    setCandidate(null);
    setStatus(null);
    setLastFailure(null);
    if (!projectId || !userId) return;
    let deviceId: string;
    try {
      deviceId = workspaceDeviceId();
    } catch {
      return;
    }
    const sessionId = crypto.randomUUID();
    let disposed = false;
    let interacted = false;
    let dirty = false;
    let awaitingDecision = false;
    let sequence = 0;
    let pending: {
      session: Omit<ProjectWorkspaceSession, 'updatedAt'>;
      key: string;
    } | null = null;
    let acknowledgedKey: string | null = null;
    let failure: WorkspaceResumeFailure | null = null;
    let syncGeneration = 0;
    let blockedOnSync: number | null = null;
    let retryDelay = 5000;
    let retryAt = 0;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const eligible = () =>
      !disposed &&
      latest.current.projectId === projectId &&
      latest.current.userId === userId;

    const flush = async () => {
      if (!eligible() || running || !pending || !latest.current.synced) return;
      if (
        failure &&
        !['network', 'server', 'document-sync'].includes(failure.kind)
      )
        return;
      if (blockedOnSync !== null && syncGeneration <= blockedOnSync) return;
      if (Date.now() < retryAt) return;
      const snapshot = pending;
      const startedSyncGeneration = syncGeneration;
      running = true;
      let acknowledged = false;
      try {
        await workspaceSessionApi.save(snapshot.session);
        if (eligible()) {
          acknowledged = true;
          acknowledgedKey = snapshot.key;
          if (pending === snapshot) pending = null;
          failure = null;
          setLastFailure(null);
          blockedOnSync = null;
          retryDelay = 5000;
          retryAt = 0;
          clearTimeout(retryTimer);
          setStatus(pending ? 'pending' : 'saved');
        }
      } catch (error) {
        if (eligible()) {
          failure = workspaceResumeFailure(error);
          setLastFailure(failure);
          setStatus('failed');
          if (failure.kind === 'document-sync') {
            // A true `synced` value from before this request is not a new
            // model acknowledgement. Wait for reconciliation, not a timer.
            blockedOnSync = startedSyncGeneration;
          } else if (failure.kind === 'network' || failure.kind === 'server') {
            retryAt = Date.now() + retryDelay;
            retryTimer = setTimeout(() => void flush(), retryDelay);
            retryDelay = Math.min(retryDelay * 2, 60_000);
          }
        }
      } finally {
        running = false;
        // Activity during a request must not strand its newer snapshot. A
        // model acknowledgement may also have arrived during a fenced PUT.
        if (
          acknowledged ||
          (blockedOnSync !== null && syncGeneration > blockedOnSync)
        )
          void flush();
      }
    };
    const save = () => {
      if (!eligible() || !interacted || awaitingDecision || !dirty) return;
      const state = parseWorkspaceResumeState(latest.current.getState());
      if (!state) return;
      dirty = false;
      const documentVersion = latest.current.documentVersion;
      const key = JSON.stringify({
        documentVersion,
        state: {
          ...state,
          hiddenBodyIds: [...new Set(state.hiddenBodyIds)].sort(),
          selectedBodyIds: [...new Set(state.selectedBodyIds)].sort()
        }
      });
      if (key === pending?.key) return;
      if (!running && key === acknowledgedKey) {
        pending = null;
        setStatus(failure ? 'failed' : 'saved');
        return;
      }
      pending = {
        key,
        session: {
          schemaVersion: 1,
          projectId,
          deviceId,
          sessionId,
          sequence: ++sequence,
          documentVersion,
          deviceLabel: matchMedia('(pointer: coarse)').matches
            ? 'Mobile'
            : 'Desktop',
          state
        }
      };
      setStatus(failure ? 'failed' : 'pending');
      void flush();
    };
    const activity = () => {
      if (!eligible() || awaitingDecision) return;
      interacted = true;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(save, 1500);
    };
    const leave = () => {
      clearTimeout(timer);
      save();
    };
    capture.current = () => {
      if (!awaitingDecision) {
        activity();
        return;
      }
      awaitingDecision = false;
      activity();
    };
    let lookupStarted = false;
    const load = () => {
      if (!eligible() || interacted || lookupStarted || !latest.current.synced)
        return;
      lookupStarted = true;
      void workspaceSessionApi
        .load(projectId)
        .then((sessions) => {
          if (!eligible() || interacted) return;
          const remote = resumeCandidate(
            sessions,
            projectId,
            deviceId,
            latest.current.documentVersion
          );
          if (remote) {
            awaitingDecision = true;
            setCandidate(remote);
          }
        })
        .catch(() => {
          /* Session metadata must never prevent opening a project. */
        });
    };
    wake.current = () => {
      if (latest.current.synced) syncGeneration++;
      load();
      void flush();
    };
    load();
    window.addEventListener('pointerup', activity);
    window.addEventListener('keyup', activity);
    window.addEventListener('wheel', activity, { passive: true });
    window.addEventListener('pagehide', leave);
    return () => {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      window.removeEventListener('pointerup', activity);
      window.removeEventListener('keyup', activity);
      window.removeEventListener('wheel', activity);
      window.removeEventListener('pagehide', leave);
      disposed = true;
      capture.current = null;
      wake.current = null;
    };
  }, [projectId, userId]);

  useEffect(() => {
    wake.current?.();
  }, [options.synced]);

  return {
    candidate,
    status,
    lastFailure,
    choose(resume: boolean) {
      if (candidate?.projectId !== latest.current.projectId) return;
      if (resume && candidate) latest.current.applyState(candidate.state);
      else latest.current.resetView();
      setCandidate(null);
      capture.current?.();
    }
  };
}
