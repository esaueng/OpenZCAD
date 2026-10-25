import { useEffect, useRef } from 'react';
import {
  KeyRound,
  Lock,
  Settings as SettingsIcon,
  ShieldAlert
} from 'lucide-react';
import type {
  EncryptionStatus,
  EncryptionStatusState
} from '../lib/e2ee/encryptionStatus';

export interface EncryptionIndicatorProps {
  /** What the encrypted-project store reported for this project. */
  status: EncryptionStatus;
  /**
   * The account copy needs repair and autosave waits (the save state
   * `repair`): shown as a problem whatever the store last reported.
   */
  needsRepair?: boolean;
  /** Opens Settings › Encryption. */
  onOpenEncryptionSettings(): void;
  /**
   * The project state code people compare outside OpenZCAD (ADR-024,
   * Phase 5). Absent until a build derives one; shown in full when given.
   */
  projectStateCode?: string | null;
}

/** The shelf badge's own words (`StartScreen.tsx`). */
export const ENCRYPTED_LABEL = 'End-to-end encrypted';

/** The keys-locked refusal's own words (`encryptedProjects.ts`). */
const UNLOCK_SENTENCE =
  'Unlock encryption on this device (Settings › Encryption) to open or save encrypted projects.';

/** The repair save state's own words (`App.tsx`). */
const REPAIR_SENTENCE =
  'The account copy needs repair. Your work remains saved on this device; click Repair needed to retry.';

const ENCRYPTED_SENTENCE =
  'This project’s contents are encrypted on this device before they are saved.';

interface Presentation {
  /** The accessible name; the verified one is the shelf badge's. */
  name: string;
  title: string;
  heading: string;
  body: readonly string[];
}

function formatInstant(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function presentationOf(
  state: EncryptionStatusState,
  status: EncryptionStatus,
  needsRepair: boolean
): Presentation {
  switch (state) {
    case 'verified':
      return {
        name: ENCRYPTED_LABEL,
        title: `${ENCRYPTED_LABEL}. This project’s contents are encrypted on this device, and the version this page last opened or saved passed verification.`,
        heading: 'Verified',
        body: [
          ENCRYPTED_SENTENCE,
          'The version this page last opened or saved is signed by one of your devices and does not move this browser back from a version it has already seen.'
        ]
      };
    case 'warning': {
      const warning = status.warning;
      return {
        name: `${ENCRYPTED_LABEL} · verification warning`,
        title: `${ENCRYPTED_LABEL}. The version the account sent is older than the project’s last recorded activity.`,
        heading: 'Verification warning',
        body: [
          'The version the account sent passed verification, but it was signed earlier than the project’s last recorded activity. This browser had not opened the project before, so it cannot tell whether a newer version was left out.',
          ...(warning
            ? [
                `Signed ${formatInstant(warning.signedAt)} · last activity ${formatInstant(warning.updatedAt)}.`
              ]
            : [])
        ]
      };
    }
    case 'locked':
      return {
        name: `${ENCRYPTED_LABEL} · encryption locked`,
        title: `${ENCRYPTED_LABEL}. ${UNLOCK_SENTENCE}`,
        heading: 'Encryption locked on this device',
        body: [UNLOCK_SENTENCE]
      };
    case 'problem': {
      const problem = status.problem;
      const failed = problem !== undefined;
      return {
        name: `${ENCRYPTED_LABEL} · ${failed ? 'verification failed' : 'repair needed'}`,
        title: `${ENCRYPTED_LABEL}. ${failed ? 'A version of this project did not pass verification.' : REPAIR_SENTENCE}`,
        heading: failed ? 'Verification failed' : 'Repair needed',
        body: [
          ...(problem !== undefined ? [problem] : []),
          ...(needsRepair ? [REPAIR_SENTENCE] : [])
        ]
      };
    }
    default:
      return {
        name: `${ENCRYPTED_LABEL} · not verified yet`,
        title: `${ENCRYPTED_LABEL}. This page has not opened or saved a version of this project yet.`,
        heading: 'Not verified yet',
        body: [
          ENCRYPTED_SENTENCE,
          'This page has not opened or saved a version of it yet, so nothing has been verified.'
        ]
      };
  }
}

/**
 * The editor's at-a-glance encryption status for an end-to-end encrypted
 * project (ADR-024 Phase 4): a lock beside the project name that opens a
 * short explanation and a way to Settings › Encryption. Plaintext projects
 * never render it.
 */
export function EncryptionIndicator({
  status,
  needsRepair = false,
  onOpenEncryptionSettings,
  projectStateCode = null
}: EncryptionIndicatorProps) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const state: EncryptionStatusState = needsRepair ? 'problem' : status.state;
  const presentation = presentationOf(state, status, needsRepair);

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      const menu = menuRef.current;
      if (
        menu?.open &&
        event.target instanceof Node &&
        !menu.contains(event.target)
      ) {
        menu.open = false;
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      const menu = menuRef.current;
      if (event.key !== 'Escape' || !menu?.open) return;
      event.stopPropagation();
      menu.open = false;
      if (menu.contains(document.activeElement)) {
        menu.querySelector('summary')?.focus();
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    // Capture, as the File menu does: Escape closes this before the
    // workspace clears its selection.
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, []);

  const Icon =
    state === 'locked' ? KeyRound : state === 'problem' ? ShieldAlert : Lock;

  return (
    <details
      ref={menuRef}
      className={`topbar-menu encryption-menu is-${state}`}
      data-encryption-state={state}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) {
          event.currentTarget.open = false;
        }
      }}
    >
      <summary
        className="encryption-indicator"
        aria-label={presentation.name}
        title={presentation.title}
      >
        <Icon size={13} aria-hidden="true" />
      </summary>
      <div className="topbar-menu-panel encryption-menu-panel">
        <strong className="topbar-menu-label">
          <Lock size={12} aria-hidden="true" />
          {ENCRYPTED_LABEL}
        </strong>
        <p className="encryption-menu-heading">{presentation.heading}</p>
        {presentation.body.map((sentence) => (
          <p key={sentence} className="encryption-menu-text">
            {sentence}
          </p>
        ))}
        {projectStateCode ? (
          <div className="encryption-menu-code">
            <span className="topbar-menu-label">Project state code</span>
            <code>{projectStateCode}</code>
          </div>
        ) : null}
        <div className="topbar-menu-sep" />
        <button
          type="button"
          className="topbar-menu-item"
          onClick={() => {
            const menu = menuRef.current;
            if (menu) {
              menu.querySelector('summary')?.focus();
              menu.open = false;
            }
            onOpenEncryptionSettings();
          }}
        >
          <SettingsIcon size={13} aria-hidden="true" />
          <span>Open Settings › Encryption</span>
        </button>
      </div>
    </details>
  );
}
