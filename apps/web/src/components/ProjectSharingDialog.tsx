import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Plus } from 'lucide-react';
import type {
  CollaborationMember,
  ProjectAccessRole,
  ProjectEditLease,
  ProjectMemberRole,
  ProjectShareLinkSummary,
  ProjectSharingResponse,
  UserId
} from '@openzcad/shared';
import { COLLABORATION_LABELS } from '../lib/collaborationLabels';
import {
  buildShareLinkUrl,
  createProjectShareLinkClient,
  type ProjectShareLinkClient
} from '../lib/projectShareClient';
import {
  createProjectSharingClient,
  type ProjectSharingClient
} from '../lib/projectSharing';
import type { CollaborationStatus } from '../lib/useCollaboration';
import { useModalFocus } from '../lib/useModalFocus';
import { StableLabel } from './StableLabel';

const defaultClient = createProjectSharingClient();
const defaultShareLinkClient = createProjectShareLinkClient();

export interface ProjectSharingDialogProps {
  projectId: string;
  localProject?: boolean;
  localImportSourceNames?: readonly string[];
  savingToAccount?: boolean;
  onSaveToAccount?(): void | Promise<void>;
  onBeforeCreateShareLink?(): void | Promise<void>;
  role: ProjectAccessRole | null;
  collaborationStatus: CollaborationStatus;
  lease: ProjectEditLease | null;
  liveMembers?: readonly CollaborationMember[];
  currentUserId?: UserId | null;
  /** The signed-in account's name, for the self row when no session is live. */
  currentUserName?: string | null;
  client?: ProjectSharingClient;
  shareLinkClient?: ProjectShareLinkClient;
  editorInvitationsEnabled?: boolean;
  onClose(): void;
}

type Presence = CollaborationMember['status'] | null;

/**
 * One row of the people list: a person, not a session. Two tabs of the same
 * account collapse into one row whose presence is its most active session.
 */
interface PersonRow {
  key: string;
  userId: UserId;
  initial: string;
  name: string;
  you: boolean;
  presence: Presence;
  kind: 'self' | 'member' | 'guest' | 'invitation';
}

const ROLE_LABELS: Record<ProjectAccessRole, string> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer'
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The sharing request failed.';
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

function createdLabel(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleDateString();
}

/** Compact time left on an invitation: `6d`, `3h`, or `expired`. */
function expiryLabel(expiresAt: number): string {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    return 'expired';
  }
  const days = Math.floor(remaining / 86_400_000);
  if (days >= 1) {
    return `${days}d`;
  }
  return `${Math.ceil(remaining / 3_600_000)}h`;
}

function activeLease(
  lease: ProjectEditLease | null,
  projectId: string
): boolean {
  return Boolean(
    lease && lease.projectId === projectId && lease.expiresAt > Date.now()
  );
}

function strongerPresence(a: Presence, b: Presence): Presence {
  if (a === 'active' || b === 'active') {
    return 'active';
  }
  return a ?? b;
}

/**
 * Owner sharing controls and live role/lease state, as a popover under the
 * top bar's sharing chip: the link first, then one list of people (members,
 * live guests and pending invitations alike) with the invite composer as its
 * last row. Deliberately not where a divergence gets resolved: that is
 * `ProjectConflictDialog`, whichever side raised it — a menu about who can
 * see a project is the wrong place to be asked which copy of it to keep.
 */
export function ProjectSharingDialog({
  projectId,
  localProject = false,
  localImportSourceNames = [],
  savingToAccount = false,
  onSaveToAccount,
  onBeforeCreateShareLink,
  role,
  collaborationStatus,
  lease,
  liveMembers = [],
  currentUserId = null,
  currentUserName = null,
  client = defaultClient,
  shareLinkClient = defaultShareLinkClient,
  editorInvitationsEnabled = true,
  onClose
}: ProjectSharingDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const shareLinkUrlRef = useRef<HTMLInputElement | null>(null);
  const [sharing, setSharing] = useState<ProjectSharingResponse | null>(null);
  const [shareLinks, setShareLinks] = useState<ProjectShareLinkSummary[]>([]);
  const [createdShareLinkUrl, setCreatedShareLinkUrl] = useState<string | null>(
    null
  );
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<ProjectMemberRole>('viewer');
  const [invitationSentTo, setInvitationSentTo] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(role === 'owner');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useModalFocus(dialogRef, { autoFocus: true });

  const refresh = useCallback(
    async (source: 'hydrate' | 'action' = 'action') => {
      const isHydration = source === 'hydrate';
      if (localProject || role !== 'owner') {
        setSharing(null);
        setShareLinks([]);
        if (isHydration) {
          setHydrating(false);
        }
        return;
      }
      if (isHydration) {
        setHydrating(true);
      }
      setError(null);
      try {
        const [nextSharing, nextShareLinks] = await Promise.all([
          client.getProjectSharing(projectId),
          shareLinkClient.listProjectShareLinks(projectId)
        ]);
        setSharing(nextSharing);
        setShareLinks(nextShareLinks);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        if (isHydration) {
          setHydrating(false);
        }
      }
    },
    [client, shareLinkClient, projectId, role, localProject]
  );

  const copyShareLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setShareLinkCopied(true);
    } catch {
      const input = shareLinkUrlRef.current;
      if (input) {
        input.focus();
        input.select();
        setShareLinkCopied(document.execCommand('copy'));
      }
    }
  };

  useEffect(() => {
    // Initial hydration guards the controls without inserting a transient
    // action-status row after the dialog has already painted.
    void refresh('hydrate');
  }, [refresh]);

  const mutate = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const leaseIsActive = activeLease(lease, projectId);
  const interactionBusy = hydrating || busy !== null;
  const isOwner = !localProject && role === 'owner';

  const people = useMemo(() => {
    const presenceByUser = new Map<UserId, Presence>();
    const nameByUser = new Map<UserId, string>();
    for (const member of liveMembers) {
      presenceByUser.set(
        member.userId,
        strongerPresence(
          presenceByUser.get(member.userId) ?? null,
          member.status
        )
      );
      if (!nameByUser.has(member.userId)) {
        nameByUser.set(member.userId, member.displayName);
      }
    }
    const rows: PersonRow[] = [];
    const seen = new Set<UserId>();
    if (currentUserId !== null) {
      const name =
        nameByUser.get(currentUserId) ?? currentUserName?.trim() ?? '';
      rows.push({
        key: `self:${currentUserId}`,
        userId: currentUserId,
        initial: name ? initialOf(name) : 'Y',
        name: name || 'You',
        // A bare "You" needs no "(you)" after it.
        you: name !== '',
        presence: presenceByUser.get(currentUserId) ?? null,
        kind: 'self'
      });
      seen.add(currentUserId);
    }
    for (const member of sharing?.members ?? []) {
      if (seen.has(member.userId)) {
        continue;
      }
      const name = member.email ?? member.userId;
      rows.push({
        key: `member:${member.userId}`,
        userId: member.userId,
        initial: initialOf(name),
        name,
        you: false,
        presence: presenceByUser.get(member.userId) ?? null,
        kind: 'member'
      });
      seen.add(member.userId);
    }
    for (const member of liveMembers) {
      if (seen.has(member.userId)) {
        continue;
      }
      rows.push({
        key: `guest:${member.userId}`,
        userId: member.userId,
        initial: initialOf(member.displayName),
        name: member.displayName,
        you: false,
        presence: presenceByUser.get(member.userId) ?? null,
        kind: 'guest'
      });
      seen.add(member.userId);
    }
    return rows;
  }, [liveMembers, sharing, currentUserId, currentUserName]);

  const memberByUser = useMemo(
    () => new Map((sharing?.members ?? []).map((m) => [m.userId, m])),
    [sharing]
  );

  const onlineCount = useMemo(
    () => new Set(liveMembers.map((member) => member.userId)).size,
    [liveMembers]
  );

  const footerParts: string[] = [COLLABORATION_LABELS[collaborationStatus]];
  if (collaborationStatus === 'live') {
    footerParts.push(onlineCount <= 1 ? 'only you' : `${onlineCount} online`);
  }
  if (role === null) {
    footerParts.push('access not confirmed');
  } else if (role === 'viewer') {
    footerParts.push('you are a viewer');
  } else {
    footerParts.push(
      leaseIsActive ? 'you hold the edit lease' : 'edit lease not held'
    );
  }

  return (
    <div
      className="modal-backdrop sharing-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="sharing-popover"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-sharing-title"
        aria-busy={interactionBusy}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="sharing-header">
          <h2 id="project-sharing-title">Project sharing</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close sharing"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="sharing-body">
          <p
            className="sharing-status-line"
            data-tone={error ? 'error' : busy ? 'busy' : undefined}
            aria-live="polite"
            role={error ? 'alert' : 'status'}
          >
            {error ?? (busy ? 'Working…' : null)}
          </p>

          {localProject ? (
            <section className="sharing-section sharing-local">
              <h3>Save this project to your account</h3>
              <p className="sharing-empty">
                This imported copy is saved on this device. Save it to your
                account, including its source files, to connect and share it.
              </p>
              <button
                type="button"
                className="primary"
                disabled={savingToAccount || busy !== null || !onSaveToAccount}
                onClick={() =>
                  void mutate('save-account', async () => {
                    await onSaveToAccount?.();
                  })
                }
              >
                {savingToAccount
                  ? 'Saving project and sources…'
                  : 'Save to my account'}
              </button>
            </section>
          ) : null}

          {isOwner ? (
            <section className="sharing-section sharing-link" aria-label="Link">
              <div className="sharing-link-head">
                <Link2 size={16} aria-hidden="true" />
                <div className="sharing-link-text">
                  <span className="sharing-link-title">
                    Anyone with the link
                  </span>
                  <span className="sharing-tag">
                    Opens in Tweak: parameters and export, no account needed.
                  </span>
                </div>
                <button
                  type="button"
                  className="primary sharing-share-create"
                  disabled={
                    interactionBusy || localImportSourceNames.length > 0
                  }
                  onClick={() =>
                    void mutate('share-link:create', async () => {
                      await onBeforeCreateShareLink?.();
                      setCreatedShareLinkUrl(null);
                      setShareLinkCopied(false);
                      const created =
                        await shareLinkClient.createProjectShareLink(
                          projectId,
                          'tweak'
                        );
                      setCreatedShareLinkUrl(buildShareLinkUrl(created.token));
                      await refresh();
                    })
                  }
                >
                  Create link
                </button>
              </div>
              {localImportSourceNames.length > 0 && (
                <p className="sharing-share-hint" role="alert">
                  Save the source files for {localImportSourceNames.join(', ')}{' '}
                  to your account with File → Save before creating a link.
                </p>
              )}
              {createdShareLinkUrl && (
                <div className="sharing-share-output" role="status">
                  <input
                    ref={shareLinkUrlRef}
                    className="sharing-share-url"
                    type="text"
                    readOnly
                    aria-label="Share link"
                    value={createdShareLinkUrl}
                    onFocus={(event) => event.target.select()}
                  />
                  <button
                    type="button"
                    className="sharing-share-copy"
                    onClick={() => void copyShareLink(createdShareLinkUrl)}
                  >
                    <StableLabel reserve={['Copied', 'Copy']} align="center">
                      {shareLinkCopied ? 'Copied' : 'Copy'}
                    </StableLabel>
                  </button>
                  <p className="sharing-share-once">
                    Shown once — copy it now.
                  </p>
                </div>
              )}
              {shareLinks.length > 0 && (
                <ul className="sharing-list">
                  {shareLinks.map((shareLink) => (
                    <li key={shareLink.shareLinkId}>
                      <span
                        className="sharing-avatar sharing-avatar-link"
                        aria-hidden="true"
                      >
                        <Link2 size={12} />
                      </span>
                      <span className="sharing-member-id">
                        Link created {createdLabel(shareLink.createdAt)}
                      </span>
                      <span className="sharing-kind">{shareLink.mode}</span>
                      <button
                        type="button"
                        className="sharing-row-action"
                        aria-label={`Revoke share link created ${createdLabel(
                          shareLink.createdAt
                        )}`}
                        disabled={interactionBusy}
                        onClick={() =>
                          void mutate(
                            `share-link:revoke:${shareLink.shareLinkId}`,
                            async () => {
                              await shareLinkClient.revokeProjectShareLink(
                                projectId,
                                shareLink.shareLinkId
                              );
                              setCreatedShareLinkUrl(null);
                              await refresh();
                            }
                          )
                        }
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {!localProject && (people.length > 0 || isOwner) ? (
            <section
              className="sharing-section sharing-people"
              aria-label="People"
            >
              <ul className="sharing-list">
                {people.map((person) => {
                  const member =
                    person.kind === 'member'
                      ? memberByUser.get(person.userId)
                      : undefined;
                  return (
                    <li key={person.key}>
                      <span
                        className="sharing-avatar"
                        data-presence={person.presence ?? undefined}
                        aria-hidden="true"
                      >
                        {person.initial}
                      </span>
                      <span className="sharing-member-id">
                        {person.name}
                        {person.you ? ' (you)' : ''}
                      </span>
                      {person.kind === 'self' && role ? (
                        <span className="sharing-kind">
                          {ROLE_LABELS[role]}
                        </span>
                      ) : null}
                      {person.kind === 'guest' ? (
                        <span
                          className="sharing-presence"
                          data-status={person.presence ?? 'idle'}
                        >
                          {person.presence ?? 'idle'}
                        </span>
                      ) : null}
                      {member ? (
                        <>
                          <select
                            className="sharing-role-select"
                            aria-label={`Role for ${person.name}`}
                            value={member.role}
                            disabled={interactionBusy}
                            onChange={(event) =>
                              void mutate(
                                `member:${member.userId}`,
                                async () => {
                                  await client.updateMemberRole(
                                    projectId,
                                    member.userId,
                                    event.target.value as ProjectMemberRole
                                  );
                                  await refresh();
                                }
                              )
                            }
                          >
                            <option value="viewer">Viewer</option>
                            <option
                              value="editor"
                              disabled={!editorInvitationsEnabled}
                            >
                              Editor
                            </option>
                          </select>
                          <button
                            type="button"
                            className="sharing-row-action"
                            aria-label={`Remove ${person.name}`}
                            disabled={interactionBusy}
                            onClick={() =>
                              void mutate(
                                `remove:${member.userId}`,
                                async () => {
                                  await client.removeMember(
                                    projectId,
                                    member.userId
                                  );
                                  await refresh();
                                }
                              )
                            }
                          >
                            Remove
                          </button>
                        </>
                      ) : null}
                    </li>
                  );
                })}
                {(sharing?.invitations ?? []).map((invitation) => (
                  <li key={invitation.invitationId} className="sharing-pending">
                    <span
                      className="sharing-avatar sharing-avatar-pending"
                      aria-hidden="true"
                    >
                      {initialOf(invitation.email)}
                    </span>
                    <span className="sharing-member-id">
                      {invitation.email}
                    </span>
                    <span className="sharing-kind">
                      Invited · {invitation.role} ·{' '}
                      {expiryLabel(invitation.expiresAt)}
                    </span>
                    <button
                      type="button"
                      className="sharing-row-action"
                      aria-label={`Revoke invitation for ${invitation.email}`}
                      disabled={interactionBusy}
                      onClick={() =>
                        void mutate(
                          `revoke:${invitation.invitationId}`,
                          async () => {
                            await client.revokeInvitation(
                              projectId,
                              invitation.invitationId
                            );
                            await refresh();
                          }
                        )
                      }
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
              {isOwner ? (
                <form
                  className="sharing-invite"
                  aria-label="Invite a collaborator"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate('invite', async () => {
                      setInvitationSentTo(null);
                      const created = await client.createInvitation(
                        projectId,
                        email,
                        inviteRole
                      );
                      setInvitationSentTo(created.invitation.email);
                      setEmail('');
                      await refresh();
                    });
                  }}
                >
                  <Plus size={14} aria-hidden="true" />
                  <input
                    type="email"
                    required
                    aria-label="Email"
                    placeholder="Add people by email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <select
                    aria-label="Role"
                    value={inviteRole}
                    onChange={(event) =>
                      setInviteRole(event.target.value as ProjectMemberRole)
                    }
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor" disabled={!editorInvitationsEnabled}>
                      Editor
                    </option>
                  </select>
                  <button type="submit" disabled={interactionBusy}>
                    Invite
                  </button>
                </form>
              ) : null}
              {invitationSentTo && (
                <p className="sharing-invite-sent" role="status">
                  Invitation sent to {invitationSentTo}.
                </p>
              )}
            </section>
          ) : null}

          {!localProject && !isOwner ? (
            <p className="sharing-empty">
              {role === null
                ? 'Connecting to project sharing. Your cloud access has not been confirmed yet.'
                : 'Only the project owner can manage members and invitations.'}
            </p>
          ) : null}
        </div>

        {!localProject ? (
          <footer className="sharing-footer">
            <span
              className="sharing-room-dot"
              data-state={collaborationStatus}
              aria-hidden="true"
            />
            <span className="sharing-tag">{footerParts.join(' · ')}</span>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
