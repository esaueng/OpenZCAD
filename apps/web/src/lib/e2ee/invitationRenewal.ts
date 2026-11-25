/**
 * Pending invitations don't lapse (L11 plan of 2026-11-25, §3.4). An
 * invitation statement is valid for seven days at most
 * (`MAX_PROJECT_INVITATION_LIFETIME_MS`). While nobody has accepted it,
 * the owner's certified device signs a fresh seven-day statement for the
 * same invitation shortly before the old one runs out, and the Worker
 * replaces the stored one (`PUT …/invitations/:invitationId`): the same
 * project, invitation, email hash, role, link token hash and invitee
 * identity, so the emailed link keeps working. Each statement keeps its
 * seven-day bound, and names when its chain began (`chainIssuedAt`):
 * no statement of a chain expires more than 30 days after that
 * (`MAX_PROJECT_INVITATION_CHAIN_MS`, checked by every verifier). The
 * chain ends when the owner cancels the invitation, when someone accepts
 * it (an acceptance signs the statement it saw, so that one never
 * changes), at that 30-day bound, or when no owner device is online
 * before it lapses.
 *
 * The server says which invitations are pending, so this account's own
 * record of what it cancelled decides first (`invitationTombstones.ts`):
 * nothing named there is renewed, and nothing is renewed at all while that
 * record cannot be read. Only a statement this account's own device list
 * certifies, still valid now, is renewed: the server's listing never gets
 * the owner to sign anything it did not sign before.
 */
import {
  decodeProjectInvitation,
  fromBase64Url,
  invitationChainIssuedAt,
  MAX_PROJECT_INVITATION_CHAIN_MS,
  MAX_PROJECT_INVITATION_LIFETIME_MS,
  publicKeyHash,
  signProjectInvitation,
  toBase64Url,
  verifyProjectInvitation,
  type ProjectInvitation
} from '@openzcad/crypto';
import {
  E2eeInvitationApiError,
  type E2eeInvitationRecord
} from '@openzcad/shared';
import type { InvitationContext } from './invitations';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A pending statement is renewed once no more than this is left of it
 * (judgment): at most about once a day per invitation, and an owner who
 * opens OpenZCAD on any of the six days before it lapses keeps it open.
 */
export const INVITATION_RENEWAL_WINDOW_MS = 6 * DAY_MS;

export interface InvitationRenewals {
  /** Invitation ids whose statement this device renewed. */
  readonly renewed: string[];
  readonly failed: { invitationId: string; error: unknown }[];
}

/** This account's statement of `record`, checked against its own list. */
async function ownStatement(
  ctx: InvitationContext,
  record: E2eeInvitationRecord,
  at: number
): Promise<ProjectInvitation> {
  const list = ctx.groups.account.list;
  const bytes = fromBase64Url(record.statement);
  const decoded = decodeProjectInvitation(bytes);
  const signer = list.devices.find(
    (device) => device.deviceId === decoded.signerDeviceId
  );
  if (
    !signer ||
    record.inviterUserId !== ctx.groups.account.userId ||
    decoded.role !== record.role
  ) {
    throw new Error(
      'This invitation is not signed by a device your device list certifies now.'
    );
  }
  return verifyProjectInvitation(
    { statement: bytes, signature: fromBase64Url(record.signature) },
    signer.signingKey,
    {
      now: at,
      expected: {
        projectId: record.projectId,
        invitationId: record.invitationId,
        inviterUserId: ctx.groups.account.userId
      }
    }
  );
}

const noLongerPending = (error: unknown) =>
  error instanceof E2eeInvitationApiError &&
  (error.code === 'E2EE_INVITATION_UNAVAILABLE' ||
    error.code === 'INVITATION_NOT_FOUND');

/**
 * Renews every pending invitation of this account whose statement has
 * `INVITATION_RENEWAL_WINDOW_MS` or less left. Does nothing on a device
 * its device list does not certify (it cannot sign). One that was accepted
 * or revoked meanwhile is skipped; any other failure is returned with the
 * rest still tried.
 */
export async function renewPendingInvitations(
  ctx: InvitationContext,
  options: { readonly windowMs?: number } = {}
): Promise<InvitationRenewals> {
  const renewed: string[] = [];
  const failed: InvitationRenewals['failed'] = [];
  const account = ctx.groups.account;
  const device = ctx.groups.device;
  const listed = device
    ? account.list.devices.find(
        (candidate) => candidate.deviceId === device.deviceId
      )
    : undefined;
  if (!device || !listed || device.userId !== account.userId) {
    return { renewed, failed };
  }
  // Fail closed: without this account's own record of what it cancelled,
  // nothing is renewed (a context without one renews nothing either).
  if (!ctx.tombstones) return { renewed, failed };
  const cancelled = await ctx.tombstones.cancelled();
  const now = ctx.now ?? Date.now;
  const windowMs = options.windowMs ?? INVITATION_RENEWAL_WINDOW_MS;
  const { invitations } = await ctx.api.pending();
  for (const record of invitations) {
    const at = now();
    if (
      cancelled.has(record.invitationId) ||
      record.inviterUserId !== account.userId ||
      record.acceptedByUserId !== null ||
      record.completedAt !== null ||
      record.revokedAt !== null ||
      record.expiresAt <= at ||
      record.expiresAt - at > windowMs
    ) {
      continue;
    }
    try {
      const current = await ownStatement(ctx, record, at);
      // The chain keeps where it began, and never runs past its bound.
      const chainIssuedAt = invitationChainIssuedAt(current);
      const expiresAt = Math.min(
        at + MAX_PROJECT_INVITATION_LIFETIME_MS,
        chainIssuedAt + MAX_PROJECT_INVITATION_CHAIN_MS
      );
      if (expiresAt <= current.expiresAt) continue;
      const value: ProjectInvitation = {
        ...current,
        issuedAt: at,
        expiresAt,
        chainIssuedAt,
        signerDeviceId: device.deviceId,
        signerKeyHash: await publicKeyHash(listed.signingKey)
      };
      const signed = await signProjectInvitation(
        device.signing.privateKey,
        value
      );
      await ctx.api.renew(record.projectId, record.invitationId, {
        statement: toBase64Url(signed.statement),
        signature: toBase64Url(signed.signature)
      });
      renewed.push(record.invitationId);
    } catch (error) {
      if (!noLongerPending(error)) {
        failed.push({ invitationId: record.invitationId, error });
      }
    }
  }
  return { renewed, failed };
}
