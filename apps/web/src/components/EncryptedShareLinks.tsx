import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { ProjectDocument } from '@openzcad/shared';
import {
  normalizeShareLinkLabel,
  PROJECT_SHARE_LINK_LABEL_MAX_LENGTH
} from '@openzcad/shared';
import {
  ShareLinkCard,
  ShareLinkComposer,
  ShareLinkCopyButton,
  ShareLinkFacts,
  ShareLinkNameField,
  writeClipboard,
  type ShareLinkDraft
} from './ShareLinkCard';
import { ShareLinkRevokeConfirm } from './ShareLinkRevokeConfirm';
import type { ShareLinkUpkeep } from '../lib/e2ee/shareLinks';
import type { ShareRemovalNotice } from '../lib/e2ee/shareWorkStore';
import { shareLinkCreationProblem } from '../lib/projectShareLink';

/**
 * Share links of an end-to-end encrypted project, in the sharing dialog's
 * encrypted branch (ADR-024 Phase 5, slice 5-10). The owner creates, copies
 * and revokes links; each row says until when visitors accept it or that it
 * needs confirming, or that its revocation is still pending on the server
 * (revoking it again retries). Links stay readable only while the owner's identity key
 * has recently confirmed them (the share delegation): the section asks for
 * a passkey or the recovery key when there is none or it ends within a
 * week. After a removal it offers to reissue the links, and after an owner
 * identity change it says the old links were turned off.
 */

/**
 * `frozen` (L08): view only, and the link serves the finished model without
 * its history instead of the project.
 */
export type EncryptedShareLinkMode = 'view' | 'tweak' | 'frozen';

export interface EncryptedShareLinkRow {
  readonly shareId: string;
  readonly mode: EncryptedShareLinkMode;
  /** Null when this device cannot open the link's key. */
  readonly url: string | null;
  /**
   * `revocation-pending`: revoked in the project, but the server has not
   * confirmed it stopped serving the link; revoking it again asks again.
   */
  readonly status:
    'active' | 'needs-confirming' | 'not-published' | 'revocation-pending';
  readonly expiresAt: number | null;
  /**
   * L08: whether the link's visitors may comment, by a grant one of the
   * owner's current devices signed; absent where that is not known.
   */
  readonly comments?: boolean;
  /**
   * The owner's name for the link, sealed under their account key (ADR-024
   * amendment 2026-11-22); absent when it has none or it is unknown here.
   */
  readonly name?: string | null;
}

export interface EncryptedShareLinksState {
  readonly removalNotice?: string | null;
  readonly removalLinks?: readonly {
    shareId: string;
    mode: EncryptedShareLinkMode;
  }[];
  readonly links: readonly EncryptedShareLinkRow[];
  /** The owner's confirmation (share delegation) needs the identity key. */
  readonly needsConfirmation: boolean;
  /**
   * The account has a passkey, so Create link confirms with it straight
   * away; without one it asks for the recovery key.
   */
  readonly passkey?: boolean;
  /** Links turned off because the owner's identity changed. */
  readonly retired: readonly {
    shareId: string;
    mode: EncryptedShareLinkMode;
  }[];
  /** Why a revoked link's server copy could not be forgotten again. */
  readonly problem?: string | null;
}

/** A passkey ceremony, or the recovery key as typed. */
export type ShareConfirmation = 'passkey' | { readonly recoveryKey: string };

export interface EncryptedShareLinkClient {
  /**
   * Asks the server again to forget revoked links it still serves, renews
   * statements that are due, then lists the head's active links and the
   * revoked ones still served.
   */
  list(
    projectId: string,
    options?: {
      /**
       * Skip the upkeep pass (retries, renewals, pending work): a refresh
       * right after an action that already did that work.
       */
      readonly upkeep?: false;
    }
  ): Promise<EncryptedShareLinksState>;
  create(
    projectId: string,
    mode: EncryptedShareLinkMode,
    /**
     * L08 (plan decisions 2 and 3a): sign a comment grant for the new link,
     * so its visitors can comment. `frozenDocument` (L08) is the model of
     * a `frozen` link, which it needs and only it takes.
     */
    options?: {
      readonly comments?: boolean;
      readonly frozenDocument?: ProjectDocument;
    }
  ): Promise<{ url: string; shareId: string }>;
  /**
   * Names a link, or clears its name (`name` null, already normalized),
   * in the owner's sealed account record. Without it links cannot be named.
   */
  rename?(
    projectId: string,
    shareId: string,
    name: string | null
  ): Promise<void>;
  /**
   * L08: the current model, frozen, replaces what a `frozen` link serves.
   * Its URL stays.
   */
  update?(
    projectId: string,
    shareId: string,
    frozenDocument: ProjectDocument
  ): Promise<void>;
  /** Revokes the link and drops its name. */
  revoke(projectId: string, shareId: string): Promise<void>;
  /**
   * L08: lets an existing link's visitors comment, or signs its grant again
   * once the device that signed it was removed.
   */
  allowComments?(projectId: string, shareId: string): Promise<void>;
  /** Confirms sharing with the identity key, then states every link. */
  confirm(projectId: string, confirmation: ShareConfirmation): Promise<void>;
  /** New links (ids and keys) in place of these, of the same modes. */
  reissue(
    projectId: string,
    links: readonly { shareId: string; mode: EncryptedShareLinkMode }[]
  ): Promise<void>;
  /** Removals in this project (slice 5-5's hook). */
  subscribeRemovals(
    projectId: string,
    listener: (notice?: ShareRemovalNotice) => void
  ): () => void;
  dismissRemoval?(projectId: string, notice: string): Promise<void>;
}

/** The page's client: crypto loads with the first encrypted dialog. */
export const pageEncryptedShareLinkClient: EncryptedShareLinkClient = {
  async list(projectId, options) {
    const [{ encryptedShareLinks }, links] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    const { ctx, hasPasskey } = await encryptedShareLinks();
    let upkeepError: string | null = null;
    const upkeep =
      options?.upkeep === false
        ? null
        : await links
            .maintainShareLinks(ctx, projectId)
            .catch((error: unknown) => {
              upkeepError = message(error);
              return null;
            });
    const work = await links
      .shareWorkFor(ctx)
      .read(ctx.groups.account.userId, projectId)
      .catch((error: unknown) => {
        upkeepError ??= message(error);
        return null;
      });
    const view = await links.listShareLinks(
      ctx,
      projectId,
      upkeep?.head ?? undefined
    );
    // L08: which links take comments; unknown when that cannot be read.
    const commenting = await Promise.resolve()
      .then(() => links.commentingShareLinks(ctx, projectId))
      .catch(() => null);
    // The owner's sealed names; unnamed when they cannot be read here.
    const names = await import('../lib/e2ee/sealedShareLinkNames')
      .then(({ pageShareLinkNames }) =>
        pageShareLinkNames(
          ctx.groups.account.userId,
          projectId,
          new Set(view.links.map((link) => link.shareId)),
          new Set(view.revokedIds),
          // A reissued link takes the name of the one it replaces.
          work?.replacements ?? []
        )
      )
      .catch((): Record<string, string> => ({}));
    return {
      links: view.links.map((link) => ({
        shareId: link.shareId,
        mode: link.mode,
        url: link.url,
        status: link.status,
        expiresAt: link.expiresAt,
        ...(commenting ? { comments: commenting.has(link.shareId) } : {}),
        name: names[link.shareId] ?? null
      })),
      needsConfirmation:
        view.isOwner && links.delegationNeedsRenewal(view.delegation),
      passkey: hasPasskey(),
      retired: work?.retired ?? [],
      removalNotice: work?.notice ?? null,
      removalLinks: work?.removalLinks ?? [],
      problem:
        upkeepError ??
        (upkeep?.revocations.failed.length
          ? `A revoked link may still open for visitors: the server did not confirm it stopped serving it (${upkeep.revocations.failed[0]!.reason}). Revoke it again to retry.`
          : null) ??
        snapshotProblem(upkeep)
    };
  },
  async create(projectId, mode, options) {
    const [{ encryptedShareLinks }, links] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    const ctx = (await encryptedShareLinks()).ctx;
    const created = await links.createShareLink(
      ctx,
      projectId,
      mode,
      options?.frozenDocument
    );
    const problem = shareLinkCreationProblem(created);
    if (problem) throw new Error(problem);
    if (options?.comments) {
      await links.allowShareLinkComments(ctx, projectId, {
        shareId: created.shareId,
        shareKey: created.fragment.shareKey
      });
    }
    return { url: created.url, shareId: created.shareId };
  },
  async rename(projectId, shareId, name) {
    const [{ encryptedShareLinks }, { renamePageShareLink }] =
      await Promise.all([
        import('../lib/e2ee/encryptedProjects'),
        import('../lib/e2ee/sealedShareLinkNames')
      ]);
    const { ctx } = await encryptedShareLinks();
    await renamePageShareLink(
      ctx.groups.account.userId,
      projectId,
      shareId,
      name
    );
  },
  async update(projectId, shareId, frozenDocument) {
    const [{ encryptedShareLinks }, links] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    await links.updateFrozenShareLink(
      (await encryptedShareLinks()).ctx,
      projectId,
      shareId,
      frozenDocument
    );
  },
  async allowComments(projectId, shareId) {
    const [{ encryptedShareLinks }, links] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    await links.allowShareLinkCommentsById(
      (await encryptedShareLinks()).ctx,
      projectId,
      shareId
    );
  },
  async revoke(projectId, shareId) {
    const [{ encryptedShareLinks }, { revokeShareLink }] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    const { ctx } = await encryptedShareLinks();
    await revokeShareLink(ctx, projectId, shareId);
    // Its name goes with it. Best effort: a later list prunes it anyway.
    await import('../lib/e2ee/sealedShareLinkNames')
      .then(({ renamePageShareLink }) =>
        renamePageShareLink(ctx.groups.account.userId, projectId, shareId, null)
      )
      .catch(() => {});
  },
  async confirm(projectId, confirmation) {
    const [{ encryptedShareLinks }, { issueShareAuthorities }, crypto] =
      await Promise.all([
        import('../lib/e2ee/encryptedProjects'),
        import('../lib/e2ee/shareLinks'),
        import('@openzcad/crypto')
      ]);
    const page = await encryptedShareLinks();
    if (confirmation === 'passkey') {
      await page.renewDelegation('passkey');
    } else {
      let secret: Uint8Array;
      try {
        secret = await crypto.parseRecoveryKey(confirmation.recoveryKey);
      } catch {
        throw new Error(
          'That is not a recovery key. Check it for typos: it is 56 letters and digits in groups of four.'
        );
      }
      try {
        await page.renewDelegation(secret);
      } finally {
        secret.fill(0);
      }
    }
    await issueShareAuthorities(page.ctx, projectId);
  },
  async reissue(projectId, links) {
    const [{ encryptedShareLinks }, { reissueShareLinks }] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    await reissueShareLinks(
      (await encryptedShareLinks()).ctx,
      projectId,
      links
    );
  },
  async dismissRemoval(projectId, notice) {
    const [{ encryptedShareLinks }, { acknowledgeShareRemoval }] =
      await Promise.all([
        import('../lib/e2ee/encryptedProjects'),
        import('../lib/e2ee/shareLinks')
      ]);
    await acknowledgeShareRemoval(
      (await encryptedShareLinks()).ctx,
      projectId,
      notice
    );
  },
  subscribeRemovals(projectId, listener) {
    let stop: (() => void) | null = null;
    let stopped = false;
    void import('../lib/e2ee/encryptedProjects').then(
      ({ subscribeMemberRemovals }) => {
        if (stopped) return;
        stop = subscribeMemberRemovals((removal) => {
          if (removal.projectId === projectId) listener(removal.shareNotice);
        });
      }
    );
    return () => {
      stopped = true;
      stop?.();
    };
  }
};

const STATUS_LABEL: Record<EncryptedShareLinkRow['status'], string> = {
  active: 'Active',
  'needs-confirming': 'Needs confirming',
  'not-published': 'Not published yet',
  'revocation-pending': 'Revocation pending'
};

const MODE_LABEL: Record<EncryptedShareLinkMode, string> = {
  view: 'View only',
  tweak: 'Tweak',
  frozen: 'No history'
};

function expiryText(row: EncryptedShareLinkRow): string {
  if (row.status !== 'active' || row.expiresAt === null) {
    // A link without history is published only from its own model: with
    // none stored, Update is what brings it back.
    return row.mode === 'frozen' && row.status === 'not-published'
      ? 'Needs an update'
      : STATUS_LABEL[row.status];
  }
  return `Active until ${new Date(row.expiresAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })}`;
}

/**
 * A link whose snapshot the upkeep could not publish: after a new statement
 * visitors refuse the older snapshot, so the link shows nothing until a
 * later upkeep or save publishes it.
 */
export function snapshotProblem(
  upkeep: Pick<ShareLinkUpkeep, 'authorities' | 'snapshots'> | null
): string | null {
  if (!upkeep) return null;
  const failed = [
    ...upkeep.authorities.snapshots.failed,
    ...upkeep.snapshots.failed
  ].find(({ shareId }) => !upkeep.snapshots.published.includes(shareId));
  return failed
    ? `A link's snapshot could not be published, so visitors may not see the project yet (${failed.reason}). Reopen sharing to retry.`
    : null;
}

const message = (caught: unknown) =>
  caught instanceof Error && caught.message
    ? caught.message
    : 'Something went wrong. Try again.';

/** What the Links tab's label says of the links: how many, and whether one needs the owner. */
export interface EncryptedShareLinksSummary {
  readonly count: number;
  readonly attention: boolean;
  /**
   * A problem the owner must read wherever the dialog opens, such as a
   * revoked link the server may still serve.
   */
  readonly problem?: string | null;
}

/** A link's status and comments, for its card's summary (its name says the mode). */
function linkSummary(row: EncryptedShareLinkRow): string {
  return `${expiryText(row)}${row.comments ? ' · Visitors can comment' : ''}`;
}

export function EncryptedShareLinks({
  projectId,
  client = pageEncryptedShareLinkClient,
  onFreezeModel,
  onSummary
}: {
  projectId: string;
  client?: EncryptedShareLinkClient;
  /**
   * L08: the current model frozen for a link without history. Without it
   * the option to leave history out is not offered.
   */
  onFreezeModel?(): Promise<ProjectDocument>;
  /** Reports the link count and whether a link needs the owner. */
  onSummary?(summary: EncryptedShareLinksSummary): void;
}) {
  const [state, setState] = useState<EncryptedShareLinksState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  // The new link's name in the output: the owner's, or its mode's.
  const [createdName, setCreatedName] = useState('View only link');
  // The new-link card is open (it always is while there are no links).
  const [composing, setComposing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The link whose Revoke is waiting for a yes (design review I2).
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The new link Create link asked for, made once sharing is confirmed.
  const pendingDraft = useRef<ShareLinkDraft | null>(null);
  const [createAfterConfirm, setCreateAfterConfirm] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [transientRemoval, setTransientRemoval] = useState<{
    projectId: string;
    notice: ShareRemovalNotice;
  } | null>(null);
  const loadRevision = useRef(0);

  // Whether the last full list reported a problem its upkeep may retry
  // (or none has finished yet: an action can start before the first one).
  const upkeepProblem = useRef(true);
  const load = useCallback(
    async (options?: { readonly upkeep?: false }) => {
      const revision = ++loadRevision.current;
      let next: EncryptedShareLinksState;
      try {
        next = await (options
          ? client.list(projectId, options)
          : client.list(projectId));
      } catch (caught) {
        // A newer load or action owns the error line now.
        if (revision !== loadRevision.current) return;
        throw caught;
      }
      if (revision !== loadRevision.current) return;
      if (!options) upkeepProblem.current = !!next.problem;
      setState(next);
      if (next.problem) setError(next.problem);
    },
    [client, projectId]
  );

  useEffect(() => {
    void load().catch((caught: unknown) => setError(message(caught)));
  }, [load]);

  // Confirmed (here, or partly before a later step failed): the form and
  // its Cancel go away, so nothing may stay waiting on them.
  const needsConfirmation = state?.needsConfirmation;
  useEffect(() => {
    if (needsConfirmation !== false) return;
    setConfirming(false);
    setCreateAfterConfirm(false);
    setRecoveryKey('');
  }, [needsConfirmation]);

  useEffect(
    () =>
      client.subscribeRemovals(projectId, (notice) => {
        if (notice?.problem) setError(notice.problem);
        if (notice)
          setTransientRemoval((current) => {
            if (current?.projectId !== projectId) return { projectId, notice };
            if (Number(current.notice.cursor) > Number(notice.cursor))
              return current;
            if (Number(current.notice.cursor) < Number(notice.cursor))
              return { projectId, notice };
            const links = new Map(
              [...current.notice.links, ...notice.links].map((link) => [
                link.shareId,
                link
              ])
            );
            return {
              projectId,
              notice: { ...notice, links: [...links.values()] }
            };
          });
        void load().catch((caught: unknown) => setError(message(caught)));
      }),
    [client, projectId, load]
  );

  const run = async (key: string, action: () => Promise<void>) => {
    // An earlier action's refresh no longer owns the list or error line.
    loadRevision.current++;
    setBusy(key);
    setError(null);
    // A new link or a confirmation shows its result itself, so the
    // controls come back before the list does. Any other action's result
    // is the list (a revoked link must not stay copyable meanwhile).
    const early = key === 'create' || key === 'confirm';
    let failed = false;
    try {
      await action();
    } catch (caught) {
      failed = true;
      setError(message(caught));
    } finally {
      if (early) setBusy(null);
    }
    // Without the upkeep pass unless the last one reported a problem it
    // retries (a revocation the server did not confirm). After a failure
    // too, since a revoke can fail after its tombstone was written: the
    // link then shows as revocation pending, not active.
    try {
      await (upkeepProblem.current ? load() : load({ upkeep: false })).catch(
        (caught: unknown) => {
          if (!failed) setError(message(caught));
        }
      );
    } finally {
      if (!early) setBusy(null);
    }
  };

  const createLink = async (draft: ShareLinkDraft) => {
    // Refused before anything is frozen or made.
    const label = client.rename ? normalizeShareLinkLabel(draft.name) : null;
    setCreated(null);
    const withoutHistory = Boolean(onFreezeModel) && !draft.history;
    const linkMode: EncryptedShareLinkMode = withoutHistory
      ? 'frozen'
      : draft.mode;
    // L08: frozen in this browser first, so a model that cannot be frozen
    // makes no link at all.
    const frozenDocument =
      withoutHistory && onFreezeModel ? await onFreezeModel() : undefined;
    const made = frozenDocument
      ? await client.create(projectId, 'frozen', {
          frozenDocument,
          ...(draft.comments ? { comments: true } : {})
        })
      : draft.comments
        ? await client.create(projectId, linkMode, { comments: true })
        : await client.create(projectId, linkMode);
    setCreated(made.url);
    setCreatedName(label ?? `${MODE_LABEL[linkMode]} link`);
    setComposing(false);
    if (label && client.rename) {
      // The link exists by now: a name that cannot be saved is reported,
      // and can be given again from its card.
      try {
        await client.rename(projectId, made.shareId, label);
      } catch (caught) {
        throw new Error(
          `The link was created, but its name was not saved: ${message(caught)}`,
          { cause: caught }
        );
      }
    }
  };
  // Inside the confirmation's own run: a refused confirmation creates nothing.
  const finishConfirm = async () => {
    const draft = pendingDraft.current;
    if (!createAfterConfirm || !draft) return;
    setCreateAfterConfirm(false);
    pendingDraft.current = null;
    await createLink(draft);
  };

  const copy = async (url: string) => writeClipboard(url);

  const links = state?.links ?? [];
  const transient =
    transientRemoval?.projectId === projectId ? transientRemoval : null;
  const removalCursor = transient?.notice.cursor ?? state?.removalNotice;
  const removalLinks = (
    transient?.notice.links ??
    state?.removalLinks ??
    []
  ).filter((affected) =>
    transient
      ? !links.some(
          (link) =>
            link.shareId === affected.shareId &&
            link.status === 'revocation-pending'
        )
      : links.some(
          (link) =>
            link.shareId === affected.shareId &&
            link.status !== 'revocation-pending'
        )
  );
  const acknowledgeRemoval = async () => {
    if (removalCursor && !transient?.notice.problem)
      await client.dismissRemoval?.(projectId, removalCursor);
    setTransientRemoval((current) => (current === transient ? null : current));
  };
  const disabled = busy !== null || state === null;
  // The form shows only while sharing needs confirming, so only then may
  // it hold the other controls: a refresh that finds the confirmation
  // (in any order with the action that made it) frees them.
  const awaitingConfirmation = confirming && !!state?.needsConfirmation;
  const showRemoval =
    Boolean(transient || state?.removalNotice) && removalLinks.length > 0;
  const showRetired = !!state && state.retired.length > 0;
  const showComposer = composing || (links.length === 0 && !created);

  // The Links tab's count, and a mark while a link needs the owner.
  const linkCount = state === null ? null : links.length;
  const revocationPending = links.some(
    (row) => row.status === 'revocation-pending'
  );
  const attention =
    showRemoval ||
    showRetired ||
    revocationPending ||
    !!error ||
    (links.length > 0 && !!state?.needsConfirmation);
  useEffect(() => {
    if (linkCount === null) return;
    onSummary?.({ count: linkCount, attention, problem: error });
  }, [onSummary, linkCount, attention, error]);

  const requestCreate = (draft: ShareLinkDraft) => {
    // One action (design review I79): Create link asks for the
    // confirmation sharing needs, then makes the link.
    if (!state?.needsConfirmation) {
      void run('create', () => createLink(draft));
      return;
    }
    pendingDraft.current = draft;
    setCreateAfterConfirm(true);
    if (!state.passkey) {
      setConfirming(true);
      return;
    }
    // Straight to the passkey prompt, in this click's activation.
    // Cancelled or refused, the recovery key is the other way.
    void run('confirm', async () => {
      try {
        await client.confirm(projectId, 'passkey');
      } catch (caught) {
        setConfirming(true);
        throw caught;
      }
      setCreateAfterConfirm(false);
      pendingDraft.current = null;
      await createLink(draft);
    });
  };

  return (
    <section
      className="sharing-section share-links"
      aria-label="Encrypted share links"
    >
      <p className="share-links-access">
        {state === null
          ? 'Checking links…'
          : links.length > 0
            ? `Anyone with a link · ${links.length} ${
                links.every((row) => row.status === 'active')
                  ? 'active'
                  : 'listed'
              }`
            : 'Only invited people'}
      </p>
      <p className="sharing-hint">
        {links.length > 0
          ? 'A link opens this model without an account. The key is in the link, so share it like a password.'
          : 'A link lets anyone who has it open this model without an account.'}
      </p>

      {error ? (
        <p className="sharing-share-hint" role="alert">
          {error}
        </p>
      ) : null}

      {state?.needsConfirmation ? (
        confirming ? (
          <div
            className="sharing-share-confirm"
            role="group"
            aria-label="Confirm sharing"
          >
            <p className="sharing-tag">
              {createAfterConfirm
                ? 'To create the link, confirm with your passkey or recovery key.'
                : 'Confirm with your passkey or recovery key.'}{' '}
              Visitors trust a link only while you have confirmed it in the last
              30 days.
            </p>
            <input
              className="sharing-share-url"
              type="text"
              aria-label="Recovery key"
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-…"
              value={recoveryKey}
              onChange={(event) => setRecoveryKey(event.target.value)}
            />
            <div className="sharing-share-actions">
              <button
                type="button"
                className="primary"
                disabled={disabled || recoveryKey.trim() === ''}
                onClick={() =>
                  void run('confirm', async () => {
                    await client.confirm(projectId, {
                      recoveryKey: recoveryKey.trim()
                    });
                    setRecoveryKey('');
                    setConfirming(false);
                    await finishConfirm();
                  })
                }
              >
                Confirm with recovery key
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void run('confirm', async () => {
                    await client.confirm(projectId, 'passkey');
                    setConfirming(false);
                    await finishConfirm();
                  })
                }
              >
                Confirm with passkey
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setConfirming(false);
                  setCreateAfterConfirm(false);
                  pendingDraft.current = null;
                  setRecoveryKey('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : links.length > 0 ? (
          // Without links, Create link asks for this itself; only existing
          // links need a separate nudge to keep opening.
          <div className="sharing-share-notice" role="status">
            <span className="sharing-tag">
              Your links need your confirmation to keep opening for visitors.
            </span>
            <button
              type="button"
              className="sharing-row-action"
              disabled={disabled}
              onClick={() => setConfirming(true)}
            >
              Confirm sharing…
            </button>
          </div>
        ) : null
      ) : null}

      {showRemoval ? (
        <div className="sharing-share-notice" role="status">
          <span className="sharing-tag">
            Someone lost access to this project. They can still open later
            snapshots through links made before. Reissue the links to give out
            new ones and stop the old ones.
          </span>
          <button
            type="button"
            className="sharing-row-action"
            disabled={disabled}
            onClick={() =>
              void run('reissue', async () => {
                await client.reissue(projectId, removalLinks);
                await acknowledgeRemoval();
              })
            }
          >
            Reissue links
          </button>
          <button
            type="button"
            className="sharing-row-action"
            disabled={disabled}
            onClick={() =>
              void run('dismiss', async () => {
                await acknowledgeRemoval();
              })
            }
          >
            Not now
          </button>
        </div>
      ) : null}

      {showRetired ? (
        <div className="sharing-share-notice" role="status">
          <span className="sharing-tag">
            Your encryption identity changed, so your links were turned off.
            Anyone still using an old link is not protected. Reissue the links
            and send the new ones.
          </span>
          <button
            type="button"
            className="sharing-row-action"
            disabled={disabled}
            onClick={() =>
              void run('reissue', async () => {
                await client.reissue(projectId, state.retired);
              })
            }
          >
            Reissue links
          </button>
        </div>
      ) : null}

      {created ? (
        <div className="sharing-share-output" role="status">
          <p className="share-link-created-title">{createdName} is ready</p>
          <input
            className="sharing-share-url"
            type="text"
            readOnly
            aria-label="Share link"
            value={created}
            onFocus={(event) => event.target.select()}
          />
          <ShareLinkCopyButton url={created} primary onCopy={copy} />
          <p className="sharing-share-mode">
            End-to-end encrypted: the key is in the link.
          </p>
        </div>
      ) : null}

      {showComposer ? (
        <ShareLinkComposer
          canExcludeHistory={Boolean(onFreezeModel)}
          nameable={Boolean(client.rename)}
          nameMaxLength={PROJECT_SHARE_LINK_LABEL_MAX_LENGTH}
          disabled={busy !== null || awaitingConfirmation}
          createDisabled={state === null}
          commentsHint="Visitors see only this link’s comments."
          footnote="End-to-end encrypted: the key is in the link."
          {...(links.length > 0 || created
            ? { onCancel: () => setComposing(false) }
            : {})}
          onCreate={requestCreate}
        />
      ) : (
        <button
          type="button"
          className="secondary share-links-new"
          disabled={disabled}
          onClick={() => setComposing(true)}
        >
          <Plus size={13} aria-hidden="true" />
          New link
        </button>
      )}

      {links.length > 0 ? (
        <ul className="share-link-cards" aria-label="Active share links">
          {links.map((row) => {
            const modeName = `${MODE_LABEL[row.mode]} link`;
            const name = row.name || modeName;
            if (revokingId === row.shareId) {
              return (
                <li key={row.shareId} className="sharing-confirm-row">
                  <ShareLinkRevokeConfirm
                    name={name}
                    disabled={busy !== null}
                    onCancel={() => {
                      setRevokingId(null);
                      // Its card stays open, so focus has its Revoke to go back to.
                      setExpandedId(row.shareId);
                      requestAnimationFrame(() =>
                        document
                          .querySelector<HTMLElement>(
                            `[data-share-link-revoke="${row.shareId}"]`
                          )
                          ?.focus()
                      );
                    }}
                    onRevoke={() => {
                      setRevokingId(null);
                      void run(`revoke:${row.shareId}`, async () => {
                        await client.revoke(projectId, row.shareId);
                        setCreated(null);
                        // Revoked: gone from the list at once, so it is not
                        // copyable while (or if) the refresh lags or fails.
                        setState((current) =>
                          current
                            ? {
                                ...current,
                                links: current.links.filter(
                                  (link) => link.shareId !== row.shareId
                                )
                              }
                            : current
                        );
                      });
                    }}
                  />
                </li>
              );
            }
            return (
              <ShareLinkCard
                key={row.shareId}
                name={name}
                unnamed={!row.name}
                summary={linkSummary(row)}
                attention={row.status !== 'active'}
                mode={row.mode}
                expanded={expandedId === row.shareId}
                onToggle={() =>
                  setExpandedId((open) =>
                    open === row.shareId ? null : row.shareId
                  )
                }
                copy={
                  // The link just created is copied from its box above:
                  // one place to copy it from, not two.
                  row.url && row.url !== created ? (
                    <ShareLinkCopyButton
                      url={row.url}
                      name={name}
                      disabled={busy !== null || row.status !== 'active'}
                      onCopy={copy}
                    />
                  ) : null
                }
              >
                {client.rename && row.status !== 'revocation-pending' ? (
                  <ShareLinkNameField
                    saved={row.name ?? ''}
                    formLabel={`Rename ${name}`}
                    placeholder={modeName}
                    maxLength={PROJECT_SHARE_LINK_LABEL_MAX_LENGTH}
                    disabled={busy !== null}
                    onSave={(draft) =>
                      run(`rename:${row.shareId}`, async () => {
                        const label = normalizeShareLinkLabel(draft);
                        if (label === (row.name ?? null)) return;
                        await client.rename!(projectId, row.shareId, label);
                        setState((current) =>
                          current
                            ? {
                                ...current,
                                links: current.links.map((link) =>
                                  link.shareId === row.shareId
                                    ? { ...link, name: label }
                                    : link
                                )
                              }
                            : current
                        );
                      })
                    }
                  />
                ) : null}
                <ShareLinkFacts
                  facts={[
                    [
                      'Visitors can',
                      row.mode === 'tweak'
                        ? 'View and change parameters'
                        : 'View, measure and export'
                    ],
                    [
                      'History',
                      row.mode === 'frozen'
                        ? 'Not included: the model as last updated'
                        : 'Included'
                    ],
                    [
                      'Comments',
                      row.comments === undefined
                        ? 'Unknown on this device'
                        : row.comments
                          ? 'On'
                          : 'Off'
                    ],
                    ['Status', expiryText(row)]
                  ]}
                />
                <div className="share-link-card-actions">
                  {row.comments === false &&
                  row.status === 'active' &&
                  client.allowComments ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy !== null}
                      aria-label={`Allow comments on ${name}`}
                      onClick={() =>
                        void run(`comments:${row.shareId}`, () =>
                          client.allowComments!(projectId, row.shareId)
                        )
                      }
                    >
                      Allow comments
                    </button>
                  ) : null}
                  {row.mode === 'frozen' &&
                  row.status !== 'revocation-pending' &&
                  onFreezeModel &&
                  client.update ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy !== null}
                      title="Share the model as it is now through this link"
                      aria-label={`Update ${name} to the current model`}
                      onClick={() =>
                        void run(`update:${row.shareId}`, async () =>
                          client.update!(
                            projectId,
                            row.shareId,
                            await onFreezeModel()
                          )
                        )
                      }
                    >
                      Update snapshot
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="secondary danger"
                    disabled={busy !== null}
                    aria-label={`Revoke ${name}`}
                    data-share-link-revoke={row.shareId}
                    onClick={() => setRevokingId(row.shareId)}
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
