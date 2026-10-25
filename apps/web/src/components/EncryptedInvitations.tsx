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
  ready: 'Preparing your keys for the project…',
  'no-device':
    'Open this invitation on a device that holds your encryption keys.'
};

const OUTGOING_HINTS: Partial<Record<OwnerInvitation['state'], string>> = {
  'waiting-for-keys': 'Accepted. Waiting for their keys.',
  'waiting-for-verification':
    'Waiting for you to verify them: compare codes, then they are added.',
  ready: 'Verified. Adding them…'
};

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
        return (
          <SettingRow
            key={invitation.record.invitationId}
            title={`${owner} invited you as ${ROLE[invitation.record.role]}`}
            hint={INCOMING_HINTS[invitation.state]}
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
          </SettingRow>
        );
      })}
      {waitingOutgoing.map((invitation) => {
        const name =
          invitation.email ?? invitation.record.acceptedByUserId ?? 'Invitee';
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
