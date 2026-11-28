import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type { CSSProperties, RefObject } from 'react';
import { Lock, UserRound, X } from 'lucide-react';
import type {
  CollaborationMember,
  ProjectAccessRole,
  ProjectDocument,
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
import { withShareConfiguration } from '../lib/projectShareLink';
import type { CollaborationStatus } from '../lib/useCollaboration';
import { useModalFocus } from '../lib/useModalFocus';
import { ShareLinkRevokeConfirm } from './ShareLinkRevokeConfirm';
import {
  EncryptedShareLinks,
  type EncryptedShareLinkClient,
  type EncryptedShareLinksSummary
} from './EncryptedShareLinks';
import { ShareLinkDrawings } from './ShareLinkDrawings';
import {
  ShareLinkCard,
  ShareLinkComposer,
  ShareLinkCopyButton,
  ShareLinkFacts,
  ShareLinkNameField
} from './ShareLinkCard';
import type { OwnerInvitation, PersonTrust } from '../lib/e2ee/invitations';
import type { UnlockAuthorization } from '../lib/e2ee/accountKeys';
import type { AuthorizeRequest } from './encryption/AuthorizeDialog';
import { lazyWithStaleChunkNotice } from '../lib/staleChunk';
import { useEncryptionStatus } from '../lib/e2ee/encryptionStatus';
import { describeFailure, type PlainFailure } from '../lib/plainFailure';
import { FailureDetails } from './FailureDetails';
import { PrivateEmailInput, usePersonalInfoVisible } from './PersonalInfo';

const defaultClient = createProjectSharingClient();
/** The passkey-or-recovery-key confirmation, loaded with its crypto. */
const LazyAuthorizeDialog = lazyWithStaleChunkNotice(() =>
  import('./encryption/AuthorizeDialog').then((module) => ({
    default: module.AuthorizeDialog
  }))
);
const defaultShareLinkClient = createProjectShareLinkClient();

/**
 * Invitations to an end-to-end encrypted project (ADR-024 slice 5-3b): the
 * owner's browser signs each one, adds whoever accepts by signature by an
 * MLS Commit (trust on first use) and keeps the invitee's address locally,
 * so the dialog asks this client instead of the plaintext routes, which
 * refuse encrypted projects.
 */
export interface EncryptedSharingClient {
  /** The project's open invitations, after adding every ready invitee. */
  list(projectId: string): Promise<OwnerInvitation[]>;
  /** One email, one role: whoever accepts it is added on first use. */
  invite(
    projectId: string,
    email: string,
    role: ProjectMemberRole
  ): Promise<void>;
  /** Revokes an invitation, or declines one someone accepted. */
  revoke(projectId: string, invitationId: string): Promise<void>;
  /**
   * The owner's explicit confirmation of the person who accepted
   * (`confirm-new` for someone new to the account, `confirm-add`, or
   * `confirm-re-add` for someone removed before), by the identity the
   * confirmation showed: never done in the background. Someone new is
   * trusted first, signed with `authorization` (a passkey touch or the
   * recovery key), then added.
   */
  confirmAdd?(
    projectId: string,
    invitationId: string,
    identityKeyHash: string,
    authorization?: UnlockAuthorization
  ): Promise<void>;
  /** Where this browser stands with each person's keys; unknown ones left out. */
  peopleTrust?(userIds: readonly string[]): Promise<PersonTrust[]>;
  /**
   * The owner's explicit "Trust new keys" for someone whose identity
   * changed, by the identity shown, signed with `authorization`: never done
   * in the background.
   */
  trustNewKeys?(
    userId: string,
    identityKeyHash: string,
    authorization: UnlockAuthorization
  ): Promise<void>;
  /** Whether a passkey can sign here (the account has one, and PRF works). */
  passkeyAvailable?(): Promise<boolean>;
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
    const [{ encryptedInvitations }, invitations, { syncInvitationsNow }] =
      await Promise.all([
        import('../lib/e2ee/encryptedProjects'),
        import('../lib/e2ee/invitations'),
        import('../lib/e2ee/invitationRunner')
      ]);
    // The app's invitation runner adds every ready invitee (single-flight
    // with its background passes); a failed Add of this project's is said.
    const pass = await syncInvitationsNow();
    const failed = pass?.failed.find(
      (failure) => failure.invitation.record.projectId === projectId
    );
    if (failed) throw failed.error;
    return invitations.projectInvitations(
      await encryptedInvitations(),
      projectId
    );
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
  async peopleTrust(userIds) {
    const [{ encryptedInvitations }, { peopleTrust }] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/invitations')
    ]);
    return peopleTrust(await encryptedInvitations(), userIds);
  },
  async trustNewKeys(userId, identityKeyHash, authorization) {
    const [{ encryptedInvitations }, { trustPerson }] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/invitations')
    ]);
    await trustPerson(
      await encryptedInvitations(),
      userId,
      identityKeyHash,
      authorization
    );
  },
  async passkeyAvailable() {
    const [{ encryptedInvitations }, { passkeysAvailable }] = await Promise.all(
      [import('../lib/e2ee/encryptedProjects'), import('../lib/e2ee/passkeys')]
    );
    const ctx = await encryptedInvitations();
    return (
      passkeysAvailable() &&
      ctx.groups.account.list.unlockTargets.some(
        (target) => target.kind === 'passkey'
      )
    );
  },
  async revoke(projectId, invitationId) {
    const [{ encryptedInvitations }, { cancelInvitation }] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/invitationTombstones')
    ]);
    // Recorded in the account's sealed tombstones first, then revoked.
    await cancelInvitation(
      await encryptedInvitations(),
      projectId,
      invitationId
    );
  },
  async confirmAdd(projectId, invitationId, identityKeyHash, authorization) {
    const [{ encryptedInvitations }, invitations] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/invitations')
    ]);
    const ctx = await encryptedInvitations();
    const listed = await invitations.projectInvitations(ctx, projectId);
    const invitation = listed.find(
      (entry) => entry.record.invitationId === invitationId
    );
    if (
      !invitation ||
      !CONFIRMABLE_STATES.has(invitation.state) ||
      invitation.acceptor?.identityKeyHash !== identityKeyHash
    ) {
      throw new Error(
        'This invitation changed since you reviewed it. Nothing was added; check it again.'
      );
    }
    // Someone new to the account: the signed trust first, then the Add.
    if (!invitation.acceptor.pinned) {
      if (authorization === undefined) {
        throw new Error('Confirm with your passkey or recovery key first.');
      }
      await invitations.trustPerson(
        ctx,
        invitation.acceptor.userId,
        identityKeyHash,
        authorization
      );
    }
    await invitations.addInvitedMember(ctx, invitation.record, {
      confirmedIdentity: identityKeyHash
    });
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
  'keys-changed': 'Encryption keys changed',
  'needs-acceptance': 'Waiting for them to accept again',
  'confirm-re-add': 'Removed before: confirm to add back',
  'confirm-new': 'Accepted: confirm to add',
  'confirm-add': 'Accepted: confirm to add',
  'accepted-by-other': 'Accepted by someone you did not invite',
  ready: 'Adding',
  completed: 'Added',
  revoked: 'Revoked',
  expired: 'Expired'
};

const OPEN_ENCRYPTED_STATES = new Set<OwnerInvitation['state']>([
  'invited',
  'waiting-for-keys',
  'keys-changed',
  'needs-acceptance',
  'confirm-re-add',
  'confirm-new',
  'confirm-add',
  'accepted-by-other',
  'ready'
]);

/** Invitations the owner confirms (or declines) before anyone is added. */
const CONFIRMABLE_STATES = new Set<OwnerInvitation['state']>([
  'confirm-new',
  'confirm-add',
  'confirm-re-add'
]);

/** What a sharing action hands out; see `outputRefusal`. */
export type SharingOutput =
  'save-to-account' | 'share-link' | 'share-frozen-model' | 'share-invite';

/**
 * The output an action of this dialog hands out, by its `mutate` key, or
 * null for one that hands out nothing (revoke, remove, rename, decline,
 * leave). Every action runs through `mutate`, so this is the dialog's one
 * place a refusal is asked.
 */
export function sharingActionOutput(key: string): SharingOutput | null {
  if (key === 'save-account') return 'save-to-account';
  if (key === 'share-link:create' || key.startsWith('share-link:update:'))
    return 'share-link';
  if (key === 'invite') return 'share-invite';
  return null;
}

export interface ProjectSharingDialogProps {
  projectId: string;
  localProject?: boolean;
  localImportSourceNames?: readonly string[];
  savingToAccount?: boolean;
  onSaveToAccount?(): void | Promise<void>;
  onBeforeCreateShareLink?(): void | Promise<void>;
  /**
   * L08: the current model frozen for a link without history, one imported
   * solid per body and nothing of how it was built. Without it the option
   * to leave history out is not offered.
   */
  /**
   * L08: the current model for a link without history: imported solids, or
   * with `parameters` the recipe a visitor may tweak
   * (`tweakableShareDocument`).
   */
  onFreezeModel?(options?: { parameters?: boolean }): Promise<ProjectDocument>;
  /**
   * Why the project is not handed out right now, when it is not: asked
   * before an account save, a link made or updated, or an invitation, and
   * shown in its place before anything is saved, frozen or sent. A saved
   * version previewed in place of the project is not the model any of them
   * hands out. Revoking, removing, renaming and leaving are never refused.
   */
  outputRefusal?(output: SharingOutput): string | null;
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
  /**
   * F06: the model's configurations. A new link can name the one it opens
   * on; without a choice it opens on the row the model was saved with.
   */
  configurations?: readonly { id: string; name: string }[];
  /** L08: the project's drawing sheets, for choosing which links show. */
  drawingSheets?: readonly { id: string; name: string }[];
  /** The sheets links show now. */
  sharedSheetIds?: readonly string[];
  /** Changes that choice; absent where the project cannot be edited. */
  onSharedSheetsChange?(sheetIds: string[]): void;
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

/** An invitation's role in a sentence. */
const ROLE_ARTICLES: Record<'editor' | 'viewer', string> = {
  editor: 'an editor',
  viewer: 'a viewer'
};

/** An avatar with personal info hidden: a person, not a question mark. */
function HiddenPerson() {
  return <UserRound size={13} aria-hidden="true" />;
}

/** Whether two addresses (either may be unknown) are the same one. */
function sameAddress(a: string | null, b: string | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

/**
 * Verified or Not verified (ADR-024 amendment 2026-11-25): whether the
 * owner compared codes with this person. Shown only; nothing waits on it.
 * "Verify…" opens the code comparison.
 */
function TrustBadge({
  name,
  userId,
  verified,
  busy,
  onVerify
}: {
  name: string;
  userId: string;
  verified: boolean;
  busy: boolean;
  onVerify?: ((userId: string) => void) | undefined;
}) {
  return (
    <>
      <span className="sharing-trust" data-verified={verified}>
        {verified ? 'Verified' : 'Not verified'}
      </span>
      {!verified && onVerify ? (
        <button
          type="button"
          className="secondary sharing-verify"
          aria-label={`Verify ${name}`}
          disabled={busy}
          onClick={() => onVerify(userId)}
        >
          Verify…
        </button>
      ) : null}
    </>
  );
}

/**
 * A person whose identity is not the one this browser pinned for them:
 * nothing is added or shared with them automatically until the owner
 * reviews the change (compares codes) or trusts the new keys explicitly.
 */
function KeysChanged({
  name,
  userId,
  busy,
  onReview,
  onTrust,
  onDecline,
  onRemove
}: {
  name: string;
  userId: string;
  busy: boolean;
  onReview?: ((userId: string) => void) | undefined;
  onTrust?: (() => void) | undefined;
  onDecline?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className="sharing-confirm"
      role="group"
      aria-label={`${name}'s encryption keys changed`}
      data-status="keys-changed"
    >
      <p className="sharing-confirm-title">{name}'s encryption keys changed</p>
      <p className="sharing-hint">
        Nothing is shared with them automatically until you review the change.
        Compare codes with them, or trust the new keys if you know why they
        changed (a new account or a reset).
      </p>
      <div className="sharing-confirm-actions">
        {onDecline ? (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onDecline}
          >
            Decline
          </button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onRemove}
          >
            Remove
          </button>
        ) : null}
        {onReview ? (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onReview(userId)}
          >
            Review
          </button>
        ) : null}
        {onTrust ? (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={onTrust}
          >
            Trust new keys
          </button>
        ) : null}
      </div>
    </div>
  );
}

const LINK_MODE_LABELS: Record<ProjectShareLinkMode, string> = {
  tweak: 'Tweak',
  view: 'View'
};

/** A link's access as its row says it: the mode, and what it leaves out. */
function linkAccessLabel(shareLink: ProjectShareLinkSummary): string {
  return shareLink.history === false
    ? `${LINK_MODE_LABELS[shareLink.mode]} · No history, as of ${createdLabel(shareLink.frozenAt ?? shareLink.createdAt)}`
    : LINK_MODE_LABELS[shareLink.mode];
}

const PRESENCE_LABELS: Record<CollaborationMember['status'], string> = {
  active: 'Active',
  idle: 'Idle'
};

function errorMessage(error: unknown): PlainFailure {
  // A proxy's HTML page or a dropped connection read as "Unexpected token
  // '<', "<!doctype "… is not valid JSON"; the raw text is under Details.
  return describeFailure(error, { fallback: 'The sharing request failed.' });
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
    `${shareLink.comments ? 'Commenter' : LINK_MODE_LABELS[shareLink.mode]} link · ${createdLabel(shareLink.createdAt)}`
  );
}

/** The expiry date and the time left, for an open link card. */
function shareLinkExpiryDetail(createdAt: number): string {
  const expiresAt = createdAt + PROJECT_SHARE_LINK_TTL_SECONDS;
  const remaining = expiryLabel(expiresAt);
  return remaining === 'expired'
    ? `${createdLabel(expiresAt)} · expired`
    : `${createdLabel(expiresAt)} · in ${remaining}`;
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
  onFreezeModel,
  outputRefusal,
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
  configurations = [],
  drawingSheets,
  sharedSheetIds,
  onSharedSheetsChange,
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
    mode: ProjectShareLinkMode;
  } | null>(null);
  const [stateCodeOpen, setStateCodeOpen] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState<UserId | null>(
    null
  );
  const removalCancelRef = useRef<HTMLButtonElement | null>(null);
  const [email, setEmail] = useState('');
  const personalInfoVisible = usePersonalInfoVisible();
  const [inviteRole, setInviteRole] = useState<ProjectMemberRole>('viewer');
  // Where this browser stands with each encrypted member's keys: Verified,
  // Not verified, or keys changed (trust on first use).
  const [memberTrust, setMemberTrust] = useState<
    ReadonlyMap<string, PersonTrust>
  >(new Map());
  // The passkey-or-recovery-key confirmation of a signed trust: for someone
  // new to the account, and for Trust new keys. Never in the background.
  const [signature, setSignature] = useState<AuthorizeRequest | null>(null);
  const [signing, setSigning] = useState(false);
  const askSignature = async (
    request: Omit<AuthorizeRequest, 'passkey' | 'work'> & {
      work(authorization: UnlockAuthorization): Promise<void>;
    }
  ) => {
    const passkey = await (
      encryptedClient.passkeyAvailable?.() ?? Promise.resolve(false)
    ).catch(() => false);
    setSignature({ ...request, passkey });
  };
  const runSignature = async (
    work: () => Promise<unknown>,
    options?: { onError?(message: string): void }
  ): Promise<boolean> => {
    setSigning(true);
    try {
      await work();
      return true;
    } catch (caught) {
      const failure = errorMessage(caught);
      if (options?.onError) options.onError(failure.message);
      else setError(failure);
      return false;
    } finally {
      setSigning(false);
    }
  };
  const [invitationSentTo, setInvitationSentTo] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(role === 'owner');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<PlainFailure | null>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  // The owner's two tabs: people (members and invitations) and links.
  const [tab, setTab] = useState<'people' | 'links'>('people');
  const tabsId = useId();
  const [encryptedLinksSummary, setEncryptedLinksSummary] =
    useState<EncryptedShareLinksSummary | null>(null);
  const linksSummary: EncryptedShareLinksSummary | null = encrypted
    ? encryptedLinksSummary
    : hydrating
      ? null
      : { count: shareLinks.length, attention: false };
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
          // the Adds of accepted invitees) through MLS; share links in EncryptedShareLinks.
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
          const members = newMember
            ? await client.getProjectSharing(projectId)
            : nextSharing;
          if (newMember) setSharing(members);
          // Verified or Not verified, and keys changed, per member: shown
          // only, never a condition for sharing (trust on first use).
          if (encryptedClient.peopleTrust) {
            const trust = await encryptedClient
              .peopleTrust(
                members.members
                  .map((member) => member.userId)
                  .filter((userId) => userId !== currentUserId)
              )
              .catch(() => []);
            setMemberTrust(
              new Map(trust.map((entry) => [entry.userId, entry]))
            );
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
      encryptedClient,
      currentUserId
    ]
  );

  const copyShareLink = async (url: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      // Without clipboard access, copy from the URL field: it holds the
      // link as copied (with any configuration) for the moment it takes.
      const input = shareLinkUrlRef.current;
      if (!input) return false;
      const shown = input.value;
      input.value = url;
      input.focus();
      input.select();
      const copied = document.execCommand('copy');
      // Copied: the field shows the link as made again. Not copied: it keeps
      // this link, selected, for the owner to copy by hand.
      if (copied) input.value = shown;
      return copied;
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
      // Refused before anything is saved, frozen or sent.
      const output = sharingActionOutput(key);
      const refusal = output ? outputRefusal?.(output) : null;
      if (refusal) throw new Error(refusal);
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
            {error?.message ?? (busy ? 'Working…' : null)}
          </p>
          <FailureDetails detail={error?.detail} />
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
            <div
              className="sharing-tabs"
              role="tablist"
              aria-label="Share with"
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
                  return;
                event.preventDefault();
                const next = tab === 'people' ? 'links' : 'people';
                setTab(next);
                document.getElementById(`${tabsId}-${next}-tab`)?.focus();
              }}
            >
              <button
                id={`${tabsId}-people-tab`}
                type="button"
                role="tab"
                className="sharing-tab"
                aria-selected={tab === 'people'}
                aria-controls={`${tabsId}-people`}
                tabIndex={tab === 'people' ? 0 : -1}
                onClick={() => setTab('people')}
              >
                People
                <span className="sharing-tab-count">
                  {people.length + pendingCount}
                </span>
              </button>
              <button
                id={`${tabsId}-links-tab`}
                type="button"
                role="tab"
                className="sharing-tab"
                aria-selected={tab === 'links'}
                aria-controls={`${tabsId}-links`}
                tabIndex={tab === 'links' ? 0 : -1}
                onClick={() => setTab('links')}
              >
                Links
                {linksSummary ? (
                  <span className="sharing-tab-count">
                    {linksSummary.count}
                  </span>
                ) : null}
                {linksSummary?.attention ? (
                  <span
                    className="sharing-tab-attention"
                    title="A link needs your attention"
                  >
                    <span className="visually-hidden">, needs attention</span>
                  </span>
                ) : null}
              </button>
            </div>
          ) : null}
          <div
            id={`${tabsId}-people`}
            className="sharing-panel"
            {...(isOwner
              ? {
                  role: 'tabpanel',
                  'aria-labelledby': `${tabsId}-people-tab`
                }
              : {})}
            hidden={isOwner && tab !== 'people'}
          >
            {isOwner && linksSummary?.problem ? (
              // A link problem is read wherever the dialog opens: a revoked
              // link the server may still serve cannot wait for a tab.
              <div className="sharing-section">
                <div className="sharing-share-notice" role="alert">
                  <span className="sharing-tag">{linksSummary.problem}</span>
                  <button
                    type="button"
                    className="sharing-row-action"
                    onClick={() => setTab('links')}
                  >
                    Show links
                  </button>
                </div>
              </div>
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
                    const trust =
                      encrypted && member
                        ? memberTrust.get(member.userId)
                        : undefined;
                    if (member && manageable && trust?.keyChanged) {
                      return (
                        <li key={person.key} className="sharing-confirm-row">
                          <KeysChanged
                            name={name}
                            userId={member.userId}
                            busy={interactionBusy}
                            onReview={onVerifyContact}
                            onTrust={
                              encryptedClient.trustNewKeys
                                ? () =>
                                    void askSignature({
                                      title: `Trust ${name}'s new keys`,
                                      body: 'This signs that you trust their new keys, on every device of yours. It does not verify them: compare codes for that.',
                                      actionLabel: 'Trust new keys',
                                      work: async (authorization) => {
                                        await encryptedClient.trustNewKeys!(
                                          member.userId,
                                          trust.identityKeyHash,
                                          authorization
                                        );
                                        await refresh();
                                      }
                                    })
                                : undefined
                            }
                            onRemove={() => setConfirmingRemoval(member.userId)}
                          />
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
                          {personalInfoVisible ? (
                            person.initial
                          ) : (
                            <HiddenPerson />
                          )}
                        </span>
                        <span className="sharing-member-id">
                          {name}
                          {personalInfoVisible && person.you ? ' (you)' : ''}
                        </span>
                        {trust ? (
                          <TrustBadge
                            name={name}
                            userId={trust.userId}
                            verified={trust.verified}
                            busy={interactionBusy}
                            onVerify={onVerifyContact}
                          />
                        ) : null}
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
                                disabled={
                                  !encrypted && !editorInvitationsEnabled
                                }
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
                              onClick={() =>
                                setConfirmingRemoval(member.userId)
                              }
                            >
                              <X size={13} aria-hidden="true" />
                            </button>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                  {(sharing?.invitations ?? []).map((invitation, index) => (
                    <li
                      key={invitation.invitationId}
                      className="sharing-pending"
                    >
                      <span
                        className="sharing-avatar sharing-avatar-pending"
                        aria-hidden="true"
                      >
                        {personalInfoVisible ? (
                          initialOf(invitation.email)
                        ) : (
                          <HiddenPerson />
                        )}
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
                          const acceptor = invitation.acceptor;
                          const statement = invitation.statement;
                          if (invitation.state === 'keys-changed' && acceptor) {
                            const who =
                              personalInfoVisible && acceptor.email
                                ? acceptor.email
                                : label;
                            const id = invitation.record.invitationId;
                            return (
                              <li key={id} className="sharing-confirm-row">
                                <KeysChanged
                                  name={who}
                                  userId={acceptor.userId}
                                  busy={interactionBusy}
                                  onReview={onVerifyContact}
                                  onTrust={
                                    encryptedClient.trustNewKeys
                                      ? () =>
                                          void askSignature({
                                            title: `Trust ${who}'s new keys`,
                                            body: 'This signs that you trust their new keys, on every device of yours, and then adds them. It does not verify them: compare codes for that.',
                                            actionLabel: 'Trust new keys',
                                            work: async (authorization) => {
                                              await encryptedClient.trustNewKeys!(
                                                acceptor.userId,
                                                acceptor.identityKeyHash,
                                                authorization
                                              );
                                              await refresh();
                                            }
                                          })
                                      : undefined
                                  }
                                  onDecline={() =>
                                    void mutate(`decline:${id}`, async () => {
                                      await encryptedClient.revoke(
                                        projectId,
                                        id
                                      );
                                      await refresh();
                                    })
                                  }
                                />
                              </li>
                            );
                          }
                          if (
                            CONFIRMABLE_STATES.has(invitation.state) &&
                            acceptor &&
                            statement?.projectId === projectId &&
                            encryptedClient.confirmAdd
                          ) {
                            // Named from the signed acceptance and statement
                            // only: the contact code Contacts shows, the role
                            // this account signed.
                            const who =
                              personalInfoVisible && acceptor.email
                                ? acceptor.email
                                : 'The person who accepted';
                            const id = invitation.record.invitationId;
                            return (
                              <li key={id} className="sharing-confirm-row">
                                <div
                                  className="sharing-confirm"
                                  role="group"
                                  aria-label={`Confirm ${who}`}
                                >
                                  <p className="sharing-confirm-title">
                                    {who} accepted your invitation to{' '}
                                    {projectName ?? 'this project'} as{' '}
                                    {ROLE_ARTICLES[statement.role]}. Add them?
                                  </p>
                                  <p className="sharing-hint">
                                    {invitation.state === 'confirm-re-add'
                                      ? 'You removed them from this project before. '
                                      : invitation.state === 'confirm-new'
                                        ? 'They are new to you: confirming signs that you trust their keys, on every device of yours, then adds them. '
                                        : 'This browser has not seen every change to who is in this project. '}
                                    Add them only if this is the person you
                                    invited. Their contact code:
                                  </p>
                                  <code
                                    className="encryption-code"
                                    aria-label="Their contact code"
                                  >
                                    {acceptor.code}
                                  </code>
                                  <div className="sharing-confirm-actions">
                                    {onVerifyContact ? (
                                      <button
                                        type="button"
                                        className="secondary"
                                        disabled={interactionBusy}
                                        onClick={() =>
                                          onVerifyContact(acceptor.userId)
                                        }
                                      >
                                        Open contact
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      className="secondary"
                                      disabled={interactionBusy}
                                      onClick={() =>
                                        void mutate(
                                          `decline:${id}`,
                                          async () => {
                                            await encryptedClient.revoke(
                                              projectId,
                                              id
                                            );
                                            await refresh();
                                          }
                                        )
                                      }
                                    >
                                      Decline
                                    </button>
                                    <button
                                      type="button"
                                      className="primary"
                                      disabled={interactionBusy}
                                      onClick={() =>
                                        acceptor.pinned
                                          ? void mutate(
                                              `confirm-add:${id}`,
                                              async () => {
                                                await encryptedClient.confirmAdd!(
                                                  projectId,
                                                  id,
                                                  acceptor.identityKeyHash
                                                );
                                                await refresh();
                                              }
                                            )
                                          : // New to the account: one signed
                                            // confirmation, then the Add.
                                            void askSignature({
                                              title: `Confirm ${who}`,
                                              body: `${who} accepted your invitation. Confirming signs that you trust their keys, on every device of yours, then adds them. It does not verify them: compare codes for that.`,
                                              actionLabel: 'Confirm',
                                              work: async (authorization) => {
                                                await encryptedClient.confirmAdd!(
                                                  projectId,
                                                  id,
                                                  acceptor.identityKeyHash,
                                                  authorization
                                                );
                                                await refresh();
                                              }
                                            })
                                      }
                                    >
                                      {acceptor.pinned ? 'Add' : 'Confirm'}
                                    </button>
                                  </div>
                                </div>
                              </li>
                            );
                          }
                          return (
                            <li
                              key={invitation.record.invitationId}
                              className="sharing-pending"
                            >
                              <span
                                className="sharing-avatar sharing-avatar-pending"
                                aria-hidden="true"
                              >
                                {personalInfoVisible && invitation.email ? (
                                  initialOf(invitation.email)
                                ) : (
                                  <HiddenPerson />
                                )}
                              </span>
                              <span className="sharing-row-text">
                                <span className="sharing-member-id">
                                  {label}
                                </span>
                                <span
                                  className="sharing-row-detail"
                                  data-status={invitation.state}
                                >
                                  {ENCRYPTED_STATE_LABELS[invitation.state]} ·{' '}
                                  {ROLE_LABELS[invitation.record.role]} ·{' '}
                                  {expiryLabel(
                                    Math.floor(
                                      invitation.record.expiresAt / 1000
                                    )
                                  )}
                                </span>
                              </span>
                              {acceptor &&
                              sameAddress(acceptor.email, invitation.email) ? (
                                // The badge names the acceptor's keys: shown
                                // only beside the address they accepted as.
                                <TrustBadge
                                  name={label}
                                  userId={acceptor.userId}
                                  verified={acceptor.verified}
                                  busy={interactionBusy}
                                  onVerify={onVerifyContact}
                                />
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
          {isOwner ? (
            <div
              id={`${tabsId}-links`}
              className="sharing-panel"
              role="tabpanel"
              aria-labelledby={`${tabsId}-links-tab`}
              hidden={tab !== 'links'}
            >
              {isOwner && !encrypted ? (
                <PlaintextShareLinks
                  shareLinks={shareLinks}
                  created={createdShareLink}
                  disabled={interactionBusy}
                  localImportSourceNames={localImportSourceNames}
                  urlRef={shareLinkUrlRef}
                  configurations={configurations}
                  onCopy={copyShareLink}
                  {...(onFreezeModel ? { canExcludeHistory: true } : {})}
                  onUpdate={(shareLink) =>
                    void mutate(
                      `share-link:update:${shareLink.shareLinkId}`,
                      async () => {
                        if (!onFreezeModel) return;
                        await shareLinkClient.updateProjectShareLinkSnapshot(
                          projectId,
                          shareLink.shareLinkId,
                          await onFreezeModel({
                            parameters: shareLink.mode === 'tweak'
                          })
                        );
                        await refresh();
                      }
                    )
                  }
                  onCreate={(mode, comments, history, name) =>
                    void mutate('share-link:create', async () => {
                      // Refused before anything is frozen or saved.
                      const label = normalizeShareLinkLabel(name);
                      // L08: a link without history is the model frozen in this
                      // browser, so it waits on no save and needs no source file
                      // in the account.
                      const frozen =
                        !history && onFreezeModel
                          ? await onFreezeModel({
                              parameters: mode === 'tweak'
                            })
                          : undefined;
                      if (!frozen) await onBeforeCreateShareLink?.();
                      setCreatedShareLink(null);
                      // L08: only a commenter link names comments.
                      const created = frozen
                        ? await shareLinkClient.createProjectShareLink(
                            projectId,
                            mode,
                            label,
                            comments,
                            frozen
                          )
                        : comments
                          ? await shareLinkClient.createProjectShareLink(
                              projectId,
                              mode,
                              label,
                              true
                            )
                          : label
                            ? await shareLinkClient.createProjectShareLink(
                                projectId,
                                mode,
                                label
                              )
                            : await shareLinkClient.createProjectShareLink(
                                projectId,
                                mode
                              );
                      setCreatedShareLink({
                        url: buildShareLinkUrl(created.token),
                        shareLinkId: created.shareLink.shareLinkId,
                        mode: frozen ? 'view' : mode
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
                  {...(onFreezeModel
                    ? {
                        onFreezeModel: async (options) => {
                          const refusal = outputRefusal?.('share-frozen-model');
                          if (refusal) throw new Error(refusal);
                          return onFreezeModel(options);
                        }
                      }
                    : {})}
                  onSummary={setEncryptedLinksSummary}
                />
              ) : null}

              {isOwner && drawingSheets && drawingSheets.length > 0 ? (
                <ShareLinkDrawings
                  sheets={drawingSheets}
                  sharedSheetIds={sharedSheetIds ?? []}
                  {...(onSharedSheetsChange
                    ? { onChange: onSharedSheetsChange }
                    : {})}
                />
              ) : null}
            </div>
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
      {signature ? (
        <Suspense fallback={null}>
          <LazyAuthorizeDialog
            request={signature}
            busy={signing}
            run={runSignature}
            onClose={() => setSignature(null)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

interface PlaintextShareLinksProps {
  shareLinks: readonly ProjectShareLinkSummary[];
  created: {
    url: string;
    shareLinkId: string;
    mode: ProjectShareLinkMode;
  } | null;
  disabled: boolean;
  localImportSourceNames: readonly string[];
  urlRef: RefObject<HTMLInputElement | null>;
  configurations: readonly { id: string; name: string }[];
  /** Copies a link; false when neither the clipboard nor a fallback could. */
  onCopy(url: string): Promise<boolean>;
  /**
   * `mode`: what visitors may do (Tweak includes View). `comments`: L08
   * commenter link, whose visitors may comment. `name`: the owner's name
   * for it as typed; blank leaves it unnamed.
   */
  onCreate(
    mode: ProjectShareLinkMode,
    comments: boolean,
    /** L08: false shares the finished model without its history. */
    history: boolean,
    name: string
  ): void;
  /** L08: whether a link may leave the project's history out. */
  canExcludeHistory?: boolean;
  /** L08: freezes the current model into a link without history. */
  onUpdate(shareLink: ProjectShareLinkSummary): void;
  onRename(shareLink: ProjectShareLinkSummary, draft: string): Promise<void>;
  onRevoke(shareLink: ProjectShareLinkSummary): void;
}

/** A link's access, history, comments and expiry, for its card's summary. */
function shareLinkSummary(shareLink: ProjectShareLinkSummary): string {
  return [
    linkAccessLabel(shareLink),
    shareLink.comments ? 'Comments' : null,
    shareLinkExpiryLabel(shareLink.createdAt)
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The Links tab of an unencrypted project: the link just created (its URL
 * is shown once), the card that makes a new one, and a card per unrevoked
 * link with its owner-only name, settings, update and revoke.
 */
function PlaintextShareLinks({
  shareLinks,
  created,
  disabled,
  localImportSourceNames,
  urlRef,
  configurations,
  onCopy,
  onCreate,
  canExcludeHistory = false,
  onUpdate,
  onRename,
  onRevoke
}: PlaintextShareLinksProps) {
  const [composing, setComposing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The link whose Revoke is waiting for a yes (design review I2).
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // A new link closes the options that made it.
  const createdId = created?.shareLinkId ?? null;
  useEffect(() => {
    if (createdId) setComposing(false);
  }, [createdId]);
  const createdLink = created
    ? shareLinks.find((link) => link.shareLinkId === created.shareLinkId)
    : undefined;

  return (
    <section
      className="sharing-section share-links"
      aria-label="General access"
    >
      <p className="share-links-access">
        {shareLinks.length > 0
          ? `Anyone with a link · ${shareLinks.length} active`
          : 'Only invited people'}
      </p>
      <p className="sharing-hint">
        A link lets anyone who has it open this model without an account. Links
        expire after 30 days.
      </p>
      {created ? (
        <div className="sharing-share-output" role="status">
          <p className="share-link-created-title">
            {createdLink?.label ?? `${LINK_MODE_LABELS[created.mode]} link`} is
            ready
          </p>
          <input
            ref={urlRef}
            className="sharing-share-url"
            type="text"
            readOnly
            aria-label="Share link"
            value={created.url}
            onFocus={(event) => event.target.select()}
          />
          <ShareLinkCopyButton
            url={created.url}
            primary
            configurations={configurations}
            onCopy={(url, configurationId) =>
              onCopy(withShareConfiguration(url, configurationId))
            }
          />
          <p className="sharing-share-once">
            {LINK_MODE_LABELS[created.mode]} link · shown once — copy it now.
          </p>
        </div>
      ) : null}
      <ShareLinkComposer
        canExcludeHistory={canExcludeHistory}
        expanded={composing}
        onExpandedChange={setComposing}
        defaultMode="tweak"
        nameable
        nameMaxLength={PROJECT_SHARE_LINK_LABEL_MAX_LENGTH}
        disabled={disabled}
        commentsHint="Visitors see every comment and sign theirs with a name."
        footnote="You see the address once, when the link is made."
        {...(localImportSourceNames.length > 0
          ? {
              historyBlocker: (
                <p className="sharing-hint" role="alert">
                  Save the source files for {localImportSourceNames.join(', ')}{' '}
                  to your account with File → Save before creating a link.
                </p>
              )
            }
          : {})}
        onCreate={(draft) =>
          onCreate(draft.mode, draft.comments, draft.history, draft.name)
        }
      />
      {shareLinks.length > 0 ? (
        <ul className="share-link-cards" aria-label="Share links">
          {shareLinks.map((shareLink) => {
            const id = shareLink.shareLinkId;
            const name = shareLinkName(shareLink);
            if (revokingId === id) {
              return (
                <li key={id} className="sharing-confirm-row">
                  <ShareLinkRevokeConfirm
                    name={name}
                    disabled={disabled}
                    onCancel={() => {
                      setRevokingId(null);
                      // Its card stays open, so focus has its Revoke to go back to.
                      setExpandedId(id);
                      // Back to the card's Revoke, for the keyboard.
                      requestAnimationFrame(() =>
                        document
                          .querySelector<HTMLElement>(
                            `[data-share-link-revoke="${id}"]`
                          )
                          ?.focus()
                      );
                    }}
                    onRevoke={() => {
                      setRevokingId(null);
                      onRevoke(shareLink);
                    }}
                  />
                </li>
              );
            }
            const frozen = shareLink.history === false;
            return (
              <ShareLinkCard
                key={id}
                name={name}
                unnamed={shareLink.label === null}
                summary={shareLinkSummary(shareLink)}
                mode={frozen ? 'frozen' : shareLink.mode}
                expanded={expandedId === id}
                onToggle={() =>
                  setExpandedId((open) => (open === id ? null : id))
                }
              >
                <ShareLinkRename
                  shareLink={shareLink}
                  disabled={disabled}
                  onRename={onRename}
                />
                <ShareLinkFacts
                  facts={[
                    [
                      'Visitors can',
                      shareLink.mode === 'tweak'
                        ? 'View and change parameters'
                        : 'View, measure and export'
                    ],
                    [
                      'History',
                      frozen
                        ? `Not included · model as of ${createdLabel(shareLink.frozenAt ?? shareLink.createdAt)}`
                        : 'Included'
                    ],
                    ['Comments', shareLink.comments ? 'On' : 'Off'],
                    ['Created', createdLabel(shareLink.createdAt)],
                    ['Expires', shareLinkExpiryDetail(shareLink.createdAt)]
                  ]}
                />
                <p className="sharing-hint">
                  The address was shown once, when the link was made. If it is
                  lost, revoke this link and make a new one.
                </p>
                <div className="share-link-card-actions">
                  {frozen && canExcludeHistory ? (
                    <button
                      type="button"
                      className="secondary"
                      title="Share the model as it is now through this link"
                      aria-label={`Update ${name} to the current model`}
                      disabled={disabled}
                      onClick={() => onUpdate(shareLink)}
                    >
                      Update snapshot
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="secondary danger"
                    aria-label={
                      shareLink.label === null
                        ? `Revoke share link created ${createdLabel(shareLink.createdAt)}`
                        : `Revoke share link ${shareLink.label}`
                    }
                    data-share-link-revoke={id}
                    disabled={disabled}
                    onClick={() => setRevokingId(id)}
                  >
                    Revoke
                  </button>
                </div>
              </ShareLinkCard>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** The name field of an open link card: Save stores it, owner-only. */
function ShareLinkRename({
  shareLink,
  disabled,
  onRename
}: {
  shareLink: ProjectShareLinkSummary;
  disabled: boolean;
  onRename(shareLink: ProjectShareLinkSummary, draft: string): Promise<void>;
}) {
  return (
    <ShareLinkNameField
      saved={shareLink.label ?? ''}
      formLabel={`Rename ${shareLinkName(shareLink)}`}
      placeholder={`${LINK_MODE_LABELS[shareLink.mode]} link · ${createdLabel(shareLink.createdAt)}`}
      maxLength={PROJECT_SHARE_LINK_LABEL_MAX_LENGTH}
      disabled={disabled}
      onSave={(draft) => onRename(shareLink, draft)}
    />
  );
}
