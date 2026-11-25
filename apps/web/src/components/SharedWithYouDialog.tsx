import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  deviceKeyFactory,
  deviceKeyStore
} from '../lib/e2ee/keychainDeviceKeys';
import {
  loadEncryption,
  type E2eeContext,
  type EncryptionState
} from '../lib/e2ee/accountKeys';
import { createE2eeApi } from '../lib/e2ee/e2eeApi';
import { encryptedInvitations } from '../lib/e2ee/encryptedProjects';
import {
  acceptEncryptedInvitation,
  trustInvitationOwner,
  type InviteeInvitation,
  type InviteeInvitationState
} from '../lib/e2ee/invitations';
import { passkeysAvailable } from '../lib/e2ee/passkeys';
import type { E2eeInvitationRecord } from '@openzcad/shared';
import {
  clearPendingEncryptedInvitation,
  pendingEncryptedInvitation
} from '../lib/e2ee/encryptedInvitationLink';
import {
  encryptionStateChanged,
  observeEncryptionState,
  subscribeEncryptionState
} from '../lib/e2ee/encryptionStateEvents';
import {
  getKeySessionRevision,
  isCurrentKeySession
} from '../lib/e2ee/keySession';
import { invalidateAccountKeyReads } from '../lib/e2ee/unlockedKeys';
import {
  subscribeInvitationPasses,
  syncInvitationsNow,
  type InvitationPassResult
} from '../lib/e2ee/invitationRunner';
import { requestContactVerification } from '../lib/e2ee/contactFocus';
import { AuthorizeDialog } from './encryption/AuthorizeDialog';
import { EncryptionDialog } from './encryption/EncryptionDialog';
import { SetupDialog } from './encryption/SetupDialog';
import { messageFor, type RunOptions } from './encryption/flow';
import {
  PrivateText,
  setPersonalInfoVisible,
  usePersonalInfoVisible
} from './PersonalInfo';
import '../styles/components/encryption.css';

/**
 * How often the landing asks for its Welcome while someone waits on it
 * (judgment): the app's runner asks every minute; a person looking at
 * "Waiting for …" should not wait that long once the owner's device added
 * them.
 */
export const SHARED_WITH_YOU_POLL_MS = 10_000;

type Phase =
  | { kind: 'checking' }
  | { kind: 'signed-out' }
  | { kind: 'no-keys' }
  | { kind: 'locked' }
  | { kind: 'accepting' }
  | {
      kind: 'waiting';
      projectId: string;
      invitationId: string;
      inviterUserId: string;
      owner: string | null;
      /** When the accepted invitation lapses (Unix ms), if nobody adds. */
      expiresAt: number;
      /** Where the runner's newest pass says the invitation stands. */
      state: InviteeInvitationState | null;
      /** That pass's listing, for the owner's signed confirmation. */
      listing?: InviteeInvitation;
    }
  | { kind: 'expired'; owner: string | null }
  | { kind: 'failed'; message: string };

export interface SharedWithYouDialogProps {
  /** The emailed link's token this tab captured. */
  token: string;
  /** The signed-in account; null while signed out. */
  userId: string | null;
  /** Settings does not cover it: false hides it, keeping where it was. */
  shown: boolean;
  onSignIn(): void;
  /** Settings › Encryption, to unlock this device or compare codes. */
  onOpenEncryptionSettings(): void;
  /** The project joined: the app opens it. */
  onOpenProject(projectId: string): void;
  onClose(): void;
}

const notFound = (error: unknown) =>
  (error as { status?: unknown })?.status === 404;

const NO_LONGER_VALID =
  'This invitation is no longer valid: it was cancelled, it expired or someone else accepted it. Ask the owner to invite you again.';

/**
 * "Shared with you" (L11 plan of 2026-11-25, §3.2): what an
 * `#encrypted-invite=` link opens instead of Settings › Encryption. It
 * turns encryption on inline when the account has none (the setup dialog,
 * then back here), accepts the link once this device is unlocked (the
 * opened link is the intent; `acceptEncryptedInvitation`), says it waits
 * for the owner's device, and opens the project once the app's invitation
 * runner joined it by its Welcome. The project's name is not readable
 * before then: only its members hold its keys.
 */
export function SharedWithYouDialog({
  token,
  userId,
  shown,
  onSignIn,
  onOpenEncryptionSettings,
  onOpenProject,
  onClose
}: SharedWithYouDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const personalInfoVisible = usePersonalInfoVisible();
  const lifetime = useMemo(() => ({ active: true, generation: 0 }), []);
  const opened = useRef(false);
  /** Set once the accept starts: the account is not looked at again. */
  const accepting = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const ctx = useMemo<E2eeContext | null>(() => {
    if (!userId) return null;
    const revision = getKeySessionRevision();
    return {
      userId,
      readScope: lifetime,
      api: createE2eeApi(),
      store: deviceKeyStore(),
      createDeviceKeys: deviceKeyFactory(),
      isCurrent: () => lifetime.active && isCurrentKeySession(revision)
    };
  }, [userId, lifetime]);

  const open = useCallback(
    (projectId: string) => {
      // A landing replaced by another link's opens nothing of its own.
      if (opened.current || !lifetime.active) return;
      opened.current = true;
      onOpenProject(projectId);
    },
    [lifetime, onOpenProject]
  );

  const show = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  /**
   * What the invitation's own record says, once the account accepted it:
   * completed (this account was added, whichever of its devices or tabs
   * joined) opens the project; revoked or expired ends the wait. False
   * while it still waits for the owner's device.
   */
  const settle = useCallback(
    (invitation: E2eeInvitationRecord, owner: string | null): boolean => {
      if (invitation.completedAt) {
        open(invitation.projectId);
        return true;
      }
      if (invitation.revokedAt) {
        show({ kind: 'failed', message: NO_LONGER_VALID });
        return true;
      }
      if (invitation.expiresAt <= Date.now()) {
        show({ kind: 'expired', owner });
        return true;
      }
      return false;
    },
    [open, show]
  );

  /**
   * Asks the server about this invitation again (accepting a link twice is
   * answered as the first time): for when the runner no longer lists it,
   * since another tab may have joined it, or it lapsed.
   */
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    const current = phaseRef.current;
    if (current.kind !== 'waiting' || refreshing.current) return;
    refreshing.current = true;
    try {
      const { api } = await encryptedInvitations();
      const { invitation } = await api.accept({ token });
      if (
        phaseRef.current === current &&
        invitation.invitationId === current.invitationId
      ) {
        settle(invitation, current.owner);
      }
    } catch (error) {
      if (phaseRef.current === current && notFound(error)) {
        show({ kind: 'failed', message: NO_LONGER_VALID });
      }
      // Anything else: the next poll asks again.
    } finally {
      refreshing.current = false;
    }
  }, [settle, show, token]);

  /** Where a pass leaves this invitation: joined opens the project. */
  const follow = useCallback(
    (result: InvitationPassResult | null) => {
      const current = phaseRef.current;
      if (!result || current.kind !== 'waiting') return;
      if (result.joined.includes(current.projectId)) {
        open(current.projectId);
        return;
      }
      const listed = result.incoming.find(
        (entry) => entry.record.invitationId === current.invitationId
      );
      if (!listed) {
        // No longer an open invitation of this account: completed (joined
        // elsewhere), revoked or expired. Its record says which.
        void refresh();
        return;
      }
      if (listed.state !== current.state) {
        show({ ...current, state: listed.state, listing: listed });
      }
    },
    [open, refresh, show]
  );

  const accept = useCallback(async () => {
    if (accepting.current) return;
    accepting.current = true;
    setPhase({ kind: 'accepting' });
    try {
      const invitations = await encryptedInvitations();
      const { invitation } = await acceptEncryptedInvitation(
        invitations,
        token
      );
      // Only this link's: another opened since in this tab keeps its own.
      if (pendingEncryptedInvitation() === token) {
        clearPendingEncryptedInvitation();
      }
      const owner = invitation.completedAt
        ? null
        : await invitations.people
            .inspect(invitation.inviterUserId)
            .then((person) => person?.email ?? null)
            .catch(() => null);
      // Added before (this device joins it as the project opens), or over.
      if (settle(invitation, owner)) return;
      const next: Phase = {
        kind: 'waiting',
        projectId: invitation.projectId,
        invitationId: invitation.invitationId,
        inviterUserId: invitation.inviterUserId,
        owner,
        expiresAt: invitation.expiresAt,
        state: null
      };
      show(next);
      follow(await syncInvitationsNow());
    } catch (error) {
      accepting.current = false;
      show({
        kind: 'failed',
        message: notFound(error) ? NO_LONGER_VALID : messageFor(error)
      });
    }
  }, [follow, settle, show, token]);

  const check = useCallback(async () => {
    if (accepting.current) return;
    if (!ctx) {
      setPhase({ kind: 'signed-out' });
      return;
    }
    const generation = ++lifetime.generation;
    let state: EncryptionState;
    try {
      state = await loadEncryption(ctx);
    } catch (error) {
      if (generation === lifetime.generation)
        setPhase({ kind: 'failed', message: messageFor(error) });
      return;
    }
    if (
      generation !== lifetime.generation ||
      !lifetime.active ||
      accepting.current
    )
      return;
    if (state.kind === 'not-set-up') setPhase({ kind: 'no-keys' });
    else if (state.kind === 'ready' && state.account.unlocked) void accept();
    else setPhase({ kind: 'locked' });
  }, [accept, ctx, lifetime]);

  // Until it is accepted, every change of the account (setup, an unlock in
  // Settings, a sign-in) is looked at again.
  useEffect(() => {
    lifetime.active = true;
    void check();
    if (!userId) return;
    return subscribeEncryptionState(userId, () => void check());
  }, [check, lifetime, userId]);

  // Back from Settings (an unlock there may have raised no event here).
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown && !wasShown.current) void check();
    wasShown.current = shown;
  }, [check, shown]);

  useEffect(
    () => () => {
      lifetime.active = false;
      lifetime.generation++;
      if (userId) invalidateAccountKeyReads(userId, lifetime);
    },
    [lifetime, userId]
  );

  // Waiting: every pass the runner makes, and one every
  // SHARED_WITH_YOU_POLL_MS while this is on screen.
  const waitingFor = phase.kind === 'waiting' ? phase.projectId : null;
  useEffect(() => {
    if (!waitingFor) return;
    const stop = subscribeInvitationPasses(follow);
    // A change of the account (another tab joined, keys changed) asks too.
    const stopState = userId
      ? subscribeEncryptionState(userId, () => void refresh())
      : () => undefined;
    const timer = setInterval(() => {
      // The expiry it knows of ends the wait even with no pass at all.
      const current = phaseRef.current;
      if (current.kind === 'waiting' && Date.now() >= current.expiresAt) {
        show({ kind: 'expired', owner: current.owner });
        return;
      }
      if (shown && document.visibilityState === 'visible')
        void syncInvitationsNow().then(follow);
    }, SHARED_WITH_YOU_POLL_MS);
    return () => {
      stop();
      stopState();
      clearInterval(timer);
    };
  }, [follow, refresh, show, shown, userId, waitingFor]);

  // Whether the owner's confirmation is open, and with a passkey offered.
  // The exact listing the person confirms (its statement and the owner
  // identity it was shown with), captured at the click: a later pass that
  // lists another statement under the same id never gets signed for.
  const [confirmingOwner, setConfirmingOwner] = useState<{
    passkey: boolean;
    listing: InviteeInvitation;
  } | null>(null);
  const askOwnerConfirmation = async () => {
    const current = phaseRef.current;
    const listing = current.kind === 'waiting' ? current.listing : undefined;
    if (!listing) return;
    let passkey: boolean;
    try {
      const state = ctx ? await loadEncryption(ctx) : null;
      passkey =
        passkeysAvailable() &&
        state?.kind === 'ready' &&
        state.account.list.unlockTargets.some(
          (target) => target.kind === 'passkey'
        );
    } catch {
      passkey = false;
    }
    setConfirmingOwner({ passkey, listing });
  };

  const run = useCallback(
    async (
      work: () => Promise<EncryptionState | void>,
      options: RunOptions = {}
    ) => {
      if (!userId) return false;
      setBusy(true);
      setSetupError(null);
      try {
        const next = await work();
        if (next) {
          const changed = observeEncryptionState(userId, next);
          if (!options.readOnly || changed) encryptionStateChanged(userId);
        }
        return true;
      } catch (caught) {
        const message = messageFor(caught);
        if (options.onError) options.onError(message);
        else setSetupError(message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [userId]
  );

  if (!shown) return null;
  // An owner new to this account: one signature (a passkey touch, or the
  // recovery key) trusts them, then this device joins. Never automatic.
  if (confirmingOwner !== null) {
    const { listing } = confirmingOwner;
    return (
      <AuthorizeDialog
        request={{
          title: 'Confirm the project owner',
          body: 'This signs that you trust their keys, on every device of yours, so you can join. It does not verify them: compare codes for that.',
          actionLabel: 'Confirm',
          passkey: confirmingOwner.passkey,
          work: async (authorization) => {
            await trustInvitationOwner(
              await encryptedInvitations(),
              listing,
              authorization
            );
            void syncInvitationsNow().then(follow);
          }
        }}
        busy={busy}
        run={run}
        onClose={() => setConfirmingOwner(null)}
      />
    );
  }
  if (setup && ctx && userId) {
    return (
      <SetupDialog
        ctx={ctx}
        busy={busy}
        run={run}
        userId={userId}
        onClose={() => {
          setSetup(false);
          void check();
        }}
        onEncryptExisting={() => {
          setSetup(false);
          void check();
        }}
      />
    );
  }

  const owner =
    phase.kind === 'waiting' && phase.owner ? (
      <PrivateText
        value={phase.owner}
        visible={personalInfoVisible}
        onChange={setPersonalInfoVisible}
      />
    ) : null;
  let body: ReactNode;
  let footer: ReactNode = (
    <button className="secondary" type="button" onClick={onClose}>
      Not now
    </button>
  );
  switch (phase.kind) {
    case 'checking':
    case 'accepting':
      body = <p role="status">Opening the invitation…</p>;
      break;
    case 'signed-out':
      body = (
        <p>
          Someone shared an end-to-end encrypted project with you. Sign in with
          the email address the invitation went to, to open it.
        </p>
      );
      footer = (
        <>
          {footer}
          <button className="primary" type="button" onClick={onSignIn}>
            Sign in
          </button>
        </>
      );
      break;
    case 'no-keys':
      body = (
        <>
          <p>
            Someone shared an end-to-end encrypted project with you. Turn on
            encryption to open it.
          </p>
          {setupError ? <p role="alert">{setupError}</p> : null}
        </>
      );
      footer = (
        <>
          {footer}
          <button
            className="primary"
            type="button"
            onClick={() => setSetup(true)}
          >
            Turn on encryption to open it
          </button>
        </>
      );
      break;
    case 'locked':
      body = (
        <p>
          Someone shared an end-to-end encrypted project with you. Unlock
          encryption on this device to open it.
        </p>
      );
      footer = (
        <>
          {footer}
          <button
            className="primary"
            type="button"
            onClick={onOpenEncryptionSettings}
          >
            Unlock encryption
          </button>
        </>
      );
      break;
    case 'waiting': {
      const who = owner ?? 'the owner';
      const verify = phase.state === 'owner-keys-changed';
      const newOwner = phase.state === 'confirm-owner' && !!phase.listing;
      body = (
        <>
          <p>
            {owner ?? 'Someone'} shared an end-to-end encrypted project with
            you.
          </p>
          {verify ? (
            <p role="status">
              {who}’s encryption keys changed. Compare codes with them before
              joining.
            </p>
          ) : newOwner ? (
            <p role="status">
              {who} is new to you. Confirm it is them to join: your passkey or
              recovery key signs that you trust their keys.
            </p>
          ) : phase.state === 'invalid' ? (
            <p role="alert">
              This invitation does not verify against the owner’s keys. Ask them
              to invite you again.
            </p>
          ) : phase.state === 'confirm' ? (
            <p role="status">Join it in Settings › Encryption › Invitations.</p>
          ) : (
            <p role="status">Waiting for {who}’s device to add you…</p>
          )}
        </>
      );
      if (newOwner) {
        footer = (
          <>
            {footer}
            <button
              className="primary"
              type="button"
              onClick={() => void askOwnerConfirmation()}
            >
              Confirm
            </button>
          </>
        );
      } else if (verify || phase.state === 'confirm') {
        const inviter = phase.inviterUserId;
        footer = (
          <>
            {footer}
            <button
              className="primary"
              type="button"
              onClick={() => {
                if (verify) requestContactVerification(inviter);
                onOpenEncryptionSettings();
              }}
            >
              {verify ? 'Compare codes' : 'Open invitations'}
            </button>
          </>
        );
      }
      break;
    }
    case 'expired':
      body = (
        <p role="alert">
          This invitation expired. Ask{' '}
          {phase.owner ? (
            <PrivateText
              value={phase.owner}
              visible={personalInfoVisible}
              onChange={setPersonalInfoVisible}
            />
          ) : (
            'the owner'
          )}{' '}
          to invite you again.
        </p>
      );
      break;
    case 'failed':
      body = <p role="alert">{phase.message}</p>;
      footer = (
        <>
          {footer}
          <button
            className="primary"
            type="button"
            onClick={() => void check()}
          >
            Try again
          </button>
        </>
      );
      break;
  }
  return (
    <EncryptionDialog title="Shared with you" onClose={onClose} footer={footer}>
      {body}
    </EncryptionDialog>
  );
}
