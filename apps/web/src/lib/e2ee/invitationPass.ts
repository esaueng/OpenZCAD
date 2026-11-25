/**
 * One pass of the app-level invitation runner (`invitationRunner.ts`),
 * loaded with the encryption chunks only once the rollout gates are open:
 * `syncInvitations` (the invitee's KeyPackages and Welcome joins, the
 * owner's ready Adds) and, when asked, the renewal of pending statements
 * (`invitationRenewal.ts`), over the page's invitation context.
 */
import { loadEncryption } from './accountKeys';
import { createE2eeApi } from './e2eeApi';
import { encryptedInvitations } from './encryptedProjects';
import { isKeysLockedError } from './encryptionStatus';
import { syncInvitations, type InvitationContext } from './invitations';
import { renewPendingInvitations } from './invitationRenewal';
import { deviceKeyStore } from './keychainDeviceKeys';
import { getKeySessionRevision, isCurrentKeySession } from './keySession';
import type { InvitationPassOutcome } from './invitationRunner';

/** This module's reads of the account, apart from Settings' and others'. */
const scope = {};

/** A route refusal that only says the feature is closed here. */
const closed = (error: unknown) =>
  typeof (error as { status?: unknown })?.status === 'number' &&
  [501, 503].includes((error as { status: number }).status);

/**
 * Whether the account has keys and this device holds them unlocked: read
 * quietly, as automatic migration does, so an account without keys or a
 * locked device shows nothing anywhere.
 */
export async function eligible(userId: string): Promise<boolean> {
  const revision = getKeySessionRevision();
  const state = await loadEncryption({
    userId,
    readScope: scope,
    api: createE2eeApi(),
    store: deviceKeyStore(),
    isCurrent: () => isCurrentKeySession(revision)
  });
  return state.kind === 'ready' && state.account.unlocked;
}

export async function runInvitationPass(
  userId: string,
  options: { readonly renew: boolean }
): Promise<InvitationPassOutcome> {
  let ctx: InvitationContext;
  try {
    ctx = await encryptedInvitations();
  } catch (error) {
    if (isKeysLockedError(error)) return { kind: 'ineligible' };
    throw error;
  }
  // Another account signed in meanwhile: its own runner takes over.
  if (ctx.groups.account.userId !== userId) return { kind: 'ineligible' };
  const synced = await syncInvitations(ctx);
  if (synced.errors.some(isKeysLockedError)) return { kind: 'ineligible' };
  if (synced.errors.length && synced.errors.every(closed)) {
    return { kind: 'closed' };
  }
  const errors = [...synced.errors];
  let renewed: string[] = [];
  if (options.renew) {
    try {
      const renewals = await renewPendingInvitations(ctx);
      renewed = renewals.renewed;
      errors.push(...renewals.failed.map((failure) => failure.error));
    } catch (error) {
      errors.push(error);
    }
  }
  // HOOK POINT, share-link upkeep (L11 plan §4, "Upkeep runs in the
  // background, through the same worker as invitations"): the app-level
  // link upkeep (`maintainEncryptedShareLinks`, PR #2055) is called here
  // once it is on main, so it shares this pass's rollout gates, unlocked-
  // keys check, single flight and backoff; push its failures to `errors`.
  //
  // A database without renewals yet (503) closes only renewing.
  return {
    kind: 'ran',
    incoming: synced.incoming,
    outgoing: synced.outgoing,
    joined: synced.joined,
    completed: synced.completed,
    failed: synced.failed,
    renewed,
    errors: errors.filter((error) => !closed(error))
  };
}
