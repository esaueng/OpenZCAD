import { useEffect, useState, useSyncExternalStore } from 'react';
import { LockOpen, RefreshCcw, X } from 'lucide-react';
import type { E2eeConfigResponse } from '@openzcad/shared';
import { encryptsNewProjects } from '../lib/api';
import { desktopFetch } from '../lib/desktopBridge';
import {
  pageDecryptionController,
  type DecryptionController
} from '../lib/e2ee/projectDecryption';
import type { MigrationProgress } from '../lib/e2ee/projectMigrationEngine';
import { Group, Meter, Notice, SettingRow, Status } from './settingsControls';

/** Whether the Worker opens the reverse path to this account (and 0043). */
async function reverseOpen(): Promise<boolean> {
  try {
    const response = await desktopFetch('/api/e2ee/config', {
      credentials: 'same-origin'
    });
    if (!response.ok) return false;
    const config = (await response.json()) as E2eeConfigResponse;
    return config.reverseEnabled === true;
  } catch {
    return false;
  }
}

function phaseLabel(progress: MigrationProgress): string {
  switch (progress.phase) {
    case 'waiting':
      return 'End-to-end encrypted';
    case 'starting':
      return 'Starting…';
    case 'revisions':
      return 'Decrypting save states…';
    case 'head':
      return 'Decrypting the current version…';
    case 'details':
      return 'Decrypting files and details…';
    case 'checking':
      return 'Checking…';
    case 'cutover':
      return 'Switching to plaintext storage…';
    case 'purging':
      return 'Deleting the encrypted copy…';
    case 'done':
      return 'Not encrypted';
    case 'paused':
      return 'Stopped part-way';
    case 'error':
      return 'Stopped';
  }
}

/**
 * Settings › Encryption › "Stop encrypting a project" (ADR-024 Phase 7,
 * slice 7-3): the beta-only reverse path, which turns an encrypted project
 * only its owner holds back into plaintext. Shown only when the Worker opens
 * it to this account (E2EE_REVERSE_ENABLED with migration, and migration
 * 0043) and this device holds the unlocked account key. Each project asks
 * for a plain-words confirmation that its content will be stored readable
 * by the server again. Phase 8 deletes it with the flag.
 */
export function StopProjectEncryption({
  userId,
  unlocked,
  controller: injected,
  isOpen = reverseOpen,
  optedIn = encryptsNewProjects
}: {
  userId: string;
  unlocked: boolean;
  controller?: DecryptionController;
  isOpen?: () => Promise<boolean>;
  /** The account's "Encrypt new projects" opt-in (decision D2). */
  optedIn?: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    void isOpen().then((answer) => {
      if (!cancelled) setOpen(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, unlocked]);
  if (!unlocked || !open) return null;
  return (
    <StopPanel
      controller={injected ?? pageDecryptionController(userId)}
      optedIn={optedIn}
    />
  );
}

function StopPanel({
  controller,
  optedIn
}: {
  controller: DecryptionController;
  optedIn: () => Promise<boolean>;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );
  const [encryptsNew, setEncryptsNew] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (!controller.getState().running) void controller.refresh();
    let cancelled = false;
    void optedIn()
      .catch(() => false)
      .then((answer) => {
        if (!cancelled) setEncryptsNew(answer);
      });
    return () => {
      cancelled = true;
    };
  }, [controller, optedIn]);

  return (
    <Group title="Stop encrypting a project" note="Beta">
      <Notice tone="warning">
        Stopping encryption stores the project’s content readable by the
        OpenZCAD server again: this browser decrypts its current version, every
        save state, its files, name, measurements and view state, uploads them
        unencrypted, and then deletes the encrypted copy. Anyone who can read
        the server’s storage could read the project from then on. This is a
        tool for beta testers and will be removed.
      </Notice>
      <div className="encryption-migration-notes">
        <ul>
          <li>
            Only a project nobody else can open qualifies: remove its members,
            pending invitations and share links first.
          </li>
          <li>
            Your account must not encrypt new projects (Encrypt new projects,
            above, off).
          </li>
          <li>
            While it runs the project opens read-only. Keep this tab open; if it
            closes, starting again picks up where it left off.
          </li>
        </ul>
      </div>
      {encryptsNew ? (
        <Notice tone="warning" role="status">
          Your account encrypts new projects, so it cannot hold a plaintext one.
          Turn off “Encrypt new projects” to stop encrypting a project.
        </Notice>
      ) : null}
      {state.error ? (
        <Notice
          tone="warning"
          role="alert"
          action={
            <button
              className="secondary"
              type="button"
              onClick={() => void controller.refresh()}
            >
              <RefreshCcw size={13} aria-hidden="true" />
              Retry
            </button>
          }
        >
          {state.error}
        </Notice>
      ) : null}
      {state.otherTab ? (
        <Notice tone="warning" role="status">
          Another tab of this browser is encrypting or decrypting projects. Keep
          that tab open, or close it and try again here.
        </Notice>
      ) : null}
      {state.projects.length === 0 && !state.error ? (
        <SettingRow
          title="No encrypted projects"
          hint="Projects you encrypt are listed here."
        >
          <button
            className="secondary"
            type="button"
            onClick={() => void controller.refresh()}
          >
            <RefreshCcw size={13} aria-hidden="true" />
            Refresh
          </button>
        </SettingRow>
      ) : null}
      <div className="encryption-migration-list" role="list">
        {state.projects.map((progress) => (
          <StopRow
            key={progress.projectId}
            progress={progress}
            busy={state.running}
            disabled={encryptsNew}
            confirming={confirming === progress.projectId}
            onConfirm={(answer) =>
              setConfirming(answer ? progress.projectId : null)
            }
            controller={controller}
          />
        ))}
      </div>
    </Group>
  );
}

function StopRow({
  progress,
  busy,
  disabled,
  confirming,
  onConfirm,
  controller
}: {
  progress: MigrationProgress;
  busy: boolean;
  disabled: boolean;
  confirming: boolean;
  onConfirm: (confirming: boolean) => void;
  controller: DecryptionController;
}) {
  const [understood, setUnderstood] = useState(false);
  const stopped = progress.phase === 'error' || progress.phase === 'paused';
  const active =
    progress.phase !== 'waiting' && progress.phase !== 'done' && !stopped;
  const start = () => {
    onConfirm(false);
    setUnderstood(false);
    void controller.run(progress.projectId);
  };
  return (
    <div
      className="encryption-migration-item"
      role="listitem"
      aria-label={progress.name}
    >
      <SettingRow
        title={progress.name}
        hint={
          <Status
            tone={
              progress.phase === 'done'
                ? 'good'
                : progress.phase === 'error'
                  ? 'warning'
                  : undefined
            }
          >
            {phaseLabel(progress)}
          </Status>
        }
      >
        {progress.phase === 'waiting' && !confirming ? (
          <button
            className="secondary"
            type="button"
            disabled={busy || disabled}
            onClick={() => onConfirm(true)}
          >
            <LockOpen size={13} aria-hidden="true" />
            Stop encrypting this project
          </button>
        ) : null}
        {stopped ? (
          <span className="encryption-actions">
            <button
              className="secondary"
              type="button"
              disabled={busy || disabled}
              onClick={() => void controller.run(progress.projectId)}
            >
              <RefreshCcw size={13} aria-hidden="true" />
              {progress.phase === 'paused' ? 'Resume' : 'Retry'}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              title="Drops what was decrypted so far; the project stays encrypted."
              onClick={() => void controller.cancel(progress.projectId)}
            >
              <X size={13} aria-hidden="true" />
              Cancel
            </button>
          </span>
        ) : null}
      </SettingRow>
      {confirming ? (
        <div
          className="encryption-reverse-confirm"
          role="group"
          aria-label={`Stop encrypting ${progress.name}`}
        >
          <p>
            <strong>{progress.name}</strong> will be stored readable by the
            server again, with its whole history and files. The encrypted copy
            is deleted when it finishes.
          </p>
          <label>
            <input
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
            I understand this project will no longer be end-to-end encrypted.
          </label>
          <span className="encryption-actions">
            <button
              className="danger-ghost"
              type="button"
              disabled={!understood || busy}
              onClick={start}
            >
              Stop encrypting
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setUnderstood(false);
                onConfirm(false);
              }}
            >
              Keep it encrypted
            </button>
          </span>
        </div>
      ) : null}
      {active || stopped ? (
        <Meter
          used={progress.bytesDone}
          limit={Math.max(progress.bytesTotal, 1)}
          label={`${progress.name} decryption progress`}
          valueText={`${progress.revisionsDone} of ${progress.revisionsTotal} save states`}
        />
      ) : null}
      {progress.error ? (
        <p className="encryption-migration-error" role="alert">
          {progress.error.message}
        </p>
      ) : null}
    </div>
  );
}
