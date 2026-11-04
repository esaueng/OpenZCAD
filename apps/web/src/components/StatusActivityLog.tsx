import { useEffect, useRef } from 'react';
import {
  lastActivity,
  recordActivity,
  setActivityContext
} from '../lib/activityLog';

export type StatusTone = 'ready' | 'warning' | 'running';

interface StatusActivityLogProps {
  status: string;
  detail?: string;
  /**
   * False for a lane-only message — a workspace switch says where the user
   * is, which the log, a record of what happened to the model, leaves out.
   */
  logged?: boolean;
  /**
   * The exact-geometry line while the model is not ready. Logged as entries
   * of its own: when it stood in for the status, a message set meanwhile
   * never reached the log at all.
   */
  geometryStatus?: string | null;
  tone: StatusTone;
  /** Where the user is, stamped on every entry recorded from here on. */
  workspace?: string;
  project?: string;
}

/**
 * Records the status line into the session's activity log (lib/activityLog).
 * It draws nothing: the log is read in Settings › Activity log.
 */
export function StatusActivityLog({
  status,
  detail,
  logged = true,
  geometryStatus = null,
  tone,
  workspace,
  project
}: StatusActivityLogProps) {
  // Null until the first effect: what was showing when this mounted.
  const previousRef = useRef<{
    status: string;
    detail: string | undefined;
    tone: StatusTone;
    geometryStatus: string | null;
  } | null>(null);

  // Before the entries below, so they carry where they happened.
  useEffect(() => {
    setActivityContext({
      ...(workspace ? { workspace } : {}),
      ...(project ? { project } : {})
    });
  }, [project, workspace]);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { status, detail, tone, geometryStatus };
    let logStatus: boolean;
    if (previous === null) {
      // A remount (start screen to workspace and back) carries the same
      // line over; it is not news a second time.
      const last = lastActivity('status');
      logStatus =
        logged && (last?.message !== status || last.detail !== detail);
    } else {
      // A tone change alone is news only for the message it colours; while
      // the geometry line comes or goes, the tone is following that instead.
      logStatus =
        logged &&
        (previous.status !== status ||
          previous.detail !== detail ||
          (previous.tone !== tone &&
            geometryStatus === null &&
            previous.geometryStatus === null));
    }
    if (logStatus) {
      recordActivity({
        level: tone,
        source: 'status',
        message: status,
        ...(detail ? { detail } : {})
      });
    }
    if (geometryStatus && geometryStatus !== previous?.geometryStatus) {
      recordActivity({
        level: tone,
        source: 'geometry',
        message: geometryStatus
      });
    }
  }, [detail, geometryStatus, logged, status, tone]);

  return null;
}
