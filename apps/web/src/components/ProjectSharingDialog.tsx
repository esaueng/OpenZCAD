import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CollaborationMember,
  ProjectAccessRole,
  ProjectEditLease,
  ProjectMemberRole,
  ProjectSharingResponse
} from '@openzcad/shared';
import {
  resolveProjectConflict,
  type ProjectConflict,
  type ConflictResolution,
  type ConflictResolutionHandlers
} from '../lib/conflictRecovery';
import {
  createProjectSharingClient,
  type ProjectSharingClient
} from '../lib/projectSharing';
import type { CollaborationStatus } from '../lib/useCollaboration';
import { useModalFocus } from '../lib/useModalFocus';

const defaultClient = createProjectSharingClient();

export interface ProjectSharingDialogProps {
  projectId: string;
  role: ProjectAccessRole | null;
  collaborationStatus: CollaborationStatus;
  lease: ProjectEditLease | null;
  liveMembers?: readonly CollaborationMember[];
  conflict?: ProjectConflict | null;
  conflictHandlers?: ConflictResolutionHandlers;
  client?: ProjectSharingClient;
  editorInvitationsEnabled?: boolean;
  onClose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The sharing request failed.';
}

function activeLease(
  lease: ProjectEditLease | null,
  projectId: string
): boolean {
  return Boolean(
    lease && lease.projectId === projectId && lease.expiresAt > Date.now()
  );
}

/** Owner sharing controls, live role/lease state, and recovery-first conflict UX. */
export function ProjectSharingDialog({
  projectId,
  role,
  collaborationStatus,
  lease,
  liveMembers = [],
  conflict = null,
  conflictHandlers,
  client = defaultClient,
  editorInvitationsEnabled = true,
  onClose
}: ProjectSharingDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [sharing, setSharing] = useState<ProjectSharingResponse | null>(null);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<ProjectMemberRole>('viewer');
  const [invitationToken, setInvitationToken] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useModalFocus(dialogRef, { autoFocus: true });

  const refresh = useCallback(async () => {
    if (role !== 'owner') {
      setSharing(null);
      return;
    }
    setBusy('loading');
    setError(null);
    try {
      setSharing(await client.getProjectSharing(projectId));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }, [client, projectId, role]);

  useEffect(() => {
    void refresh();
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

  const resolve = async (resolution: ConflictResolution) => {
    if (!conflict || !conflictHandlers) {
      return;
    }
    await mutate(`conflict:${resolution}`, () =>
      resolveProjectConflict(
        conflict,
        resolution,
        { role, lease },
        conflictHandlers
      )
    );
  };

  const leaseIsActive = activeLease(lease, projectId);
  const canKeepMine = role !== 'viewer' && role !== null && leaseIsActive;

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
        className="shortcuts-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-sharing-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header className="shortcuts-header">
          <div>
            <h2 id="project-sharing-title">Project sharing</h2>
            <p>
              Your role: <strong>{role ?? 'Not connected'}</strong> · Room:{' '}
              <strong>{collaborationStatus}</strong> · Edit lease:{' '}
              <strong>
                {role === 'viewer'
                  ? 'Not available to viewers'
                  : leaseIsActive
                    ? 'Active'
                    : 'Not held'}
              </strong>
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

        <p aria-live="polite" role={error ? 'alert' : 'status'}>
          {error ?? (busy ? 'Working…' : '')}
        </p>

        {liveMembers.length > 0 && (
          <section aria-labelledby="active-collaborators-title">
            <h3 id="active-collaborators-title">Active collaborators</h3>
            <ul>
              {liveMembers.map((member) => (
                <li key={member.clientId}>
                  {member.displayName} — {member.status}
                </li>
              ))}
            </ul>
          </section>
        )}

        {conflict && (
          <section aria-labelledby="conflict-recovery-title">
            <h3 id="conflict-recovery-title">Resolve local changes</h3>
            <p>
              Local version {conflict.localDocument.version} differs from room
              version {conflict.expectedRemoteVersion}. Your local document
              remains unresolved if this dialog is closed.
            </p>
            <div>
              <button
                type="button"
                disabled={!conflictHandlers || busy !== null}
                onClick={() => void resolve('use-remote')}
              >
                Use room version
              </button>
              <button
                type="button"
                disabled={!conflictHandlers || !canKeepMine || busy !== null}
                aria-describedby={
                  !canKeepMine ? 'keep-mine-requirement' : undefined
                }
                onClick={() => void resolve('keep-mine')}
              >
                Keep my version
              </button>
              <button
                type="button"
                disabled={!conflictHandlers || busy !== null}
                onClick={() => void resolve('save-local-copy')}
              >
                Save local as a copy
              </button>
            </div>
            {!canKeepMine && (
              <p id="keep-mine-requirement">
                Keep my version requires owner or editor access and an active
                edit lease.
              </p>
            )}
          </section>
        )}

        {role === 'owner' ? (
          <>
            <section aria-labelledby="invite-collaborator-title">
              <h3 id="invite-collaborator-title">Invite a collaborator</h3>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate('invite', async () => {
                    const created = await client.createInvitation(
                      projectId,
                      email,
                      inviteRole
                    );
                    setInvitationToken(created.token);
                    setCopyStatus(null);
                    setEmail('');
                    await refresh();
                  });
                }}
              >
                <label>
                  Email
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
                <label>
                  Role
                  <select
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
                </label>
                <button type="submit" disabled={busy !== null}>
                  Create invitation
                </button>
              </form>
              {invitationToken && (
                <div className="sharing-token-row">
                  <output aria-label="Invitation token">
                    Copy this token now; it is shown once: {invitationToken}
                  </output>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      setCopyStatus(null);
                      if (!navigator.clipboard) {
                        setCopyStatus(
                          'Copy is unavailable. Select the token and copy it manually.'
                        );
                        return;
                      }
                      void navigator.clipboard
                        .writeText(invitationToken)
                        .then(() => setCopyStatus('Invitation token copied.'))
                        .catch(() =>
                          setCopyStatus(
                            'Copy failed. Select the token and copy it manually.'
                          )
                        );
                    }}
                  >
                    Copy invitation token
                  </button>
                  {copyStatus && <span role="status">{copyStatus}</span>}
                </div>
              )}
            </section>

            <section aria-labelledby="project-members-title">
              <h3 id="project-members-title">Members</h3>
              {sharing?.members.length ? (
                <ul>
                  {sharing.members.map((member) => (
                    <li key={member.userId}>
                      <span>{member.email ?? member.userId}</span>{' '}
                      <label>
                        <span className="sr-only">
                          Role for {member.email ?? member.userId}
                        </span>
                        <select
                          aria-label={`Role for ${member.email ?? member.userId}`}
                          value={member.role}
                          disabled={busy !== null}
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
                      </label>{' '}
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void mutate(`remove:${member.userId}`, async () => {
                            await client.removeMember(projectId, member.userId);
                            await refresh();
                          })
                        }
                      >
                        Remove {member.email ?? member.userId}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No project members.</p>
              )}
            </section>

            <section aria-labelledby="pending-invitations-title">
              <h3 id="pending-invitations-title">Pending invitations</h3>
              {sharing?.invitations.length ? (
                <ul>
                  {sharing.invitations.map((invitation) => (
                    <li key={invitation.invitationId}>
                      {invitation.email} — {invitation.role}{' '}
                      <button
                        type="button"
                        disabled={busy !== null}
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
                        Revoke invitation for {invitation.email}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No pending invitations.</p>
              )}
            </section>
          </>
        ) : (
          <p>Only the project owner can manage members and invitations.</p>
        )}
      </div>
    </div>
  );
}
