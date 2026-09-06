import { useEffect, useState } from 'react';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { statusExpiresAt } from '../lib/statusLifetime';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from '../lib/workspaceSaveStatePresentation';
import type { StatusTone } from './StatusActivityLog';

interface WorkspaceReadoutProps {
  status: string;
  statusAt?: number;
  statusSticky?: boolean;
  tone: StatusTone;
  /** Context-sensitive next step, shown once the status has expired. */
  hint: string | null;
  saveState: WorkspaceSaveState;
  /** Sketch snap spacing, shown while a sketch is open; null hides it. */
  snap: { spacing: number; units: string; enabled: boolean } | null;
}

/**
 * What the status bar said, without the bar: the live message (or the hint
 * once it has expired) bottom-centre over the viewport, and the sync state
 * with the sketch snap as a one-line readout in the corner.
 */
export function WorkspaceReadout({
  status,
  statusAt,
  statusSticky,
  tone,
  hint,
  saveState,
  snap
}: WorkspaceReadoutProps) {
  // Same lifetime rule as the status bar: an informational message goes
  // quiet once it has had its time, and the hint takes the slot back.
  const expiresAt =
    statusAt === undefined
      ? null
      : statusExpiresAt({ at: statusAt, sticky: statusSticky ?? false });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) {
      return;
    }
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  const quiet = expiresAt !== null && now >= expiresAt;
  const message = quiet || status === '' ? hint : status;
  const messageTone = quiet || status === '' ? 'ready' : tone;
  const sync = WORKSPACE_SAVE_STATE_PRESENTATION[saveState];
  return (
    <div className="workspace-readout">
      {message && (
        <div
          className={`workspace-readout-hint ${messageTone}`}
          role="status"
          aria-live="polite"
        >
          {message}
        </div>
      )}
      <div className="workspace-readout-meta mono">
        {snap && (
          <span>
            {snap.enabled ? `Snap ${snap.spacing} ${snap.units}` : 'Snap off'}
          </span>
        )}
        <span className={`workspace-readout-sync ${saveState}`}>
          <i aria-hidden="true" />
          {sync.statusBarLabel}
        </span>
      </div>
    </div>
  );
}
