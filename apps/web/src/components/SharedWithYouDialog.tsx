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
  type InviteeInvitationState
} from '../lib/e2ee/invitations';
import { clearPendingEncryptedInvitation } from '../lib/e2ee/encryptedInvitationLink';
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
      /** Where the runner's newest pass says the invitation stands. */
      state: InviteeInvitationState | null;
    }
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
      if (opened.current) return;
      opened.current = true;
      onOpenProject(projectId);
    },
    [onOpenProject]
  );

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
      if (listed && listed.state !== current.state) {
        const next = { ...current, state: listed.state };
        phaseRef.current = next;
        setPhase(next);
      }
    },
    [open]
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
      clearPendingEncryptedInvitation();
      if (invitation.completedAt) {
        // Added before: this device joins it as the project opens.
        open(invitation.projectId);
        return;
      }
      const owner = await invitations.people
        .inspect(invitation.inviterUserId)
        .then((person) => person?.email ?? null)
        .catch(() => null);
      const next: Phase = {
        kind: 'waiting',
        projectId: invitation.projectId,
        invitationId: invitation.invitationId,
        inviterUserId: invitation.inviterUserId,
        owner,
        state: null
      };
      phaseRef.current = next;
      setPhase(next);
      follow(await syncInvitationsNow());
    } catch (error) {
      accepting.current = false;
      setPhase({
        kind: 'failed',
        message: notFound(error)
          ? 'This invitation is no longer valid: it was cancelled, it expired or someone else accepted it. Ask the owner to invite you again.'
          : messageFor(error)
      });
    }
  }, [follow, open, token]);

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
    const timer = setInterval(() => {
      if (shown && document.visibilityState === 'visible')
        void syncInvitationsNow().then(follow);
    }, SHARED_WITH_YOU_POLL_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [follow, shown, waitingFor]);

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
      const verify = phase.state === 'verify-owner';
      body = (
        <>
          <p>
            {owner ?? 'Someone'} shared an end-to-end encrypted project with
            you.
          </p>
          {verify ? (
            <p role="status">
              Compare codes with {who} first: their device adds you once you
              have verified each other.
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
      if (verify || phase.state === 'confirm') {
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
