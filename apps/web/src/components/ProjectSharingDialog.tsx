import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CollaborationMember,
  ProjectAccessRole,
  ProjectEditLease,
  ProjectMemberRole,
  ProjectShareLinkSummary,
  ProjectSharingResponse,
  UserId
} from '@openzcad/shared';
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
  role: ProjectAccessRole | null;
  collaborationStatus: CollaborationStatus;
  lease: ProjectEditLease | null;
  liveMembers?: readonly CollaborationMember[];
  currentUserId?: UserId | null;
  client?: ProjectSharingClient;
  shareLinkClient?: ProjectShareLinkClient;
  editorInvitationsEnabled?: boolean;
  onClose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The sharing request failed.';
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

function createdLabel(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleDateString();
}

function expiryLabel(expiresAt: number): string {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    return 'expired';
  }
  const days = Math.floor(remaining / 86_400_000);
  if (days >= 1) {
    return `expires in ${days}d`;
  }
  return `expires in ${Math.ceil(remaining / 3_600_000)}h`;
}

function activeLease(
  lease: ProjectEditLease | null,
  projectId: string
): boolean {
  return Boolean(
    lease && lease.projectId === projectId && lease.expiresAt > Date.now()
  );
}

/**
 * Owner sharing controls and live role/lease state. Deliberately not where a
 * divergence gets resolved: that is `ProjectConflictDialog`, whichever side
 * raised it — a menu about who can see a project is the wrong place to be
 * asked which copy of it to keep.
 */
export function ProjectSharingDialog({
  projectId,
  role,
  collaborationStatus,
  lease,
  liveMembers = [],
  currentUserId = null,
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
      if (role !== 'owner') {
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
    [client, shareLinkClient, projectId, role]
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

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="shortcuts-card sharing-card"
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
        <header className="shortcuts-header sharing-header">
          <div className="sharing-header-text">
            <h2 id="project-sharing-title">Project sharing</h2>
            <p className="sharing-meta">
              <span className="sharing-meta-item">
                Your role: <strong>{role ?? 'Not connected'}</strong>
              </span>
              <span className="sharing-meta-item">
                <span
                  className="sharing-room-dot"
                  data-state={collaborationStatus}
                  aria-hidden="true"
                />
                Room: <strong>{collaborationStatus}</strong>
              </span>
              <span className="sharing-meta-item">
                Edit lease:{' '}
                <strong>
                  {role === 'viewer'
                    ? 'Not available to viewers'
                    : leaseIsActive
                      ? 'Active'
                      : 'Not held'}
                </strong>
              </span>
            </p>
          </div>
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

          {role === 'owner' ? (
            <>
              <section
                className="sharing-invite"
                aria-label="Invite a collaborator"
              >
                <form
                  className="sharing-cmd-bar"
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
                  <span className="sharing-cmd-icon" aria-hidden="true">
                    ✉
                  </span>
                  <input
                    type="email"
                    required
                    aria-label="Email"
                    placeholder="Invite by email…"
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
                  <button
                    type="submit"
                    className="primary"
                    disabled={interactionBusy}
                  >
                    Send invite
                  </button>
                </form>
                {invitationSentTo && (
                  <p className="sharing-invite-sent" role="status">
                    Invitation sent to {invitationSentTo}.
                  </p>
                )}
              </section>
            </>
          ) : null}

          {liveMembers.length > 0 && (
            <section
              className="sharing-section"
              aria-labelledby="active-collaborators-title"
            >
              <h3
                id="active-collaborators-title"
                className="sharing-group-label"
              >
                <span>Active collaborators</span>
                <span className="sharing-count">{liveMembers.length}</span>
              </h3>
              <ul className="sharing-list">
                {liveMembers.map((member) => (
                  <li key={member.clientId}>
                    <span className="sharing-avatar" aria-hidden="true">
                      {initialOf(member.displayName)}
                    </span>
                    <span className="sharing-member-id">
                      {member.displayName}
                      {member.userId === currentUserId ? ' (you)' : ''}
                    </span>
                    <span
                      className="sharing-presence"
                      data-status={member.status}
                    >
                      {member.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {role === 'owner' ? (
            <>
              <section
                className="sharing-section"
                aria-labelledby="project-members-title"
              >
                <h3 id="project-members-title" className="sharing-group-label">
                  <span>Members</span>
                  <span className="sharing-count">
                    {sharing?.members.length ?? 0}
                  </span>
                </h3>
                {sharing?.members.length ? (
                  <ul className="sharing-list">
                    {sharing.members.map((member) => (
                      <li key={member.userId}>
                        <span className="sharing-avatar" aria-hidden="true">
                          {initialOf(member.email ?? member.userId)}
                        </span>
                        <span className="sharing-member-id">
                          {member.email ?? member.userId}
                        </span>
                        <select
                          className="sharing-role-select"
                          aria-label={`Role for ${member.email ?? member.userId}`}
                          value={member.role}
                          disabled={interactionBusy}
                          onChange={(event) =>
                            void mutate(`member:${member.userId}`, async () => {
                              await client.updateMemberRole(
                                projectId,
                                member.userId,
                                event.target.value as ProjectMemberRole
                              );
                              await refresh();
                            })
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
                          aria-label={`Remove ${member.email ?? member.userId}`}
                          disabled={interactionBusy}
                          onClick={() =>
                            void mutate(`remove:${member.userId}`, async () => {
                              await client.removeMember(
                                projectId,
                                member.userId
                              );
                              await refresh();
                            })
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="sharing-empty">No project members.</p>
                )}
              </section>

              <section
                className="sharing-section"
                aria-labelledby="pending-invitations-title"
              >
                <h3
                  id="pending-invitations-title"
                  className="sharing-group-label"
                >
                  <span>Pending invitations</span>
                  <span className="sharing-count">
                    {sharing?.invitations.length ?? 0}
                  </span>
                </h3>
                {sharing?.invitations.length ? (
                  <ul className="sharing-list">
                    {sharing.invitations.map((invitation) => (
                      <li key={invitation.invitationId}>
                        <span className="sharing-avatar" aria-hidden="true">
                          {initialOf(invitation.email)}
                        </span>
                        <span className="sharing-member-id">
                          {invitation.email}
                        </span>
                        <span className="sharing-kind">
                          {invitation.role} ·{' '}
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
                ) : (
                  <p className="sharing-empty">No pending invitations.</p>
                )}
              </section>

              <section
                className="sharing-section"
                aria-labelledby="share-links-title"
              >
                <h3 id="share-links-title" className="sharing-group-label">
                  <span>Share link</span>
                  <span className="sharing-count">{shareLinks.length}</span>
                </h3>
                <p className="sharing-share-hint">
                  Anyone with the link can open this model, adjust its
                  parameters and export — without an account.
                </p>
                <button
                  type="button"
                  className="primary sharing-share-create"
                  disabled={interactionBusy}
                  onClick={() =>
                    void mutate('share-link:create', async () => {
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
                      Copy it now — this link is shown only once.
                    </p>
                  </div>
                )}
                {shareLinks.length ? (
                  <ul className="sharing-list">
                    {shareLinks.map((shareLink) => (
                      <li key={shareLink.shareLinkId}>
                        <span className="sharing-avatar" aria-hidden="true">
                          ⚲
                        </span>
                        <span className="sharing-member-id">
                          Anyone with the link
                        </span>
                        <span className="sharing-kind">
                          {shareLink.mode} ·{' '}
                          {createdLabel(shareLink.createdAt)}
                        </span>
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
                ) : (
                  <p className="sharing-empty">No active share links.</p>
                )}
              </section>
            </>
          ) : (
            <p className="sharing-empty">
              Only the project owner can manage members and invitations.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
