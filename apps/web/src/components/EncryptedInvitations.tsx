import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { RefreshCcw, ShieldCheck } from 'lucide-react';
import type { E2eeInvitationRole } from '@openzcad/shared';
import {
  clearPendingEncryptedInvitation,
  pendingEncryptedInvitation,
  subscribePendingEncryptedInvitation
} from '../lib/e2ee/encryptedInvitationLink';
import {
  notifyContactsChanged,
  requestContactVerification,
  subscribeContactsChanged
} from '../lib/e2ee/contactFocus';
import type {
  InvitationContext,
  InviteeInvitation,
  OwnerInvitation
} from '../lib/e2ee/invitations';
import { desktopFetch } from '../lib/desktopBridge';
import { Group, Notice, SettingRow } from './settingsControls';

const ROLE: Record<E2eeInvitationRole, string> = {
  editor: 'an editor',
  viewer: 'a viewer'
};

const INCOMING_HINTS: Record<InviteeInvitation['state'], string> = {
  'verify-owner':
    'Compare codes with them to continue: they add you once you have verified each other.',
  invalid:
    'This invitation does not verify against the owner’s keys. Ask them to invite you again.',
  'waiting-for-owner':
    'Your keys are ready. Waiting for them to verify you and add you.',
  confirm:
    'Join only if you expected this invitation and the code is the one Contacts shows for them. Joining tells them this account accepted it.',
  ready: 'Preparing your keys for the project…',
  'no-device':
    'Open this invitation on a device that holds your encryption keys.'
};

const OUTGOING_HINTS: Partial<Record<OwnerInvitation['state'], string>> = {
  'waiting-for-keys': 'Accepted. Waiting for their keys.',
  'waiting-for-verification':
    'Waiting for you to verify them: compare codes, then they are added.',
  'needs-acceptance':
    'Waiting for them to open OpenZCAD again and confirm the invitation.',
  'confirm-re-add':
    'You removed them from this project before. Add them only if this is the contact code Contacts shows for them.',
  'confirm-add':
    'Add them only if this is the contact code Contacts shows for the person you invited.',
  'accepted-by-other':
    'Someone other than the contact you invited accepted. They will not be added: revoke it and invite again.',
  ready: 'Verified. Adding them…'
};

/** Accepted invitations the owner confirms or declines. */
const CONFIRMABLE = new Set<OwnerInvitation['state']>([
  'confirm-add',
  'confirm-re-add'
]);

/** The page's invitation context, loaded with the encrypted-project store. */
async function pageInvitations(): Promise<InvitationContext> {
  const { encryptedInvitations } =
    await import('../lib/e2ee/encryptedProjects');
  return encryptedInvitations();
}

/**
 * Whether invitations to encrypted projects are open to this account:
 * encrypted projects are (`/api/e2ee/config`). Anything else, an older
 * Worker or a static host included, reads as no, and the group stays
 * away: plaintext accounts see nothing new.
 */
async function invitationsAvailable(): Promise<boolean> {
  try {
    const response = await desktopFetch('/api/e2ee/config', {
      credentials: 'same-origin'
    });
    if (!response.ok) return false;
    const config = (await response.json()) as {
      enabled?: unknown;
      projectsEnabled?: unknown;
    };
    return config.enabled === true && config.projectsEnabled === true;
  } catch {
    return false;
  }
}

/** A route refusal that only says the feature is closed here. */
const unavailable = (error: unknown) =>
  typeof (error as { status?: unknown })?.status === 'number' &&
  [501, 503].includes((error as { status: number }).status);

function messageFor(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Invitations are unavailable right now. Try again.';
}

/**
 * Settings › Encryption › Invitations (ADR-024 Phase 5, slice 5-3b): the
 * invitation link this tab captured (accepted here), the encrypted
 * projects this account was invited to (verify the owner, then this device
 * publishes its keys and joins once added), and the people this account
 * invited who are waiting for keys or for it to verify them. Each pass
 * publishes this device's KeyPackages, joins welcomed projects and adds
 * verified invitees (`syncInvitations`).
 */
export function EncryptedInvitations({ ready }: { ready: boolean }) {
  const token = useSyncExternalStore(
    subscribePendingEncryptedInvitation,
    () => pendingEncryptedInvitation(),
    () => null
  );
  const [incoming, setIncoming] = useState<InviteeInvitation[]>([]);
  const [outgoing, setOutgoing] = useState<OwnerInvitation[]>([]);
  const [joined, setJoined] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);

  const sync = useCallback(async () => {
    setError(null);
    const open = await invitationsAvailable();
    setAvailable(open);
    if (!ready || !open) return;
    setBusy(true);
    try {
      const { syncInvitations } = await import('../lib/e2ee/invitations');
      const result = await syncInvitations(await pageInvitations());
      setIncoming(result.incoming);
      setOutgoing(result.outgoing);
      setJoined((count) => count + result.joined.length);
      const shown = result.errors.find((caught) => !unavailable(caught));
      if (shown) setError(messageFor(shown));
    } catch (caught) {
      if (!unavailable(caught)) setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }, [ready]);

  useEffect(() => {
    void sync();
    return subscribeContactsChanged(() => void sync());
  }, [sync]);

  const accept = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { acceptEncryptedInvitation } =
        await import('../lib/e2ee/invitations');
      // An invitation whose statement names no link (an older app's) is
      // listed below for an explicit Join.
      await acceptEncryptedInvitation(await pageInvitations(), token);
      clearPendingEncryptedInvitation();
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
      return;
    }
    setBusy(false);
    // The owner is a contact now (M2): the contacts list and this one read
    // again.
    notifyContactsChanged();
  };

  // The person's own confirmation of an invitation this device did not
  // open by link: only then does it sign the acceptance.
  const confirm = async (invitation: InviteeInvitation) => {
    setBusy(true);
    setError(null);
    try {
      const { confirmEncryptedInvitation } =
        await import('../lib/e2ee/invitations');
      // Exactly the verified statement this row shows.
      await confirmEncryptedInvitation(await pageInvitations(), invitation);
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
      return;
    }
    setBusy(false);
    await sync();
  };

  // The owner's confirmation of the contact who accepted, by the identity
  // shown, or the decline that closes the invitation.
  const decide = async (invitation: OwnerInvitation, add: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const invitations = await import('../lib/e2ee/invitations');
      const ctx = await pageInvitations();
      const { projectId, invitationId } = invitation.record;
      if (add && invitation.acceptor) {
        await invitations.addInvitedMember(ctx, invitation.record, {
          confirmedIdentity: invitation.acceptor.identityKeyHash
        });
      } else {
        await invitations.declineInvitation(ctx, projectId, invitationId);
      }
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
      return;
    }
    setBusy(false);
    await sync();
  };

  const waitingOutgoing = outgoing.filter(
    (invitation) => OUTGOING_HINTS[invitation.state] !== undefined
  );
  if (!available) return null;
  if (!token && !incoming.length && !waitingOutgoing.length && !error) {
    return joined ? (
      <Group title="Invitations">
        <SettingRow
          title="Joined"
          hint="You joined an encrypted project. It is on your shelf."
        />
      </Group>
    ) : null;
  }
  return (
    <Group title="Invitations">
      {error ? (
        <Notice
          tone="warning"
          role="alert"
          action={
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void sync()}
            >
              <RefreshCcw size={13} aria-hidden="true" />
              Retry
            </button>
          }
        >
          {error}
        </Notice>
      ) : null}
      {token ? (
        ready ? (
          <SettingRow
            title="Invitation to an encrypted project"
            hint="Accepting tells the owner which account is yours. You are added after you both compare codes."
          >
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => void accept()}
            >
              Accept invitation
            </button>
          </SettingRow>
        ) : (
          <Notice tone="warning" role="status">
            You were invited to an end-to-end encrypted project. Set up
            encryption on this device first, then accept the invitation here.
          </Notice>
        )
      ) : null}
      {incoming.map((invitation) => {
        const owner = invitation.ownerEmail ?? 'The owner';
        // Role and project from the verified statement, never the server's
        // listing; the inviter by the contact code Contacts shows for them.
        const statement = invitation.statement;
        const code = invitation.ownerCode;
        const joinable =
          invitation.state === 'confirm' && statement !== null && code !== null;
        const title = !statement
          ? `An invitation from ${owner} that does not verify`
          : joinable
            ? `Your verified contact invited you to project ${statement.projectId} as ${ROLE[statement.role]}`
            : `${owner} invited you as ${ROLE[statement.role]}`;
        return (
          <SettingRow
            key={invitation.record.invitationId}
            title={title}
            hint={
              joinable ? (
                <>
                  {INCOMING_HINTS.confirm} Their contact code:{' '}
                  <code
                    className="encryption-code"
                    aria-label="Their contact code"
                  >
                    {code}
                  </code>
                </>
              ) : (
                INCOMING_HINTS[invitation.state]
              )
            }
          >
            {invitation.state === 'verify-owner' ? (
              <button
                className="secondary"
                type="button"
                disabled={busy}
                aria-label={`Verify ${owner}`}
                onClick={() =>
                  requestContactVerification(invitation.record.inviterUserId)
                }
              >
                <ShieldCheck size={14} aria-hidden="true" />
                Verify
              </button>
            ) : null}
            {joinable && statement ? (
              <>
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    requestContactVerification(invitation.record.inviterUserId)
                  }
                >
                  Open contact
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={busy}
                  aria-label={`Join project ${statement.projectId} as ${ROLE[statement.role]}`}
                  onClick={() => void confirm(invitation)}
                >
                  Join
                </button>
              </>
            ) : null}
          </SettingRow>
        );
      })}
      {waitingOutgoing.map((invitation) => {
        const name =
          invitation.email ?? invitation.record.acceptedByUserId ?? 'Invitee';
        const acceptor = invitation.acceptor;
        const statement = invitation.statement;
        if (CONFIRMABLE.has(invitation.state) && acceptor && statement) {
          // Named from the verified acceptance and this account's own
          // statement: the contact code Contacts shows, the role signed.
          const who = acceptor.email ?? 'Your verified contact';
          return (
            <SettingRow
              key={invitation.record.invitationId}
              title={`${who} accepted your invitation to project ${statement.projectId} as ${ROLE[statement.role]}. Add them?`}
              hint={
                <>
                  {OUTGOING_HINTS[invitation.state]} Their contact code:{' '}
                  <code
                    className="encryption-code"
                    aria-label="Their contact code"
                  >
                    {acceptor.code}
                  </code>
                </>
              }
            >
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => requestContactVerification(acceptor.userId)}
              >
                Open contact
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                aria-label={`Decline ${who}`}
                onClick={() => void decide(invitation, false)}
              >
                Decline
              </button>
              <button
                className="primary"
                type="button"
                disabled={busy}
                aria-label={`Add ${who}`}
                onClick={() => void decide(invitation, true)}
              >
                Add
              </button>
            </SettingRow>
          );
        }
        return (
          <SettingRow
            key={invitation.record.invitationId}
            title={name}
            hint={OUTGOING_HINTS[invitation.state]}
          >
            {invitation.state === 'waiting-for-verification' &&
            invitation.record.acceptedByUserId ? (
              <button
                className="secondary"
                type="button"
                disabled={busy}
                aria-label={`Verify ${name}`}
                onClick={() =>
                  requestContactVerification(
                    invitation.record.acceptedByUserId!
                  )
                }
              >
                <ShieldCheck size={14} aria-hidden="true" />
                Verify
              </button>
            ) : null}
          </SettingRow>
        );
      })}
    </Group>
  );
}
