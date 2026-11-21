import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { StableLabel } from './StableLabel';
import {
  SHARE_LINK_MODE_HINT,
  ShareLinkModePicker
} from './ShareLinkModePicker';
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

export type EncryptedShareLinkMode = 'view' | 'tweak';

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
     * so its visitors can comment.
     */
    options?: { readonly comments?: boolean }
  ): Promise<{ url: string }>;
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
    const page = await encryptedShareLinks();
    const { ctx } = page;
    return page.scopeReads(async () => {
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
      return {
        links: view.links.map((link) => ({
          shareId: link.shareId,
          mode: link.mode,
          url: link.url,
          status: link.status,
          expiresAt: link.expiresAt,
          ...(commenting ? { comments: commenting.has(link.shareId) } : {})
        })),
        needsConfirmation:
          view.isOwner && links.delegationNeedsRenewal(view.delegation),
        passkey: page.hasPasskey(),
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
    });
  },
  async create(projectId, mode, options) {
    const [{ encryptedShareLinks }, links] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    const page = await encryptedShareLinks();
    const { ctx } = page;
    return page.scopeReads(async () => {
      const created = await links.createShareLink(ctx, projectId, mode);
      const problem = shareLinkCreationProblem(created);
      if (problem) throw new Error(problem);
      if (options?.comments) {
        await links.allowShareLinkComments(ctx, projectId, {
          shareId: created.shareId,
          shareKey: created.fragment.shareKey
        });
      }
      return { url: created.url };
    });
  },
  async allowComments(projectId, shareId) {
    const [{ encryptedShareLinks }, links] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    const page = await encryptedShareLinks();
    await page.scopeReads(() =>
      links.allowShareLinkCommentsById(page.ctx, projectId, shareId)
    );
  },
  async revoke(projectId, shareId) {
    const [{ encryptedShareLinks }, { revokeShareLink }] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    const page = await encryptedShareLinks();
    await page.scopeReads(() => revokeShareLink(page.ctx, projectId, shareId));
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
    await page.scopeReads(() => issueShareAuthorities(page.ctx, projectId));
  },
  async reissue(projectId, links) {
    const [{ encryptedShareLinks }, { reissueShareLinks }] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    const page = await encryptedShareLinks();
    await page.scopeReads(() => reissueShareLinks(page.ctx, projectId, links));
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
  tweak: 'Tweak'
};

function expiryText(row: EncryptedShareLinkRow): string {
  if (row.status !== 'active' || row.expiresAt === null) {
    return STATUS_LABEL[row.status];
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

export function EncryptedShareLinks({
  projectId,
  client = pageEncryptedShareLinkClient
}: {
  projectId: string;
  client?: EncryptedShareLinkClient;
}) {
  const [state, setState] = useState<EncryptedShareLinksState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  // What the next link lets its visitors do; Tweak includes View.
  const [mode, setMode] = useState<EncryptedShareLinkMode>('view');
  // The mode of the link in the output: the picker may have moved on.
  const [createdMode, setCreatedMode] =
    useState<EncryptedShareLinkMode>('view');
  const detailId = useId();
  // L08: whether the next link's visitors may comment (plan decision 3a).
  const [withComments, setWithComments] = useState(false);
  // The link whose Revoke is waiting for a yes (design review I2).
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The confirmation was asked for by Create link, which finishes after it.
  const [createAfterConfirm, setCreateAfterConfirm] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [transientRemoval, setTransientRemoval] = useState<{
    projectId: string;
    notice: ShareRemovalNotice;
  } | null>(null);
  const loadRevision = useRef(0);

  // Whether the last full list reported a problem its upkeep may retry.
  const upkeepProblem = useRef(false);
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
    setBusy(key);
    setError(null);
    let failed = false;
    try {
      await action();
    } catch (caught) {
      failed = true;
      setError(message(caught));
    } finally {
      setBusy(null);
    }
    // The action's result is already on screen: the list catches up
    // behind it, without the upkeep pass unless the last one reported a
    // problem it retries (a revocation the server did not confirm). After
    // a failure too, since a revoke can fail after its tombstone was
    // written: the link then shows as revocation pending, not active.
    await (upkeepProblem.current ? load() : load({ upkeep: false })).catch(
      (caught: unknown) => {
        if (!failed) setError(message(caught));
      }
    );
  };

  const createLink = async () => {
    setCreated(null);
    setCopied(null);
    const linkMode = mode;
    setCreated(
      (withComments
        ? await client.create(projectId, linkMode, { comments: true })
        : await client.create(projectId, linkMode)
      ).url
    );
    setCreatedMode(linkMode);
  };
  // Inside the confirmation's own run: a refused confirmation creates nothing.
  const finishConfirm = async () => {
    if (!createAfterConfirm) return;
    setCreateAfterConfirm(false);
    await createLink();
  };

  const copy = async (url: string, key: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  };

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

  return (
    <section
      className="sharing-section sharing-access-section"
      aria-label="Encrypted share links"
    >
      <h3 className="sharing-section-label">General access</h3>
      <div className="sharing-access">
        <Globe className="sharing-access-icon" size={14} aria-hidden="true" />
        <span className="sharing-access-title">
          {state === null
            ? 'Checking links…'
            : links.length > 0
              ? `Anyone with a link · ${links.length} ${
                  links.every((row) => row.status === 'active')
                    ? 'active'
                    : 'listed'
                }`
              : 'Only invited people'}
        </span>
      </div>
      <div className="sharing-link-create">
        <ShareLinkModePicker
          value={mode}
          disabled={busy !== null || confirming}
          describedBy={detailId}
          onChange={setMode}
        />
        <label className="sharing-link-comments">
          <input
            type="checkbox"
            checked={withComments}
            disabled={busy !== null || confirming}
            aria-describedby={detailId}
            onChange={(event) => setWithComments(event.target.checked)}
          />
          Visitors can comment
        </label>
        <button
          type="button"
          className={links.length > 0 ? 'secondary' : 'primary'}
          disabled={disabled || confirming}
          onClick={() => {
            // One action (design review I79): Create link asks for the
            // confirmation sharing needs, then makes the link.
            if (!state?.needsConfirmation) {
              void run('create', createLink);
              return;
            }
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
              await createLink();
            });
          }}
        >
          Create link
        </button>
      </div>
      <p id={detailId} className="sharing-access-detail">
        {SHARE_LINK_MODE_HINT[mode]}
        {withComments ? ' They see only this link’s comments.' : ''} End-to-end
        encrypted: the key is in the link.
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

      {created ? (
        <div className="sharing-share-output" role="status">
          <input
            className="sharing-share-url"
            type="text"
            readOnly
            aria-label="Share link"
            value={created}
            onFocus={(event) => event.target.select()}
          />
          <button
            type="button"
            className="sharing-share-copy"
            onClick={() => void copy(created, 'created')}
          >
            <StableLabel reserve={['Copied', 'Copy']} align="center">
              {copied === 'created' ? 'Copied' : 'Copy'}
            </StableLabel>
          </button>
          <p className="sharing-share-mode">{MODE_LABEL[createdMode]} link</p>
        </div>
      ) : null}

      {(transient || state?.removalNotice) && removalLinks.length > 0 ? (
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

      {state && state.retired.length > 0 ? (
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

      {links.length > 0 ? (
        <ul className="sharing-list" aria-label="Active share links">
          {links.map((row) =>
            revokingId === row.shareId ? (
              <li key={row.shareId} className="sharing-confirm-row">
                <ShareLinkRevokeConfirm
                  name={`${MODE_LABEL[row.mode]} link`}
                  disabled={busy !== null}
                  onCancel={() => {
                    setRevokingId(null);
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
                    });
                  }}
                />
              </li>
            ) : (
              <li key={row.shareId}>
                <span className="sharing-row-text">
                  <span className="sharing-member-id">
                    {MODE_LABEL[row.mode]} link
                  </span>
                  <span className="sharing-row-detail" data-status={row.status}>
                    {expiryText(row)}
                    {row.comments ? ' · Visitors can comment' : ''}
                  </span>
                </span>
                {row.comments === false &&
                row.status === 'active' &&
                client.allowComments ? (
                  <button
                    type="button"
                    className="sharing-row-action"
                    disabled={busy !== null}
                    aria-label={`Allow comments on ${MODE_LABEL[row.mode]} link`}
                    onClick={() =>
                      void run(`comments:${row.shareId}`, () =>
                        client.allowComments!(projectId, row.shareId)
                      )
                    }
                  >
                    Allow comments
                  </button>
                ) : null}
                {row.url ? (
                  <button
                    type="button"
                    className="sharing-row-copy"
                    disabled={busy !== null || row.status !== 'active'}
                    aria-label={`Copy ${MODE_LABEL[row.mode]} link`}
                    onClick={() => void copy(row.url!, row.shareId)}
                  >
                    <StableLabel reserve={['Copied', 'Copy']} align="center">
                      {copied === row.shareId ? 'Copied' : 'Copy'}
                    </StableLabel>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="sharing-row-action"
                  disabled={busy !== null}
                  aria-label={`Revoke ${MODE_LABEL[row.mode]} link`}
                  data-share-link-revoke={row.shareId}
                  onClick={() => setRevokingId(row.shareId)}
                >
                  Revoke
                </button>
              </li>
            )
          )}
        </ul>
      ) : null}
    </section>
  );
}
