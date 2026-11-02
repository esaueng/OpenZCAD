import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { CSSProperties, RefObject } from 'react';
import { Globe, Lock, X } from 'lucide-react';
import type {
  CollaborationMember,
  ProjectAccessRole,
  ProjectEditLease,
  ProjectMemberRole,
  ProjectShareLinkMode,
  ProjectShareLinkSummary,
  ProjectSharingResponse,
  UserId
} from '@openzcad/shared';
import {
  normalizeShareLinkLabel,
  PROJECT_SHARE_LINK_LABEL_MAX_LENGTH,
  PROJECT_SHARE_LINK_TTL_SECONDS
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
import {
  EncryptedShareLinks,
  type EncryptedShareLinkClient
} from './EncryptedShareLinks';
import type { OwnerInvitation } from '../lib/e2ee/invitations';
import { useEncryptionStatus } from '../lib/e2ee/encryptionStatus';
import {
  PrivateEmailInput,
  usePersonalInfoVisible
} from './PersonalInfoToggle';

const defaultClient = createProjectSharingClient();
const defaultShareLinkClient = createProjectShareLinkClient();

/**
 * Invitations to an end-to-end encrypted project (ADR-024 slice 5-3b): the
 * owner's browser signs each one, adds a verified invitee by an MLS Commit
 * and keeps the invitee's address locally, so the dialog asks this client
 * instead of the plaintext routes, which refuse encrypted projects.
 */
export interface EncryptedSharingClient {
  /** The project's open invitations, after adding every ready invitee. */
  list(projectId: string): Promise<OwnerInvitation[]>;
  invite(
    projectId: string,
    email: string,
    role: ProjectMemberRole
  ): Promise<void>;
  revoke(projectId: string, invitationId: string): Promise<void>;
  /**
   * The owner's role change of a member (slice 5-4): an MLS Commit the
   * Worker mirrors into the member list.
   */
  changeRole(
    projectId: string,
    userId: string,
    role: ProjectMemberRole
  ): Promise<void>;
  /** The owner's removal of a member (slice 5-5): an MLS Commit. */
  remove(projectId: string, userId: string): Promise<void>;
  /**
   * This account leaves (slice 5-5): a SelfRemove proposal, on which the
   * server drops its access at once.
   */
  leave(projectId: string): Promise<void>;
}

/** The page's client: crypto loads with the first encrypted dialog. */
export const pageEncryptedSharingClient: EncryptedSharingClient = {
  async list(projectId) {
    const [{ encryptedInvitations }, invitations] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/invitations')
    ]);
    const ctx = await encryptedInvitations();
    const listed = await invitations.projectInvitations(ctx, projectId);
    const { added, failed } = await invitations.completeReadyInvitations(
      ctx,
      listed
    );
    if (failed.length) throw failed[0]!.error;
    return added.length
      ? invitations.projectInvitations(ctx, projectId)
      : listed;
  },
  async invite(projectId, email, role) {
    const [{ encryptedInvitations }, { inviteToEncryptedProject }] =
      await Promise.all([
        import('../lib/e2ee/encryptedProjects'),
        import('../lib/e2ee/invitations')
      ]);
    await inviteToEncryptedProject(
      await encryptedInvitations(),
      projectId,
      email,
      role
    );
  },
  async revoke(projectId, invitationId) {
    const { encryptedInvitations } =
      await import('../lib/e2ee/encryptedProjects');
    await (await encryptedInvitations()).api.revoke(projectId, invitationId);
  },
  async changeRole(projectId, userId, role) {
    const { changeEncryptedMemberRole } =
      await import('../lib/e2ee/memberships');
    await changeEncryptedMemberRole(projectId, userId, role);
  },
  async remove(projectId, userId) {
    const { removeEncryptedMember } = await import('../lib/e2ee/memberships');
    await removeEncryptedMember(projectId, userId);
  },
  async leave(projectId) {
    const { leaveEncryptedProject } = await import('../lib/e2ee/memberships');
    await leaveEncryptedProject(projectId);
  }
};

const ENCRYPTED_STATE_LABELS: Record<OwnerInvitation['state'], string> = {
  invited: 'Invited',
  'waiting-for-keys': 'Waiting for keys',
  'waiting-for-verification': 'Waiting for you to verify',
  ready: 'Adding',
  completed: 'Added',
  revoked: 'Revoked',
  expired: 'Expired'
};

const OPEN_ENCRYPTED_STATES = new Set<OwnerInvitation['state']>([
  'invited',
  'waiting-for-keys',
  'waiting-for-verification',
  'ready'
]);

export interface ProjectSharingDialogProps {
  projectId: string;
  localProject?: boolean;
  localImportSourceNames?: readonly string[];
  savingToAccount?: boolean;
  onSaveToAccount?(): void | Promise<void>;
  onBeforeCreateShareLink?(): void | Promise<void>;
  role: ProjectAccessRole | null;
  collaborationStatus: CollaborationStatus;
  collaborationFailure?: string | null;
  onRetryConnection?(): void;
  lease: ProjectEditLease | null;
  liveMembers?: readonly CollaborationMember[];
  currentUserId?: UserId | null;
  /** The signed-in account's name, for the self row when no session is live. */
  currentUserName?: string | null;
  client?: ProjectSharingClient;
  shareLinkClient?: ProjectShareLinkClient;
  editorInvitationsEnabled?: boolean;
  /**
   * The project is end-to-end encrypted (slice 5-3b): invitations are
   * signed and members added through MLS, and roles change by the owner's
   * MLS Commit (slice 5-4); the owner's share links are encrypted ones
   * (slice 5-10, `EncryptedShareLinks`), and plaintext sharing is untouched. Editors need no edit-lease rollout here: an
   * encrypted project's editors write only on top of the head they read.
   */
  encrypted?: boolean;
  encryptedClient?: EncryptedSharingClient;
  /** Share links of the encrypted project (slice 5-10). */
  encryptedShareLinkClient?: EncryptedShareLinkClient;
  /** Opens Settings › Encryption at this person's code comparison. */
  onVerifyContact?(userId: string): void;
  /** This account left the encrypted project (slice 5-5). */
  onLeft?(): void;
  /** Shown beside the title so the popover says what it shares. */
  projectName?: string;
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

const LINK_MODE_LABELS: Record<ProjectShareLinkMode, string> = {
  tweak: 'Tweak',
  view: 'View'
};

const PRESENCE_LABELS: Record<CollaborationMember['status'], string> = {
  active: 'Active',
  idle: 'Idle'
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

/**
 * Compact time left on an invitation: `7d`, `3h`, or `expired`. Rounded up
 * like the hours, so a 7-day invitation reads 7d when it is sent, not 6d.
 */
function expiryLabel(expiresAt: number): string {
  const remaining = expiresAt * 1000 - Date.now();
  if (remaining <= 0) {
    return 'expired';
  }
  if (remaining >= 86_400_000) {
    return `${Math.ceil(remaining / 86_400_000)}d`;
  }
  return `${Math.ceil(remaining / 3_600_000)}h`;
}

/** The owner's name for a link, or the dated default an unnamed one shows. */
function shareLinkName(shareLink: ProjectShareLinkSummary): string {
  return (
    shareLink.label ??
    `${LINK_MODE_LABELS[shareLink.mode]} link · ${createdLabel(shareLink.createdAt)}`
  );
}

function shareLinkExpiryLabel(createdAt: number): string {
  const remaining = expiryLabel(createdAt + PROJECT_SHARE_LINK_TTL_SECONDS);
  return remaining === 'expired' ? 'Expired' : `Expires in ${remaining}`;
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
 * The top bar control this popover hangs from. Measured rather than passed
 * down: the dialog mounts from App while the chip lives in TopBar, and the
 * chip's position moves as the action row's responsive controls collapse.
 */
const ANCHOR_SELECTOR = '.collaboration-state';

interface PopoverAnchor {
  /** Gap from the viewport's right edge to the chip's right edge. */
  right: number;
  /** Distance from the chip's right edge to its centre, for the spring origin. */
  centre: number;
}

function measureAnchor(minGap: number): PopoverAnchor | null {
  const trigger = document.querySelector<HTMLElement>(ANCHOR_SELECTOR);
  if (!trigger) {
    return null;
  }
  const rect = trigger.getBoundingClientRect();
  if (rect.width === 0) {
    return null;
  }
  return {
    right: Math.max(minGap, Math.round(window.innerWidth - rect.right)),
    centre: Math.round(rect.width / 2)
  };
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
  collaborationFailure,
  onRetryConnection,
  lease,
  liveMembers = [],
  currentUserId = null,
  currentUserName = null,
  client = defaultClient,
  shareLinkClient = defaultShareLinkClient,
  editorInvitationsEnabled = true,
  encrypted = false,
  encryptedClient = pageEncryptedSharingClient,
  encryptedShareLinkClient,
  onVerifyContact,
  onLeft,
  projectName,
  onClose
}: ProjectSharingDialogProps) {
  const encryption = useEncryptionStatus(
    encrypted && !localProject ? projectId : null
  );
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const shareLinkUrlRef = useRef<HTMLInputElement | null>(null);
  const [sharing, setSharing] = useState<ProjectSharingResponse | null>(null);
  const [shareLinks, setShareLinks] = useState<ProjectShareLinkSummary[]>([]);
  const [encryptedInvitations, setEncryptedInvitations] = useState<
    OwnerInvitation[]
  >([]);
  const [createdShareLink, setCreatedShareLink] = useState<{
    url: string;
    shareLinkId: string;
  } | null>(null);
  const [stateCodeOpen, setStateCodeOpen] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState<UserId | null>(
    null
  );
  const removalCancelRef = useRef<HTMLButtonElement | null>(null);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [email, setEmail] = useState('');
  const personalInfoVisible = usePersonalInfoVisible();
  const [inviteRole, setInviteRole] = useState<ProjectMemberRole>('viewer');
  const [invitationSentTo, setInvitationSentTo] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(role === 'owner');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const actionOriginRef = useRef<HTMLElement | null>(null);
  useModalFocus(dialogRef, { autoFocus: true });

  useLayoutEffect(() => {
    const measure = () => setAnchor(measureAnchor(12));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

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
        if (encrypted) {
          // Encrypted: members from the metadata route, invitations (and
          // the Adds of verified invitees) through MLS; share links in EncryptedShareLinks.
          const nextSharing = await client.getProjectSharing(projectId);
          setSharing(nextSharing);
          setShareLinks([]);
          const nextInvitations = await encryptedClient.list(projectId);
          setEncryptedInvitations(nextInvitations);
          // An Add during the listing made a member: show it.
          const newMember = nextInvitations.some(
            (invitation) =>
              invitation.state === 'completed' &&
              !nextSharing.members.some(
                (member) => member.userId === invitation.record.acceptedByUserId
              )
          );
          if (newMember) {
            setSharing(await client.getProjectSharing(projectId));
          }
          return;
        }
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
    [
      client,
      shareLinkClient,
      projectId,
      role,
      localProject,
      encrypted,
      encryptedClient
    ]
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
    actionOriginRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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
  const editorsAllowed = encrypted || editorInvitationsEnabled;

  // Every control is disabled while an action runs, and a revoke or remove
  // takes its own row away, so the control that started it drops focus on
  // the body: out of the dialog, past Tab order and the error it may show.
  // Once the action settles, focus goes back to that control or, when it is
  // gone, to the dialog itself.
  useEffect(() => {
    if (interactionBusy) {
      return;
    }
    const origin = actionOriginRef.current;
    actionOriginRef.current = null;
    const dialog = dialogRef.current;
    if (!origin || !dialog) {
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      return;
    }
    if (origin.isConnected && dialog.contains(origin)) {
      origin.focus();
    }
    if (!dialog.contains(document.activeElement)) {
      dialog.focus();
    }
  }, [interactionBusy]);

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
  } else if (encrypted) {
    // No room lease: the account accepts an editor's version only on top
    // of the head it read.
    footerParts.push('you can edit');
  } else {
    footerParts.push(
      leaseIsActive ? 'you hold the edit lease' : 'edit lease not held'
    );
  }

  // Cancel, not Remove, takes focus when a removal is confirmed.
  useEffect(() => {
    if (confirmingRemoval !== null) {
      removalCancelRef.current?.focus();
    }
  }, [confirmingRemoval]);

  const removeMember = (member: { userId: UserId }) =>
    void mutate(`remove:${member.userId}`, async () => {
      if (encrypted) {
        await encryptedClient.remove(projectId, member.userId);
      } else {
        await client.removeMember(projectId, member.userId);
      }
      setConfirmingRemoval(null);
      await refresh();
    });

  const pendingCount =
    (sharing?.invitations.length ?? 0) +
    (encrypted
      ? encryptedInvitations.filter((invitation) =>
          OPEN_ENCRYPTED_STATES.has(invitation.state)
        ).length
      : 0);
  const connectionLost =
    !localProject &&
    (collaborationStatus === 'offline' || collaborationStatus === 'rejected');

  return (
    <div
      className="modal-backdrop sharing-backdrop"
      style={
        anchor
          ? ({
              '--sharing-anchor-right': `${anchor.right}px`,
              '--sharing-anchor-centre': `${anchor.centre}px`
            } as CSSProperties)
          : undefined
      }
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
        aria-label="Project sharing"
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
          <h2 className="sharing-title">
            Share
            {projectName ? (
              <span className="sharing-title-project"> · {projectName}</span>
            ) : null}
          </h2>
          {encrypted && !localProject ? (
            <button
              type="button"
              className="sharing-encrypted-chip"
              aria-expanded={stateCodeOpen}
              aria-controls="sharing-state-code"
              title="End-to-end encrypted. Show the project state code."
              onClick={() => setStateCodeOpen((open) => !open)}
            >
              <Lock size={11} aria-hidden="true" />
              Encrypted
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            aria-label="Close sharing"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="sharing-body">
          {encrypted && !localProject && stateCodeOpen ? (
            <section
              id="sharing-state-code"
              className="sharing-section sharing-state-comparison"
              aria-label="Project state code"
            >
              <h3 className="sharing-section-label">Project state code</h3>
              {encryption.projectStateCode ? (
                <>
                  <code className="sharing-state-code">
                    {encryption.projectStateCode}
                  </code>
                  <p className="sharing-hint">
                    Load the latest saved version, then compare this code with a
                    collaborator outside OpenZCAD. If the codes match, you both
                    see the same saved version.
                  </p>
                </>
              ) : (
                <p className="sharing-hint">
                  Load and verify the project to compare its state code.
                </p>
              )}
            </section>
          ) : null}
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
              <p className="sharing-hint">
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
            <section className="sharing-section sharing-invite-section">
              <form
                className="sharing-invite"
                aria-label="Invite a collaborator"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate('invite', async () => {
                    setInvitationSentTo(null);
                    if (encrypted) {
                      await encryptedClient.invite(
                        projectId,
                        email,
                        inviteRole
                      );
                      setInvitationSentTo(email.trim().toLowerCase());
                    } else {
                      const created = await client.createInvitation(
                        projectId,
                        email,
                        inviteRole
                      );
                      setInvitationSentTo(created.invitation.email);
                    }
                    setEmail('');
                    await refresh();
                  });
                }}
              >
                <PrivateEmailInput
                  visible={personalInfoVisible}
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
                  <option
                    value="editor"
                    disabled={!editorsAllowed}
                    title={
                      editorsAllowed
                        ? undefined
                        : 'Editor invitations are not available yet.'
                    }
                  >
                    Editor
                  </option>
                </select>
                <button
                  type="submit"
                  className="primary"
                  disabled={interactionBusy}
                >
                  Invite
                </button>
              </form>
              {invitationSentTo && (
                <p className="sharing-invite-sent" role="status">
                  {personalInfoVisible
                    ? `Invitation sent to ${invitationSentTo}.`
                    : 'Invitation sent.'}
                </p>
              )}
            </section>
          ) : null}
          {!localProject && (people.length > 0 || isOwner) ? (
            <section
              className="sharing-section sharing-people"
              aria-label="People"
            >
              <h3 className="sharing-section-label">
                People with access · {people.length + pendingCount}
              </h3>
              <ul className="sharing-list">
                {people.map((person, index) => {
                  // Numbered among the others: the self row is "You", so
                  // counting it started the list at Collaborator 2.
                  const name = personalInfoVisible
                    ? person.name
                    : person.kind === 'self'
                      ? 'You'
                      : `Collaborator ${index + (people[0]?.kind === 'self' ? 0 : 1)}`;
                  const member =
                    person.kind === 'member'
                      ? memberByUser.get(person.userId)
                      : undefined;
                  const manageable = Boolean(member && isOwner);
                  if (
                    member &&
                    manageable &&
                    confirmingRemoval === member.userId
                  ) {
                    return (
                      <li key={person.key} className="sharing-confirm-row">
                        <div
                          className="sharing-confirm"
                          role="group"
                          aria-label={`Remove ${name}`}
                        >
                          <p className="sharing-confirm-title">
                            Remove {name}?
                          </p>
                          <p className="sharing-hint">
                            {encrypted
                              ? 'Removing someone keeps them out of every later version. What they already opened or saved stays with them.'
                              : 'They lose access to this project right away.'}
                          </p>
                          <div className="sharing-confirm-actions">
                            <button
                              ref={removalCancelRef}
                              type="button"
                              className="secondary"
                              disabled={interactionBusy}
                              onClick={() => setConfirmingRemoval(null)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="secondary danger"
                              disabled={interactionBusy}
                              onClick={() => removeMember(member)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  }
                  return (
                    <li key={person.key}>
                      <span
                        className="sharing-avatar"
                        data-presence={person.presence ?? undefined}
                        aria-hidden="true"
                      >
                        {personalInfoVisible ? person.initial : '?'}
                      </span>
                      <span className="sharing-member-id">
                        {name}
                        {personalInfoVisible && person.you ? ' (you)' : ''}
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
                          {PRESENCE_LABELS[person.presence ?? 'idle']}
                        </span>
                      ) : null}
                      {member && !isOwner ? (
                        <span className="sharing-kind">
                          {ROLE_LABELS[member.role]}
                        </span>
                      ) : null}
                      {member && manageable ? (
                        <>
                          <select
                            className="sharing-role-select"
                            aria-label={`Role for ${name}`}
                            value={member.role}
                            disabled={interactionBusy}
                            onChange={(event) =>
                              void mutate(
                                `member:${member.userId}`,
                                async () => {
                                  const nextRole = event.target
                                    .value as ProjectMemberRole;
                                  if (encrypted) {
                                    await encryptedClient.changeRole(
                                      projectId,
                                      member.userId,
                                      nextRole
                                    );
                                  } else {
                                    await client.updateMemberRole(
                                      projectId,
                                      member.userId,
                                      nextRole
                                    );
                                  }
                                  await refresh();
                                }
                              )
                            }
                          >
                            <option value="viewer">Viewer</option>
                            <option
                              value="editor"
                              disabled={!encrypted && !editorInvitationsEnabled}
                            >
                              Editor
                            </option>
                          </select>
                          <button
                            type="button"
                            className="sharing-row-action sharing-row-icon"
                            aria-label={`Remove ${name}`}
                            title="Remove access"
                            disabled={interactionBusy}
                            onClick={() => setConfirmingRemoval(member.userId)}
                          >
                            <X size={13} aria-hidden="true" />
                          </button>
                        </>
                      ) : null}
                    </li>
                  );
                })}
                {(sharing?.invitations ?? []).map((invitation, index) => (
                  <li key={invitation.invitationId} className="sharing-pending">
                    <span
                      className="sharing-avatar sharing-avatar-pending"
                      aria-hidden="true"
                    >
                      {personalInfoVisible ? initialOf(invitation.email) : '?'}
                    </span>
                    <span className="sharing-row-text">
                      <span className="sharing-member-id">
                        {personalInfoVisible
                          ? invitation.email
                          : `Invitation ${index + 1}`}
                      </span>
                      <span className="sharing-row-detail">
                        Invited · {ROLE_LABELS[invitation.role]} ·{' '}
                        {expiryLabel(invitation.expiresAt)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="sharing-row-action sharing-row-icon"
                      aria-label={`Revoke invitation for ${personalInfoVisible ? invitation.email : `Invitation ${index + 1}`}`}
                      title="Revoke invitation"
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
                      <X size={13} aria-hidden="true" />
                    </button>
                  </li>
                ))}
                {encrypted
                  ? encryptedInvitations
                      .filter((invitation) =>
                        OPEN_ENCRYPTED_STATES.has(invitation.state)
                      )
                      .map((invitation, index) => {
                        const label =
                          personalInfoVisible && invitation.email
                            ? invitation.email
                            : `Invitation ${index + 1}`;
                        const invitee = invitation.record.acceptedByUserId;
                        return (
                          <li
                            key={invitation.record.invitationId}
                            className="sharing-pending"
                          >
                            <span
                              className="sharing-avatar sharing-avatar-pending"
                              aria-hidden="true"
                            >
                              {personalInfoVisible && invitation.email
                                ? initialOf(invitation.email)
                                : '?'}
                            </span>
                            <span className="sharing-row-text">
                              <span className="sharing-member-id">{label}</span>
                              <span
                                className="sharing-row-detail"
                                data-status={invitation.state}
                              >
                                {ENCRYPTED_STATE_LABELS[invitation.state]} ·{' '}
                                {ROLE_LABELS[invitation.record.role]} ·{' '}
                                {expiryLabel(
                                  Math.floor(invitation.record.expiresAt / 1000)
                                )}
                              </span>
                            </span>
                            {invitation.state === 'waiting-for-verification' &&
                            invitee &&
                            onVerifyContact ? (
                              <button
                                type="button"
                                className="secondary sharing-verify"
                                aria-label={`Verify ${label}`}
                                disabled={interactionBusy}
                                onClick={() => onVerifyContact(invitee)}
                              >
                                Verify
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="sharing-row-action sharing-row-icon"
                              aria-label={`Revoke invitation for ${label}`}
                              title="Revoke invitation"
                              disabled={interactionBusy}
                              onClick={() =>
                                void mutate(
                                  `revoke:${invitation.record.invitationId}`,
                                  async () => {
                                    await encryptedClient.revoke(
                                      projectId,
                                      invitation.record.invitationId
                                    );
                                    await refresh();
                                  }
                                )
                              }
                            >
                              <X size={13} aria-hidden="true" />
                            </button>
                          </li>
                        );
                      })
                  : null}
              </ul>
            </section>
          ) : null}

          {!localProject && !isOwner ? (
            <p className="sharing-hint sharing-owner-note">
              {role === null
                ? 'Connecting to project sharing. Your cloud access has not been confirmed yet.'
                : 'Only the project owner can manage members and invitations.'}
            </p>
          ) : null}

          {isOwner && !encrypted ? (
            <PlaintextShareLinks
              shareLinks={shareLinks}
              created={createdShareLink}
              copied={shareLinkCopied}
              disabled={interactionBusy}
              localImportSourceNames={localImportSourceNames}
              urlRef={shareLinkUrlRef}
              onCopy={(url) => void copyShareLink(url)}
              onCreate={() =>
                void mutate('share-link:create', async () => {
                  await onBeforeCreateShareLink?.();
                  setCreatedShareLink(null);
                  setShareLinkCopied(false);
                  const created = await shareLinkClient.createProjectShareLink(
                    projectId,
                    'tweak'
                  );
                  setCreatedShareLink({
                    url: buildShareLinkUrl(created.token),
                    shareLinkId: created.shareLink.shareLinkId
                  });
                  await refresh();
                })
              }
              onRename={(shareLink, draft) =>
                mutate(
                  `share-link:rename:${shareLink.shareLinkId}`,
                  async () => {
                    const label = normalizeShareLinkLabel(draft);
                    if (label === shareLink.label) {
                      return;
                    }
                    await shareLinkClient.renameProjectShareLink(
                      projectId,
                      shareLink.shareLinkId,
                      label
                    );
                    await refresh();
                  }
                )
              }
              onRevoke={(shareLink) =>
                void mutate(
                  `share-link:revoke:${shareLink.shareLinkId}`,
                  async () => {
                    await shareLinkClient.revokeProjectShareLink(
                      projectId,
                      shareLink.shareLinkId
                    );
                    setCreatedShareLink(null);
                    await refresh();
                  }
                )
              }
            />
          ) : null}

          {isOwner && encrypted ? (
            <EncryptedShareLinks
              projectId={projectId}
              {...(encryptedShareLinkClient
                ? { client: encryptedShareLinkClient }
                : {})}
            />
          ) : null}

          {!localProject &&
          encrypted &&
          (role === 'editor' || role === 'viewer') ? (
            confirmingLeave ? (
              <div
                className="sharing-leave sharing-confirm"
                role="group"
                aria-label="Leave this project"
              >
                <p className="sharing-hint">
                  You lose access to this project at once and are not told of
                  later changes. To come back, the owner has to invite you
                  again.
                </p>
                <div className="sharing-confirm-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={interactionBusy}
                    onClick={() => setConfirmingLeave(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="secondary danger"
                    disabled={interactionBusy}
                    onClick={() =>
                      void mutate('leave', async () => {
                        await encryptedClient.leave(projectId);
                        setConfirmingLeave(false);
                        onLeft?.();
                      })
                    }
                  >
                    Leave project
                  </button>
                </div>
              </div>
            ) : (
              <div className="sharing-leave-row">
                <button
                  type="button"
                  className="sharing-leave-button"
                  disabled={interactionBusy}
                  onClick={() => setConfirmingLeave(true)}
                >
                  Leave project…
                </button>
              </div>
            )
          ) : null}
        </div>

        {!localProject ? (
          <footer
            className="sharing-footer"
            data-lost={connectionLost || undefined}
          >
            <span
              className="sharing-room-dot"
              data-state={collaborationStatus}
              aria-hidden="true"
            />
            <span className="sharing-footer-text">
              {footerParts.join(' · ')}
            </span>
            {connectionLost && onRetryConnection ? (
              <button
                type="button"
                className="sharing-footer-action"
                onClick={onRetryConnection}
              >
                Retry connection
              </button>
            ) : null}
            {connectionLost ? (
              <p className="sharing-footer-notice" role="status">
                <span>
                  {collaborationFailure ?? 'The live session is unavailable.'}
                </span>{' '}
                <span>
                  Live updates are not confirmed. Reconnecting keeps your
                  current work in this tab.
                </span>
              </p>
            ) : null}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

interface PlaintextShareLinksProps {
  shareLinks: readonly ProjectShareLinkSummary[];
  created: { url: string; shareLinkId: string } | null;
  copied: boolean;
  disabled: boolean;
  localImportSourceNames: readonly string[];
  urlRef: RefObject<HTMLInputElement | null>;
  onCopy(url: string): void;
  onCreate(): void;
  onRename(shareLink: ProjectShareLinkSummary, draft: string): Promise<void>;
  onRevoke(shareLink: ProjectShareLinkSummary): void;
}

/**
 * General access for an unencrypted project: one summary line saying who can
 * open it, the link just created (shown once, with an optional name), and
 * every unrevoked link with its owner-only name, rename and revoke.
 */
function PlaintextShareLinks({
  shareLinks,
  created,
  copied,
  disabled,
  localImportSourceNames,
  urlRef,
  onCopy,
  onCreate,
  onRename,
  onRevoke
}: PlaintextShareLinksProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Keyed by link, so a newly created link starts unnamed.
  const [createdDraft, setCreatedDraft] = useState({ id: '', name: '' });
  const createdName =
    created && createdDraft.id === created.shareLinkId ? createdDraft.name : '';
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const editingRowRef = useRef<string | null>(null);

  useEffect(() => {
    if (editingId !== null) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [editingId]);

  const createdLink = created
    ? shareLinks.find((link) => link.shareLinkId === created.shareLinkId)
    : undefined;
  const startRename = (shareLink: ProjectShareLinkSummary) => {
    editingRowRef.current = shareLink.shareLinkId;
    setDraft(shareLink.label ?? '');
    setEditingId(shareLink.shareLinkId);
  };
  const stopRename = () => {
    setEditingId(null);
    const id = editingRowRef.current;
    editingRowRef.current = null;
    // Back to the control that started the edit, for the keyboard.
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(`[data-share-link-name="${id ?? ''}"]`)
        ?.focus()
    );
  };

  return (
    <section
      className="sharing-section sharing-access-section"
      aria-label="General access"
    >
      <h3 className="sharing-section-label">General access</h3>
      <div className="sharing-access">
        <span className="sharing-access-icon" aria-hidden="true">
          <Globe size={13} />
        </span>
        <span className="sharing-access-text">
          <span className="sharing-access-title">
            {shareLinks.length > 0
              ? `Anyone with a link · ${shareLinks.length} active`
              : 'Only invited people'}
          </span>
          <span className="sharing-access-detail">
            Opens in Tweak: parameters and export, no account needed. Links
            expire 30 days after creation.
          </span>
        </span>
        <button
          type="button"
          className={shareLinks.length > 0 ? 'secondary' : 'primary'}
          disabled={disabled || localImportSourceNames.length > 0}
          onClick={onCreate}
        >
          Create link
        </button>
      </div>
      {localImportSourceNames.length > 0 && (
        <p className="sharing-hint" role="alert">
          Save the source files for {localImportSourceNames.join(', ')} to your
          account with File → Save before creating a link.
        </p>
      )}
      {created && (
        <div className="sharing-share-output" role="status">
          <input
            className="sharing-share-name"
            type="text"
            aria-label="New link name"
            placeholder="Name this link (optional)"
            maxLength={PROJECT_SHARE_LINK_LABEL_MAX_LENGTH}
            value={createdName}
            disabled={!createdLink}
            onChange={(event) =>
              setCreatedDraft({
                id: created.shareLinkId,
                name: event.target.value
              })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            onBlur={() => {
              if (createdLink) {
                void onRename(createdLink, createdName);
              }
            }}
          />
          <input
            ref={urlRef}
            className="sharing-share-url"
            type="text"
            readOnly
            aria-label="Share link"
            value={created.url}
            onFocus={(event) => event.target.select()}
          />
          <button
            type="button"
            className="primary sharing-share-copy"
            onClick={() => onCopy(created.url)}
          >
            <StableLabel reserve={['Copied', 'Copy']} align="center">
              {copied ? 'Copied' : 'Copy'}
            </StableLabel>
          </button>
          <p className="sharing-share-once">Shown once — copy it now.</p>
        </div>
      )}
      {shareLinks.length > 0 && (
        <ul className="sharing-list" aria-label="Share links">
          {shareLinks.map((shareLink) => {
            const name = shareLinkName(shareLink);
            if (editingId === shareLink.shareLinkId) {
              return (
                <li key={shareLink.shareLinkId}>
                  <form
                    className="sharing-rename"
                    aria-label={`Rename ${name}`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void onRename(shareLink, draft).finally(stopRename);
                    }}
                  >
                    <input
                      ref={renameInputRef}
                      type="text"
                      aria-label="Link name"
                      placeholder={`${LINK_MODE_LABELS[shareLink.mode]} link · ${createdLabel(shareLink.createdAt)}`}
                      maxLength={PROJECT_SHARE_LINK_LABEL_MAX_LENGTH}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          // Cancels the edit only, not the whole popover.
                          event.preventDefault();
                          event.stopPropagation();
                          stopRename();
                        }
                      }}
                    />
                    <button
                      type="submit"
                      className="primary"
                      disabled={disabled}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={stopRename}
                    >
                      Cancel
                    </button>
                  </form>
                </li>
              );
            }
            return (
              <li key={shareLink.shareLinkId}>
                <span className="sharing-row-text">
                  <button
                    type="button"
                    className="sharing-link-name"
                    data-share-link-name={shareLink.shareLinkId}
                    data-unnamed={shareLink.label === null || undefined}
                    title="Rename"
                    aria-label={`Rename ${name}`}
                    disabled={disabled}
                    onClick={() => startRename(shareLink)}
                  >
                    {name}
                  </button>
                  <span className="sharing-row-detail">
                    {shareLink.label === null
                      ? `${LINK_MODE_LABELS[shareLink.mode]} · ${shareLinkExpiryLabel(shareLink.createdAt)}`
                      : `${LINK_MODE_LABELS[shareLink.mode]} · created ${createdLabel(shareLink.createdAt)} · ${shareLinkExpiryLabel(shareLink.createdAt)}`}
                  </span>
                </span>
                <button
                  type="button"
                  className="sharing-row-action"
                  aria-label={
                    shareLink.label === null
                      ? `Revoke share link created ${createdLabel(shareLink.createdAt)}`
                      : `Revoke share link ${shareLink.label}`
                  }
                  disabled={disabled}
                  onClick={() => onRevoke(shareLink)}
                >
                  Revoke
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
