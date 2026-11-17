import { useEffect, useState, useSyncExternalStore } from 'react';
import { QrCode, ScanLine } from 'lucide-react';
import type { E2eeApprovalRecord } from '@openzcad/shared';
import {
  approvalIsReconfirmation,
  approvalMatchesScanCode,
  approveDevice,
  approverComparisonCode,
  beginCompareApproval,
  canResumeCompareApproval,
  denyApproval,
  EncryptionFlowError,
  type AccountView,
  type ApprovalProof
} from '../../lib/e2ee/accountKeys';
import {
  clearPendingDeviceApproval,
  pendingDeviceApproval,
  subscribePendingDeviceApproval
} from '../../lib/e2ee/deviceApprovalLink';
import { Group, Notice, SettingRow, Status } from '../settingsControls';
import type { AuthorizeRequest } from './AuthorizeDialog';
import { messageFor, type Shared } from './flow';
import { QrScanner } from './qr';

/** How long a scanned link waits for its request to be listed. */
const LINK_SEARCH_MS = 90_000;

function usePendingLink(): string | null {
  return useSyncExternalStore(
    subscribePendingDeviceApproval,
    () => pendingDeviceApproval(),
    () => null
  );
}

/**
 * Settings › Encryption › Requests to join, on an unlocked certified
 * device: each new device asking for approval, verified by its scanned code
 * (in-app, or the link a phone's camera opened) or by six digits compared
 * on both screens. Approving always certifies the device, so it can save
 * (L11 plan T1): it asks for a passkey touch or the recovery key, except
 * for a device already certified with the same keys that only asks to have
 * its contacts confirmed.
 */
export function ApprovalRequests({
  account,
  passkey,
  onAuthorize,
  ...shared
}: Shared & {
  account: AccountView;
  /** This account has a passkey this browser can use. */
  passkey: boolean;
  onAuthorize(request: AuthorizeRequest): void;
}) {
  const { ctx, busy, run } = shared;
  const [approvals, setApprovals] = useState<E2eeApprovalRecord[] | null>(null);
  const [open, setOpen] = useState<{
    id: string;
    mode: 'scan' | 'compare';
    record: E2eeApprovalRecord;
  } | null>(null);
  const link = usePendingLink();
  const [linked, setLinked] = useState<string | null>(null);
  const [linkExpired, setLinkExpired] = useState(false);
  // Said inside this group, beside the request it concerns (review I4).
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const refresh = () =>
      void ctx.api
        .listApprovals()
        .then(({ approvals: next }) => {
          if (!stopped) setApprovals(next);
        })
        .catch(() => undefined);
    refresh();
    // Faster while a scanned link waits for its request to appear.
    const timer = window.setInterval(refresh, link ? 2000 : 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [ctx, link]);

  // Which listed request, if any, the scanned link names.
  useEffect(() => {
    if (!link || !approvals) {
      setLinked(null);
      return;
    }
    let live = true;
    void (async () => {
      for (const approval of approvals) {
        if (await approvalMatchesScanCode(approval, link)) {
          if (live) setLinked(approval.id);
          return;
        }
      }
      if (live) setLinked(null);
    })();
    return () => {
      live = false;
    };
  }, [approvals, link]);

  useEffect(() => {
    setLinkExpired(false);
    if (!link) return;
    const timer = window.setTimeout(() => setLinkExpired(true), LINK_SEARCH_MS);
    return () => window.clearTimeout(timer);
  }, [link]);

  const approve = (record: E2eeApprovalRecord, proof: ApprovalProof) =>
    void run(
      async () => {
        setError(null);
        // A wrong code is refused before any passkey prompt or key entry.
        if (
          proof.kind === 'scan' &&
          !(await approvalMatchesScanCode(record, proof.code))
        ) {
          throw new EncryptionFlowError(
            'scan-mismatch',
            'That code does not match the device asking for approval. Do not approve it.'
          );
        }
        const finish = () => {
          setOpen(null);
          if (proof.kind === 'scan' && proof.code === link)
            clearPendingDeviceApproval();
        };
        if (approvalIsReconfirmation(account, record)) {
          const next = await approveDevice(ctx, account, record, proof, null);
          finish();
          return next;
        }
        authorize(record, proof, finish);
      },
      { onError: setError }
    );

  const authorize = (
    record: E2eeApprovalRecord,
    proof: ApprovalProof,
    finish: () => void
  ) =>
    onAuthorize({
      title: `Approve “${record.label}”`,
      body: 'It will open and save your encrypted projects. Approve only a device you have with you or just set up yourself.',
      actionLabel: 'Approve device',
      passkey,
      work: async (authorization) => {
        const next = await approveDevice(
          ctx,
          account,
          record,
          proof,
          authorization
        );
        finish();
        return next;
      }
    });

  const deny = (record: E2eeApprovalRecord) =>
    void run(
      async () => {
        setError(null);
        await denyApproval(ctx, record.id);
        setApprovals(
          (list) => list?.filter((item) => item.id !== record.id) ?? list
        );
        if (record.id === linked) clearPendingDeviceApproval();
      },
      { onError: setError }
    );

  const linkedRecord = approvals?.find((item) => item.id === linked) ?? null;
  const others = (approvals ?? []).filter((item) => item.id !== linked);
  if (!link && others.length === 0) return null;

  return (
    <Group
      title="Requests to join"
      note={
        approvals && approvals.length > 0
          ? `${approvals.length} waiting`
          : undefined
      }
    >
      {error ? (
        <Notice tone="warning" role="alert">
          {error}
        </Notice>
      ) : null}
      {link && linkedRecord ? (
        <SettingRow
          title={linkedRecord.label}
          hint={`You scanned this device’s code. Asked ${new Date(linkedRecord.createdAt).toLocaleTimeString()}.`}
        >
          <div className="encryption-actions">
            <button
              className="primary"
              type="button"
              disabled={busy}
              onClick={() =>
                approve(linkedRecord, { kind: 'scan', code: link })
              }
            >
              Approve
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => deny(linkedRecord)}
            >
              Deny
            </button>
          </div>
        </SettingRow>
      ) : link ? (
        <Notice
          tone={linkExpired ? 'warning' : 'neutral'}
          role="status"
          action={
            <button
              className="secondary"
              type="button"
              onClick={() => clearPendingDeviceApproval()}
            >
              Dismiss
            </button>
          }
        >
          {linkExpired
            ? 'No device is asking to join with the code you scanned. On the new device, choose Ask for approval again and scan its new code.'
            : 'Looking for the device whose code you scanned… Keep it on its approval screen.'}
        </Notice>
      ) : null}
      {others.map((approval) =>
        open?.id === approval.id ? (
          <ApproveDevice
            key={approval.id}
            {...shared}
            account={account}
            approval={open.record}
            mode={open.mode}
            onCancel={() => setOpen(null)}
            onApprove={(record, proof) => approve(record, proof)}
          />
        ) : (
          <SettingRow
            key={approval.id}
            title={approval.label}
            hint={`Asked ${new Date(approval.createdAt).toLocaleTimeString()}`}
          >
            <div className="encryption-actions">
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() =>
                  setOpen({ id: approval.id, mode: 'scan', record: approval })
                }
              >
                <QrCode size={14} aria-hidden="true" />
                Scan code
              </button>
              <button
                className="secondary"
                type="button"
                disabled={
                  busy ||
                  !approval.commitment ||
                  (approval.state !== 'requested' &&
                    !canResumeCompareApproval(ctx, account, approval))
                }
                onClick={() =>
                  void run(async () => {
                    const responded = await beginCompareApproval(
                      ctx,
                      account,
                      approval.id
                    );
                    setOpen({
                      id: approval.id,
                      mode: 'compare',
                      record: responded
                    });
                  })
                }
              >
                {approval.state === 'requested'
                  ? 'Compare codes'
                  : 'Resume comparison'}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => deny(approval)}
              >
                Deny
              </button>
            </div>
          </SettingRow>
        )
      )}
    </Group>
  );
}

function ApproveDevice({
  account,
  approval,
  mode,
  onCancel,
  onApprove,
  ...shared
}: Shared & {
  account: AccountView;
  approval: E2eeApprovalRecord;
  mode: 'scan' | 'compare';
  onCancel(): void;
  onApprove(record: E2eeApprovalRecord, proof: ApprovalProof): void;
}) {
  const { ctx, busy } = shared;
  const [scanned, setScanned] = useState('');
  const [current, setCurrent] = useState(approval);
  const [code, setCode] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  // Compare form: wait for the new device to reveal its nonce.
  useEffect(() => {
    if (mode !== 'compare' || code) return;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await ctx.api.getApproval(approval.id);
        const shown = await approverComparisonCode(ctx, account, next);
        if (stopped) return;
        setCurrent(next);
        if (shown) setCode(shown);
      } catch (caught) {
        if (!stopped) setCodeError(messageFor(caught));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [account, approval.id, code, ctx, mode]);

  return (
    <div
      className="encryption-approve"
      aria-label={`Approve ${approval.label}`}
    >
      {mode === 'scan' ? (
        <SettingRow
          title="Code from the new device"
          hint="Scan its QR code, or type the code under it. A phone can also scan it with its own camera app."
        >
          <div className="encryption-scan-entry">
            <input
              className="settings-text-wide"
              value={scanned}
              aria-label="Code from the new device"
              autoComplete="off"
              spellCheck={false}
              placeholder="OZD1:…"
              onChange={(event) => setScanned(event.target.value)}
            />
            <QrScanner onCode={setScanned} />
          </div>
        </SettingRow>
      ) : (
        <SettingRow
          title="Compare the codes"
          hint="Approve only if the new device shows exactly these six digits."
        >
          {codeError ? (
            <Status tone="warning">{codeError}</Status>
          ) : code ? (
            <output className="encryption-sas" aria-label="Approval code">
              {code}
            </output>
          ) : (
            <Status>Waiting for the new device…</Status>
          )}
        </SettingRow>
      )}
      <div className="settings-button-row">
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="primary"
          type="button"
          disabled={
            busy || (mode === 'scan' ? scanned.trim() === '' : code === null)
          }
          onClick={() =>
            onApprove(
              current,
              mode === 'scan'
                ? { kind: 'scan', code: scanned }
                : { kind: 'compare' }
            )
          }
        >
          {mode === 'compare' ? 'Codes match, approve' : 'Approve device'}
        </button>
      </div>
    </div>
  );
}

/** Shown on a device that cannot approve yet, when a scanned link waits. */
export function PendingLinkNotice() {
  const link = usePendingLink();
  if (!link) return null;
  return (
    <Notice
      tone="info"
      role="status"
      action={
        <button
          className="secondary"
          type="button"
          onClick={() => clearPendingDeviceApproval()}
        >
          Dismiss
        </button>
      }
    >
      <ScanLine size={14} aria-hidden="true" /> You scanned a new device’s code.
      Unlock encryption on this device first; the request then appears here to
      approve.
    </Notice>
  );
}
