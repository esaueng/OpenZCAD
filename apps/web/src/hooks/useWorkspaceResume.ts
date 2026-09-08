import { useEffect, useRef, useState } from 'react';
import type {
  ProjectWorkspaceSession,
  WorkspaceResumeState
} from '@openzcad/shared';
import {
  resumeCandidate,
  workspaceDeviceId,
  workspaceSessionApi
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
  const [status, setStatus] = useState<'saved' | 'pending' | 'offline' | null>(
    null
  );
  const wake = useRef<(() => void) | null>(null);
  const capture = useRef<(() => void) | null>(null);
  const { projectId, userId } = options;

  useEffect(() => {
    setCandidate(null);
    setStatus(null);
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
    let pending: Omit<ProjectWorkspaceSession, 'updatedAt'> | null = null;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const eligible = () =>
      !disposed &&
      latest.current.projectId === projectId &&
      latest.current.userId === userId;

    const flush = async () => {
      if (!eligible() || running || !pending || !latest.current.synced) return;
      const snapshot = pending;
      running = true;
      try {
        await workspaceSessionApi.save(snapshot);
        if (eligible()) {
          if (pending === snapshot) pending = null;
          setStatus(pending ? 'pending' : 'saved');
        }
      } catch {
        if (eligible()) setStatus('offline');
      } finally {
        running = false;
      }
    };
    const save = () => {
      if (!eligible() || !interacted || awaitingDecision || !dirty) return;
      const state = latest.current.getState();
      if (!state) return;
      dirty = false;
      pending = {
        schemaVersion: 1,
        projectId,
        deviceId,
        sessionId,
        sequence: ++sequence,
        documentVersion: latest.current.documentVersion,
        deviceLabel: matchMedia('(pointer: coarse)').matches
          ? 'Mobile'
          : 'Desktop',
        state
      };
      setStatus('pending');
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
      load();
      void flush();
    };
    load();
    const retry = setInterval(() => {
      load();
      void flush();
    }, 5000);
    window.addEventListener('pointerup', activity);
    window.addEventListener('keyup', activity);
    window.addEventListener('wheel', activity, { passive: true });
    window.addEventListener('pagehide', leave);
    return () => {
      clearTimeout(timer);
      clearInterval(retry);
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
    choose(resume: boolean) {
      if (candidate?.projectId !== latest.current.projectId) return;
      if (resume && candidate) latest.current.applyState(candidate.state);
      else latest.current.resetView();
      setCandidate(null);
      capture.current?.();
    }
  };
}
