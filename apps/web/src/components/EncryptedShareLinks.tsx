import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import { StableLabel } from './StableLabel';
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
  list(projectId: string): Promise<EncryptedShareLinksState>;
  create(
    projectId: string,
    mode: EncryptedShareLinkMode
  ): Promise<{ url: string }>;
  revoke(projectId: string, shareId: string): Promise<void>;
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
  async list(projectId) {
    const [{ encryptedShareLinks }, links] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    const { ctx } = await encryptedShareLinks();
    let upkeepError: string | null = null;
    const upkeep = await links
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
    return {
      links: view.links.map((link) => ({
        shareId: link.shareId,
        mode: link.mode,
        url: link.url,
        status: link.status,
        expiresAt: link.expiresAt
      })),
      needsConfirmation:
        view.isOwner && links.delegationNeedsRenewal(view.delegation),
      retired: work?.retired ?? [],
      removalNotice: work?.notice ?? null,
      removalLinks: work?.removalLinks ?? [],
      problem:
        upkeepError ??
        (upkeep?.revocations.failed.length
          ? `A revoked link may still open for visitors: the server did not confirm it stopped serving it (${upkeep.revocations.failed[0]!.reason}). Revoke it again to retry.`
          : null)
    };
  },
  async create(projectId, mode) {
    const [{ encryptedShareLinks }, { createShareLink }] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    const created = await createShareLink(
      (await encryptedShareLinks()).ctx,
      projectId,
      mode
    );
    const problem = shareLinkCreationProblem(created);
    if (problem) throw new Error(problem);
    return { url: created.url };
  },
  async revoke(projectId, shareId) {
    const [{ encryptedShareLinks }, { revokeShareLink }] = await Promise.all([
      import('../lib/e2ee/encryptedProjects'),
      import('../lib/e2ee/shareLinks')
    ]);
    await revokeShareLink(
      (await encryptedShareLinks()).ctx,
      projectId,
      shareId
    );
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
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [transientRemoval, setTransientRemoval] = useState<{
    projectId: string;
    notice: ShareRemovalNotice;
  } | null>(null);
  const loadRevision = useRef(0);

  const load = useCallback(async () => {
    const revision = ++loadRevision.current;
    const next = await client.list(projectId);
    if (revision !== loadRevision.current) return;
    setState(next);
    if (next.problem) setError(next.problem);
  }, [client, projectId]);

  useEffect(() => {
    void load().catch((caught: unknown) => setError(message(caught)));
  }, [load]);

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
    try {
      await action();
      await load();
    } catch (caught) {
      setError(message(caught));
      // A revoke can fail after its tombstone was written: show the link
      // as revocation pending rather than active.
      await load().catch(() => undefined);
    } finally {
      setBusy(null);
    }
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
      className="sharing-section sharing-link"
      aria-label="Encrypted share links"
    >
      <div className="sharing-link-head">
        <Link2 size={16} aria-hidden="true" />
        <div className="sharing-link-text">
          <span className="sharing-link-title">Anyone with the link</span>
          <span className="sharing-tag">
            Opens the current model, read-only. The link carries its own key:
            OpenZCAD’s servers cannot open what it shows.
          </span>
        </div>
        <button
          type="button"
          className="primary sharing-share-create"
          disabled={disabled || state?.needsConfirmation}
          onClick={() =>
            void run('create', async () => {
              setCreated(null);
              setCopied(null);
              setCreated((await client.create(projectId, 'view')).url);
            })
          }
        >
          Create link
        </button>
      </div>

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
              Confirm with your passkey or recovery key. Visitors trust a link
              only while you have confirmed it in the last 30 days.
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
                  setRecoveryKey('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="sharing-share-notice" role="status">
            <span className="sharing-tag">
              Confirm sharing before creating a link. Existing links also need
              confirmation to keep opening for visitors.
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
        )
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
        <ul
          className="sharing-list sharing-share-list"
          aria-label="Active share links"
        >
          {links.map((row) => (
            <li key={row.shareId}>
              <span className="sharing-share-row-text">
                <span>{MODE_LABEL[row.mode]}</span>
                <span className="sharing-tag" data-status={row.status}>
                  {expiryText(row)}
                </span>
              </span>
              {row.url ? (
                <button
                  type="button"
                  className="sharing-row-action"
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
                onClick={() =>
                  void run(`revoke:${row.shareId}`, async () => {
                    await client.revoke(projectId, row.shareId);
                    setCreated(null);
                  })
                }
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : state ? (
        <p className="sharing-empty">No links yet.</p>
      ) : null}
    </section>
  );
}
