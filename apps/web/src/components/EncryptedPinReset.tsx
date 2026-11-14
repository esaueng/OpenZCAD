import { useRef, useState, useSyncExternalStore } from 'react';
import { LockOpen, TriangleAlert } from 'lucide-react';
import {
  encryptedPinsRevision,
  encryptedProjectPinsUnavailable,
  formatMismatchedProjects,
  resetEncryptedProjectPins,
  subscribeEncryptedPins,
  treatProjectAsNotEncrypted,
  type EncryptedPinProblem
} from '../lib/api';
import { useModalFocus } from '../lib/useModalFocus';
import { Group, Notice, SettingRow } from './settingsControls';

/**
 * "Treat as not encrypted on this device" (PR #1418's confirmed reset):
 * the one way out of a stuck encrypted-project pin besides finishing the
 * switch. Only the owner's confirmation here triggers it, never the
 * account's word (`api.ts`, `encryptedProjectPins.ts`).
 */

/** Re-renders when this device's encrypted-project pins change. */
export function useEncryptedPins(): number {
  return useSyncExternalStore(
    subscribeEncryptedPins,
    encryptedPinsRevision,
    encryptedPinsRevision
  );
}

export type PinResetTarget =
  | {
      readonly kind: 'project';
      readonly projectId: string;
      readonly name: string | null;
      readonly reason: EncryptedPinProblem;
    }
  /** The whole store, after a pin could not be saved. */
  | { readonly kind: 'device' };

const OWNER = { confirmedByOwner: true } as const;

function copyOf(target: PinResetTarget) {
  if (target.kind === 'device') {
    return {
      title: 'Stop treating every project as encrypted?',
      body: 'This device couldn’t save its list of encrypted projects, so it treats every project as encrypted. Resetting keeps every project already on the list. A project missing from it follows your account: it is added back as soon as your account lists it as encrypted. Allow site storage and free up space first, or this happens again.',
      understood:
        'I understand a project missing from this device’s list follows what my account says.',
      action: 'Reset the list',
      keep: 'Keep everything encrypted'
    };
  }
  const name = target.name ?? 'this project';
  return {
    title: 'Treat as not encrypted on this device?',
    body:
      target.reason === 'unresolved'
        ? `The switch to end-to-end encryption didn’t finish on this device, so it keeps ${name} encrypted. Only reset this if encrypting it failed. This device then follows your account: if it lists the project as not encrypted, your changes are saved readable by the server. Retrying the encryption is safer.`
        : `This device keeps ${name} encrypted, but your account lists it as not encrypted. Only reset this if you stopped encrypting it on another device. This device then follows your account, and your changes are saved readable by the server.`,
    understood:
      'I understand this project’s changes may be saved without end-to-end encryption.',
    action: 'Treat as not encrypted',
    keep: 'Keep it encrypted'
  };
}

/** Plain words for what a stuck project's problem is. */
export function pinProblemText(reason: EncryptedPinProblem): string {
  return reason === 'unresolved'
    ? 'The switch to end-to-end encryption didn’t finish on this device.'
    : 'Your account lists it as not encrypted, but this device keeps it encrypted.';
}

/**
 * The confirmation itself, inline where the problem is shown (a row in
 * Settings › Encryption) or inside {@link PinResetDialog}: the reset stays
 * disabled until the owner ticks that they understand.
 */
export function PinResetConfirm({
  target,
  onConfirm,
  onCancel,
  titleId
}: {
  target: PinResetTarget;
  /** Runs the confirmed reset. */
  onConfirm: () => void;
  onCancel: () => void;
  titleId?: string;
}) {
  const [understood, setUnderstood] = useState(false);
  const copy = copyOf(target);
  return (
    <div
      className="encryption-reverse-confirm"
      role="group"
      aria-label={copy.title}
    >
      {titleId ? null : <strong>{copy.title}</strong>}
      <p>{copy.body}</p>
      <label>
        <input
          type="checkbox"
          checked={understood}
          onChange={(event) => setUnderstood(event.target.checked)}
        />
        {copy.understood}
      </label>
      <span className="encryption-actions">
        <button
          className="danger-ghost"
          type="button"
          disabled={!understood}
          onClick={() => {
            if (!understood) return;
            setUnderstood(false);
            onConfirm();
          }}
        >
          <LockOpen size={13} aria-hidden="true" />
          {copy.action}
        </button>
        <button
          className="secondary"
          type="button"
          onClick={() => {
            setUnderstood(false);
            onCancel();
          }}
        >
          {copy.keep}
        </button>
      </span>
    </div>
  );
}

/**
 * Runs a confirmed reset and says what came of it. The account is never
 * asked: the reset is this device's own.
 */
export function runPinReset(target: PinResetTarget): {
  ok: boolean;
  message: string;
} {
  if (target.kind === 'device') {
    return resetEncryptedProjectPins(OWNER)
      ? {
          ok: true,
          message:
            'This device’s list of encrypted projects works again. Reload any other OpenZCAD tabs.'
        }
      : {
          ok: false,
          message:
            'Site storage is still blocked or full, so nothing changed. Allow site storage and free up space, then try again.'
        };
  }
  treatProjectAsNotEncrypted(target.projectId, OWNER);
  return {
    ok: true,
    message: `${target.name ?? 'The project'} now follows your account on this device.`
  };
}

/**
 * The same confirmation as a dialog, for where a stuck project is met
 * outside Settings: the editor's notice and the save error's toast.
 */
export function PinResetDialog({
  target,
  onClose,
  onReset
}: {
  target: PinResetTarget;
  onClose: () => void;
  /** After the reset ran, with what came of it. */
  onReset: (result: { ok: boolean; message: string }) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { autoFocus: true });
  const copy = copyOf(target);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="pin-reset-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-reset-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header>
          <TriangleAlert size={18} aria-hidden="true" />
          <h2 id="pin-reset-title">{copy.title}</h2>
        </header>
        <PinResetConfirm
          target={target}
          titleId="pin-reset-title"
          onCancel={onClose}
          onConfirm={() => onReset(runPinReset(target))}
        />
      </div>
    </div>
  );
}

/**
 * Settings › Encryption › "On this device": a pin store that could not
 * save, and projects whose listing disagrees with this device's pin, each
 * with its confirmed reset. A switch to encryption that did not finish is
 * offered on its row under "Encrypt existing projects".
 */
export function EncryptedPinRecovery() {
  useEncryptedPins();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    tone: 'success' | 'warning';
    text: string;
  } | null>(null);
  const degraded = encryptedProjectPinsUnavailable();
  const mismatched = formatMismatchedProjects();
  if (!degraded && !mismatched.length && !message) return null;
  const reset = (target: PinResetTarget) => {
    const result = runPinReset(target);
    setConfirming(null);
    setMessage({
      tone: result.ok ? 'success' : 'warning',
      text: result.message
    });
  };
  return (
    <Group title="On this device">
      {message ? (
        <Notice tone={message.tone} role="status">
          {message.text}
        </Notice>
      ) : null}
      {degraded ? (
        <div className="encryption-migration-item">
          <SettingRow
            title="Every project is treated as encrypted"
            hint="This device couldn’t save its list of encrypted projects, so nothing was sent without encryption."
          >
            {confirming === 'device' ? null : (
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setMessage(null);
                  setConfirming('device');
                }}
              >
                <LockOpen size={13} aria-hidden="true" />
                Stop treating every project as encrypted
              </button>
            )}
          </SettingRow>
          {confirming === 'device' ? (
            <PinResetConfirm
              target={{ kind: 'device' }}
              onCancel={() => setConfirming(null)}
              onConfirm={() => reset({ kind: 'device' })}
            />
          ) : null}
        </div>
      ) : null}
      {degraded
        ? null
        : mismatched.map(({ projectId, name }) => {
            const target: PinResetTarget = {
              kind: 'project',
              projectId,
              name,
              reason: 'mismatch'
            };
            return (
              <div
                key={projectId}
                className="encryption-migration-item"
                role="group"
                aria-label={name ?? 'A project'}
              >
                <SettingRow
                  title={name ?? 'A project'}
                  hint={pinProblemText('mismatch')}
                >
                  {confirming === projectId ? null : (
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => {
                        setMessage(null);
                        setConfirming(projectId);
                      }}
                    >
                      <LockOpen size={13} aria-hidden="true" />
                      Treat as not encrypted on this device
                    </button>
                  )}
                </SettingRow>
                {confirming === projectId ? (
                  <PinResetConfirm
                    target={target}
                    onCancel={() => setConfirming(null)}
                    onConfirm={() => reset(target)}
                  />
                ) : null}
              </div>
            );
          })}
    </Group>
  );
}
