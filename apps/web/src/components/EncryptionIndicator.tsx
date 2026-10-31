import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
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

const ENCRYPTED_SENTENCE = 'Encrypted on this device before it is saved.';

interface Presentation {
  /** The accessible name; the verified one is the shelf badge's. */
  name: string;
  /** One or two words, coloured by state. */
  status: string;
  text: string;
  /** A secondary detail line under the text, if any. */
  detail?: string;
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
        status: 'Verified',
        text: `${ENCRYPTED_SENTENCE} This version is signed by one of your devices and is no older than one this browser has seen.`
      };
    case 'warning': {
      const warning = status.warning;
      return {
        name: `${ENCRYPTED_LABEL} · verification warning`,
        status: 'Verification warning',
        text: 'This version passed verification but is older than the project’s last activity. This browser has not opened the project before, so it cannot tell whether a newer version was left out.',
        ...(warning
          ? {
              detail: `Signed ${formatInstant(warning.signedAt)} · last activity ${formatInstant(warning.updatedAt)}`
            }
          : {})
      };
    }
    case 'locked':
      return {
        name: `${ENCRYPTED_LABEL} · encryption locked`,
        status: 'Locked on this device',
        text: UNLOCK_SENTENCE
      };
    case 'problem': {
      const problem = status.problem;
      const failed = problem !== undefined;
      return {
        name: `${ENCRYPTED_LABEL} · ${failed ? 'verification failed' : 'repair needed'}`,
        status: failed ? 'Verification failed' : 'Repair needed',
        text: [
          ...(problem !== undefined ? [problem] : []),
          ...(needsRepair ? [REPAIR_SENTENCE] : [])
        ].join(' ')
      };
    }
    default:
      return {
        name: `${ENCRYPTED_LABEL} · not verified yet`,
        status: 'Not verified yet',
        text: `${ENCRYPTED_SENTENCE} Nothing is verified until this page opens or saves a version.`
      };
  }
}

type Shackle = 'open' | 'closed' | 'keyhole';

/** Shut once a version is verified; open while nothing vouches for it yet. */
function shackleOf(state: EncryptionStatusState): Shackle {
  switch (state) {
    case 'verified':
      return 'closed';
    case 'locked':
      return 'keyhole';
    default:
      return 'open';
  }
}

/**
 * Lucide's lock, drawn here so one shape can change state: the shackle
 * swings open about its right leg and back, and the keyhole fades in while
 * this device's keys are locked.
 */
function Padlock({ size, shackle }: { size: number; shackle: Shackle }) {
  return (
    <svg
      className={`padlock is-${shackle}`}
      data-shackle={shackle}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path className="padlock-shackle" d="M7 11V7a5 5 0 0 1 10 0v4" />
      <circle className="padlock-keyhole" cx="12" cy="16" r="1" />
    </svg>
  );
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
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

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

  const icon = (size: number) =>
    state === 'problem' ? (
      <ShieldAlert size={size} aria-hidden="true" />
    ) : (
      <Padlock size={size} shackle={shackleOf(state)} />
    );

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
        title={presentation.name}
      >
        {icon(13)}
      </summary>
      <div className="topbar-menu-panel encryption-menu-panel">
        <div className="encryption-menu-head">
          <span className="encryption-menu-icon" aria-hidden="true">
            {icon(14)}
          </span>
          <strong className="encryption-menu-title">{ENCRYPTED_LABEL}</strong>
          <span className="encryption-menu-status">{presentation.status}</span>
        </div>
        {presentation.text ? (
          <p className="encryption-menu-text">{presentation.text}</p>
        ) : null}
        {presentation.detail ? (
          <p className="encryption-menu-detail">{presentation.detail}</p>
        ) : null}
        {projectStateCode ? (
          <div className="encryption-menu-code">
            <div className="encryption-menu-code-head">
              <span>Project state code</span>
              <button
                type="button"
                className="encryption-menu-copy"
                aria-label={
                  copied
                    ? 'Copied project state code'
                    : 'Copy project state code'
                }
                title="Copy"
                onClick={() => {
                  void (async () => {
                    try {
                      await navigator.clipboard.writeText(projectStateCode);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  })();
                }}
              >
                {copied ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
              </button>
            </div>
            {/* Shown at full length: people compare it by eye (ADR-024). */}
            <code>{projectStateCode}</code>
            <small>
              Matches a collaborator’s code when you both see the same saved
              version.
            </small>
          </div>
        ) : null}
        <button
          type="button"
          className="topbar-menu-item encryption-menu-settings"
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
          <span>Encryption settings</span>
        </button>
      </div>
    </details>
  );
}
