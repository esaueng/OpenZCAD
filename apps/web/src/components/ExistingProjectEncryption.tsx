import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Copy,
  Link2,
  Lock,
  Mail,
  Pause,
  Play,
  RefreshCcw,
  X
} from 'lucide-react';
import type { E2eeConfigResponse } from '@openzcad/shared';
import { desktopFetch } from '../lib/desktopBridge';
import {
  pageMigrationController,
  type MigrationController
} from '../lib/e2ee/projectMigrations';
import type { MigrationProgress } from '../lib/e2ee/projectMigrationEngine';
import {
  migrationMemberAction,
  type MigrationMember,
  type MigrationMemberState
} from '../lib/e2ee/migrationMembers';
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
    case 'members':
      return 'Waiting for members';
    case 'readding':
      return 'Adding members back…';
    case 'cutover':
      return 'Switching to encrypted storage…';
    case 'purging':
      return 'Deleting the plaintext copy…';
    case 'done':
      return 'Encrypted';
    case 'paused':
      return 'Paused';
    case 'error':
      return progress.cutOver
        ? 'Stopped before the plaintext copy was deleted'
        : 'Stopped';
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
  // Cut over, with the plaintext copy not yet purged: still finishing.
  const finishing = remaining.filter((p) => p.cutOver).length;
  const plaintext = remaining.length - finishing;
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
            A shared project is encrypted once every member has set up
            encryption and you have compared codes with each of them. They are
            added back with their current roles. Its share links and pending
            invitations stop working; you can create encrypted ones afterwards.
          </li>
          <li>
            Original mesh files and image snapshots stored with a project are
            not carried over.
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
          plaintext
            ? `${plaintext} project${plaintext === 1 ? '' : 's'} not encrypted`
            : finishing
              ? `${finishing} project${finishing === 1 ? '' : 's'} still finishing encryption`
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

const MEMBER_STATE_LABELS: Record<MigrationMemberState, string> = {
  'needs-encryption': 'Needs encryption',
  'needs-invitation': 'Preparing',
  'waiting-for-keys': 'Waiting for their keys',
  verify: 'Compare codes',
  ready: 'Ready',
  readded: 'Added back'
};

const roleLabel = (role: MigrationMember['role']) =>
  role === 'editor' ? 'Editor' : 'Viewer';

/** Slice 7-4: a shared project's members and what each still needs. */
function MemberReadiness({
  name,
  members
}: {
  name: string;
  members: readonly MigrationMember[];
}) {
  return (
    <ul
      className="encryption-migration-members"
      aria-label={`Members of ${name}`}
    >
      {members.map((member) => (
        <li key={member.userId}>
          <span className="encryption-migration-member">
            <strong>{member.email ?? 'A member'}</strong>
            {` · ${roleLabel(member.role)} · `}
            <Status
              tone={
                member.state === 'ready' || member.state === 'readded'
                  ? 'good'
                  : 'warning'
              }
            >
              {MEMBER_STATE_LABELS[member.state]}
            </Status>
          </span>
          <span className="encryption-migration-member-action">
            {migrationMemberAction(member)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Slice 7-4 (decision M8): after a shared project's cutover, encrypted
 * links in place of the revoked plaintext ones, and encrypted invitations
 * in place of the revoked pending ones.
 */
function RevokedFollowUps({
  progress,
  busy,
  controller
}: {
  progress: MigrationProgress;
  busy: boolean;
  controller: MigrationController;
}) {
  const [working, setWorking] = useState(false);
  const [links, setLinks] = useState<
    { shareId: string; url: string; mode: string; pending: boolean }[]
  >([]);
  const [message, setMessage] = useState<string | null>(null);
  const revoked = progress.revoked;
  const linkCount = revoked?.shareLinks.length ?? 0;
  const invitationCount = revoked?.invitations.length ?? 0;
  if (!linkCount && !invitationCount && !links.length && !message) return null;
  const run = async (task: () => Promise<string | null>) => {
    setWorking(true);
    setMessage(null);
    try {
      setMessage(await task());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="encryption-migration-followups">
      {linkCount ? (
        <Notice
          tone="info"
          action={
            <button
              className="secondary"
              type="button"
              disabled={busy || working}
              onClick={() =>
                void run(async () => {
                  const created = await controller.reissueLinks(
                    progress.projectId
                  );
                  setLinks(
                    created.map((link) => ({
                      shareId: link.shareId,
                      url: link.url,
                      mode: link.mode,
                      pending: link.pending.length > 0
                    }))
                  );
                  return null;
                })
              }
            >
              <Link2 size={13} aria-hidden="true" />
              Create encrypted link{linkCount === 1 ? '' : 's'}
            </button>
          }
        >
          {linkCount === 1
            ? 'Its share link stopped working when it was encrypted.'
            : `Its ${linkCount} share links stopped working when it was encrypted.`}{' '}
          Encrypted links have new addresses; send them to whoever had the old
          ones.
        </Notice>
      ) : null}
      {invitationCount ? (
        <Notice
          tone="info"
          action={
            <button
              className="secondary"
              type="button"
              disabled={busy || working}
              onClick={() =>
                void run(async () => {
                  const result = await controller.reinvite(progress.projectId);
                  return result.failed.length
                    ? `${result.invited.length} invited; ${result.failed.length} could not be invited. Try again.`
                    : `Invited ${result.invited.join(', ')} to the encrypted project.`;
                })
              }
            >
              <Mail size={13} aria-hidden="true" />
              Invite again
            </button>
          }
        >
          {invitationCount === 1
            ? `The pending invitation to ${revoked!.invitations[0]!.email} was revoked.`
            : `${invitationCount} pending invitations were revoked.`}{' '}
          Invite them again to the encrypted project.
        </Notice>
      ) : null}
      {links.length ? (
        <ul
          className="encryption-migration-links"
          aria-label={`New links of ${progress.name}`}
        >
          {links.map((link) => (
            <li key={link.shareId}>
              <code>{link.url}</code>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(link.url)
                    .catch(() => undefined)
                }
              >
                <Copy size={13} aria-hidden="true" />
                Copy
              </button>
              {link.pending ? (
                <span className="encryption-migration-member-action">
                  Confirm it in the project’s sharing dialog before visitors can
                  open it.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {message ? (
        <p className="encryption-migration-member-action" role="status">
          {message}
        </p>
      ) : null}
    </div>
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
  const stopped =
    progress.phase === 'error' ||
    progress.phase === 'paused' ||
    progress.phase === 'members';
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
              {progress.phase === 'paused'
                ? 'Resume'
                : progress.phase === 'members'
                  ? 'Check again'
                  : 'Retry'}
            </button>
            {/* Nothing to cancel once cut over (only the purge remains),
                nor while members are waited for before anything is staged;
                a resumed staging that waits for a member can still be
                dropped. */}
            {progress.cutOver ||
            (progress.phase === 'members' &&
              !progress.plaintextLocked) ? null : (
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
            )}
          </span>
        ) : null}
      </SettingRow>
      {(active || stopped) && progress.phase !== 'members' ? (
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
      {progress.members?.length && progress.phase !== 'done' ? (
        <MemberReadiness name={progress.name} members={progress.members} />
      ) : null}
      {progress.phase === 'done' ? (
        <RevokedFollowUps
          progress={progress}
          busy={busy}
          controller={controller}
        />
      ) : null}
    </div>
  );
}
