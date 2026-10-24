import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Lock, Pause, Play, RefreshCcw, X } from 'lucide-react';
import type { E2eeConfigResponse } from '@openzcad/shared';
import { desktopFetch } from '../lib/desktopBridge';
import {
  pageMigrationController,
  type MigrationController
} from '../lib/e2ee/projectMigrations';
import type { MigrationProgress } from '../lib/e2ee/projectMigrationEngine';
import { Group, Meter, Notice, SettingRow, Status } from './settingsControls';

const MB = 1024 * 1024;
const megabytes = (bytes: number) =>
  (bytes / MB).toFixed(bytes < MB ? 2 : bytes < 10 * MB ? 1 : 0);

async function migrationOpen(): Promise<boolean> {
  try {
    const response = await desktopFetch('/api/e2ee/config', {
      credentials: 'same-origin'
    });
    if (!response.ok) return false;
    const config = (await response.json()) as E2eeConfigResponse;
    return config.migrationEnabled === true;
  } catch {
    return false;
  }
}

function phaseLabel(progress: MigrationProgress): string {
  switch (progress.phase) {
    case 'waiting':
      return 'Not encrypted';
    case 'starting':
      return 'Starting…';
    case 'revisions':
      return 'Encrypting save states…';
    case 'head':
      return 'Encrypting the current version…';
    case 'details':
      return 'Encrypting files and details…';
    case 'checking':
      return 'Checking…';
    case 'cutover':
      return 'Switching to encrypted storage…';
    case 'purging':
      return 'Deleting the plaintext copy…';
    case 'done':
      return 'Encrypted';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Stopped';
  }
}

function progressText(progress: MigrationProgress): string {
  const parts = [
    `${progress.revisionsDone} of ${progress.revisionsTotal} save states`
  ];
  if (progress.bytesTotal > 0) {
    parts.push(
      `${megabytes(progress.bytesDone)} of ${megabytes(progress.bytesTotal)} MB`
    );
  }
  return parts.join(' · ');
}

/**
 * Settings › Encryption › "Encrypt existing projects" (ADR-024 Phase 7,
 * slice 7-2): moves the account's plaintext projects to end-to-end
 * encrypted storage in this browser, oldest first, with per-project
 * progress, pause and resume, and errors with retry. Shown only when the
 * Worker opens migration to this account (E2EE_MIGRATION_ENABLED and
 * migration 0042) and this device holds the unlocked account key. Kept
 * apart from EncryptionSettings so it mounts there with one line.
 */
export function ExistingProjectEncryption({
  userId,
  unlocked,
  controller: injected,
  isOpen = migrationOpen
}: {
  userId: string;
  unlocked: boolean;
  controller?: MigrationController;
  isOpen?: () => Promise<boolean>;
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
    <MigrationPanel controller={injected ?? pageMigrationController(userId)} />
  );
}

function MigrationPanel({ controller }: { controller: MigrationController }) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );
  useEffect(() => {
    if (!controller.getState().running) void controller.refresh();
  }, [controller]);
  const remaining = useMemo(
    () => state.projects.filter((p) => p.phase !== 'done'),
    [state.projects]
  );
  const resumable = state.projects.some((p) => p.phase === 'paused');

  return (
    <Group title="Encrypt existing projects">
      <div className="encryption-migration-notes">
        <p>
          Encrypting a project moves it to end-to-end encrypted storage: this
          browser encrypts its current version, every save state and its files,
          and then the plaintext copy is deleted from your account.
        </p>
        <ul>
          <li>
            Export an <strong>.openzcad</strong> backup of each project first
            (File › Export project).
          </li>
          <li>
            If you lose access to your keys (every device and your recovery
            key), encrypted cloud data cannot be recovered, by you or by us.
          </li>
          <li>
            Plaintext copies may persist for up to 30 days in backups (database
            point-in-time recovery and live-session recovery) before they
            expire.
          </li>
          <li>
            Shared projects cannot be encrypted yet. Original mesh files and
            image snapshots stored with a project are not carried over.
          </li>
          <li>
            While a project is being encrypted it opens read-only. Close it in
            other tabs and on other devices first.
          </li>
        </ul>
      </div>
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
          Projects are being encrypted in another tab of this browser. Keep that
          tab open, or close it and try again here.
        </Notice>
      ) : null}
      {state.running ? (
        <Notice role="status">
          Keep this tab open until encryption finishes. If it closes, it picks
          up where it left off the next time you start it.
        </Notice>
      ) : null}
      <SettingRow
        title={
          remaining.length
            ? `${remaining.length} project${remaining.length === 1 ? '' : 's'} not encrypted`
            : 'All your projects are encrypted'
        }
        hint="Oldest first, one at a time."
      >
        {state.running ? (
          <button
            className="secondary"
            type="button"
            disabled={state.pausing}
            onClick={() => controller.pause()}
          >
            <Pause size={13} aria-hidden="true" />
            {state.pausing ? 'Pausing…' : 'Pause'}
          </button>
        ) : (
          <button
            className="primary"
            type="button"
            disabled={!remaining.length}
            onClick={() => void controller.run()}
          >
            {resumable ? (
              <Play size={13} aria-hidden="true" />
            ) : (
              <Lock size={13} aria-hidden="true" />
            )}
            {resumable ? 'Resume' : 'Encrypt projects'}
          </button>
        )}
      </SettingRow>
      <div className="encryption-migration-list" role="list">
        {state.projects.map((progress) => (
          <ProjectRow
            key={progress.projectId}
            progress={progress}
            busy={state.running}
            controller={controller}
          />
        ))}
      </div>
    </Group>
  );
}

function ProjectRow({
  progress,
  busy,
  controller
}: {
  progress: MigrationProgress;
  busy: boolean;
  controller: MigrationController;
}) {
  const stopped = progress.phase === 'error' || progress.phase === 'paused';
  const active =
    progress.phase !== 'waiting' && progress.phase !== 'done' && !stopped;
  return (
    <div
      className="encryption-migration-item"
      role="listitem"
      aria-label={progress.name}
    >
      <SettingRow
        title={progress.name}
        hint={
          <>
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
            {active || stopped ? ` ${progressText(progress)}` : null}
          </>
        }
      >
        {stopped ? (
          <span className="encryption-actions">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void controller.run([progress.projectId])}
            >
              <RefreshCcw size={13} aria-hidden="true" />
              {progress.phase === 'paused' ? 'Resume' : 'Retry'}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              title="Drops what was encrypted so far and unlocks the plaintext project."
              onClick={() => void controller.cancel(progress.projectId)}
            >
              <X size={13} aria-hidden="true" />
              Cancel
            </button>
          </span>
        ) : null}
      </SettingRow>
      {active || stopped ? (
        <Meter
          used={progress.bytesDone}
          limit={Math.max(progress.bytesTotal, 1)}
          label={`${progress.name} encryption progress`}
          valueText={progressText(progress)}
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
