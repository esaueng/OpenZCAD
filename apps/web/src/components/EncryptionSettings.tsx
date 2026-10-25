import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import {
  Copy,
  Download,
  KeyRound,
  QrCode,
  RefreshCcw,
  ShieldCheck,
  Trash2
} from 'lucide-react';
import {
  generateRecoveryKey,
  parseRecoveryKey,
  type Bytes
} from '@openzcad/crypto';
import type { E2eeApprovalRecord } from '@openzcad/shared';
import {
  advanceApprovalAsNewDevice,
  addPasskey,
  approveDevice,
  approverComparisonCode,
  beginCompareApproval,
  cancelApprovalRequest,
  confirmApprovalCode,
  defaultDeviceLabel,
  denyApproval,
  enrollWithRecoveryKey,
  enrollWithPasskey,
  EncryptionFlowError,
  forgetThisDevice,
  loadEncryption,
  removeDevice,
  removePasskey,
  revokeReadOnlyDevices,
  replaceRecoveryKey,
  requestApproval,
  setUpEncryption,
  type AccountView,
  type E2eeContext,
  type EncryptionState,
  type NewDeviceApprovalStep
} from '../lib/e2ee/accountKeys';
import type { RemovalOutcome } from '../lib/e2ee/deviceRemoval';
import { createE2eeApi, E2eeApiError } from '../lib/e2ee/e2eeApi';
import { projectRemovalStep } from '../lib/e2ee/projectRemovalStep';
import { DeviceListPinConflict } from '../lib/e2ee/deviceStore';
import {
  deviceKeyFactory,
  deviceKeyStore
} from '../lib/e2ee/keychainDeviceKeys';
import {
  PasskeyError,
  passkeysAvailable,
  passkeyEnrollmentCleanup
} from '../lib/e2ee/passkeys';
import { encodeQr, qrSvgPath } from '../lib/e2ee/qrCode';
import { invalidateAccountKeyReads } from '../lib/e2ee/unlockedKeys';
import {
  getKeySessionRevision,
  getKeySessionVersion,
  isCurrentKeySession,
  isKeySessionActive,
  requestKeySessionRecheck,
  subscribeKeySessionVersion
} from '../lib/e2ee/keySession';
import { Group, Notice, SettingRow, Status } from './settingsControls';
import { ProjectEncryptionPreference } from './ProjectEncryptionPreference';
import { EncryptedProjectRecovery } from './EncryptedProjectRecovery';
import '../styles/components/encryption.css';

/**
 * Settings › Encryption (ADR-024 Phase 3, first slice): set up account keys
 * with a confirmed recovery key, list devices and unlock methods, remove a
 * device (rotating the account and encryption keys), replace the recovery
 * key (which replaces the identity), and approve a new device by QR scan or
 * by comparing six digits. Loaded lazily with its crypto, only when the
 * section opens. No project is encrypted yet.
 */
export function EncryptionSettings({ userId }: { userId: string }) {
  const version = useSyncExternalStore(
    subscribeKeySessionVersion,
    getKeySessionVersion,
    () => 0
  );
  if (!isKeySessionActive())
    return (
      <Group>
        <Notice
          tone="warning"
          role="status"
          action={<RetryButton onClick={requestKeySessionRecheck} />}
        >
          Encryption keys are locked while the account session is checked.
        </Notice>
      </Group>
    );
  return (
    <AccountEncryptionSettings key={`${userId}:${version}`} userId={userId} />
  );
}

function AccountEncryptionSettings({ userId }: { userId: string }) {
  const lifetime = useMemo(
    () => ({ userId, active: false, generation: 0 }),
    [userId]
  );
  const ctx = useMemo<E2eeContext>(() => {
    const revision = getKeySessionRevision();
    return {
      userId,
      api: createE2eeApi(),
      store: deviceKeyStore(),
      createDeviceKeys: deviceKeyFactory(),
      isCurrent: () => lifetime.active && isCurrentKeySession(revision)
    };
  }, [userId, lifetime]);
  const [state, setState] = useState<EncryptionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<Flow>(null);

  const run = useCallback(
    async (work: () => Promise<EncryptionState | void>) => {
      const generation = lifetime.generation;
      const isCurrent = () =>
        lifetime.active && lifetime.generation === generation;
      if (!isCurrent()) return false;
      setBusy(true);
      setError(null);
      try {
        const next = await work();
        if (!isCurrent()) return false;
        if (next) setState(next);
        return true;
      } catch (caught) {
        if (!isCurrent()) return false;
        const cleanup = passkeyEnrollmentCleanup(caught);
        setError(`${messageFor(caught)}${cleanup ? ` ${cleanup}` : ''}`);
        return false;
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    [lifetime]
  );

  const reload = useCallback(() => run(() => loadEncryption(ctx)), [ctx, run]);

  useEffect(() => {
    lifetime.active = true;
    lifetime.generation++;
    void reload();
    return () => {
      lifetime.active = false;
      lifetime.generation++;
      invalidateAccountKeyReads(userId);
    };
  }, [reload, lifetime, userId]);

  if (!state) {
    return (
      <Group>
        {error ? (
          <Notice
            tone="warning"
            role="alert"
            action={<RetryButton onClick={() => void reload()} />}
          >
            {error}
          </Notice>
        ) : (
          <p className="encryption-loading" role="status">
            Loading encryption keys…
          </p>
        )}
      </Group>
    );
  }

  const shared = { ctx, busy, run, setFlow, flow };
  return (
    <div className="encryption-settings">
      {error ? (
        <Notice tone="warning" role="alert">
          {error}
        </Notice>
      ) : null}
      {state.kind === 'fork' ? (
        <Group title="Device list">
          <Notice
            tone="warning"
            role="alert"
            action={<RetryButton onClick={() => void reload()} />}
          >
            {state.message} Nothing was unlocked. If this keeps happening,
            compare your fingerprint on another device before trusting this one.
          </Notice>
        </Group>
      ) : state.kind === 'not-set-up' ? (
        flow?.kind === 'setup' ? (
          <RecoveryKeyFlow
            {...shared}
            title="Save your recovery key"
            finishLabel="Finish setup"
            onFinish={(secret) =>
              setUpEncryption(ctx, {
                recoverySecret: secret,
                label: defaultDeviceLabel(navigator.userAgent)
              })
            }
          />
        ) : (
          <Group title="Set up">
            <SettingRow
              title="End-to-end encryption"
              hint="Not set up. This creates your keys and a recovery key. Projects are not encrypted yet: that comes in a later beta step."
            >
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() => setFlow({ kind: 'setup' })}
              >
                <ShieldCheck size={14} aria-hidden="true" />
                Set up encryption
              </button>
            </SettingRow>
          </Group>
        )
      ) : (
        <AccountPanel
          {...shared}
          account={state.account}
          identityChanged={state.kind === 'identity-changed'}
          onReload={reload}
        />
      )}
      <ProjectEncryptionPreference
        userId={userId}
        unlocked={state.kind === 'ready' && state.account.unlocked}
      />
    </div>
  );
}

type Flow =
  | null
  | { kind: 'setup' }
  | { kind: 'replace' }
  | { kind: 'remove'; deviceId: string; label: string }
  | { kind: 'revoke-read-only' }
  | { kind: 'recover' }
  | { kind: 'add-passkey' }
  | { kind: 'remove-passkey'; targetId: string }
  | { kind: 'request'; step: NewDeviceApprovalStep }
  | { kind: 'approve'; approval: E2eeApprovalRecord; mode: 'scan' | 'compare' };

interface Shared {
  ctx: E2eeContext;
  busy: boolean;
  flow: Flow;
  setFlow(flow: Flow): void;
  run(work: () => Promise<EncryptionState | void>): Promise<boolean>;
}

function messageFor(error: unknown): string {
  if (
    error instanceof EncryptionFlowError ||
    error instanceof E2eeApiError ||
    error instanceof PasskeyError ||
    error instanceof DeviceListPinConflict
  ) {
    return error.message;
  }
  if (error instanceof Error && error.name === 'E2eeError') {
    return `The keys did not verify: ${error.message}`;
  }
  if (
    error instanceof Error &&
    (error.name === 'DeviceRemovalError' || error.name === 'ProjectGroupError')
  ) {
    return error.message;
  }
  return 'Encryption keys are unavailable right now. Check your connection and try again.';
}

function RetryButton({ onClick }: { onClick(): void }) {
  return (
    <button className="secondary" type="button" onClick={onClick}>
      <RefreshCcw size={13} aria-hidden="true" />
      Retry
    </button>
  );
}

function formatDate(value: number | string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

/** What a removal left for the other devices, in plain words. */
function removalNotice(outcome: RemovalOutcome): string | null {
  const left = outcome.left.filter((item) => item.projectId !== '*').length;
  if (outcome.left.length === 0) return null;
  if (left === 0)
    return 'The device was removed, but its encrypted projects could not be updated yet. Your other devices update each one before their next save.';
  return `The device was removed. ${left} encrypted ${left === 1 ? 'project gets' : 'projects get'} new keys the next time another of your devices saves ${left === 1 ? 'it' : 'them'}.`;
}

async function readRecoveryKey(text: string): Promise<Bytes> {
  try {
    return await parseRecoveryKey(text);
  } catch {
    throw new EncryptionFlowError(
      'wrong-recovery-key',
      'That is not a recovery key. Check it for typos: it is 56 letters and digits in groups of four.'
    );
  }
}

function AccountPanel({
  account,
  identityChanged,
  onReload,
  ...shared
}: Shared & {
  account: AccountView;
  identityChanged: boolean;
  onReload(): Promise<boolean>;
}) {
  const { ctx, busy, run, flow, setFlow } = shared;
  const thisDevice = account.device;
  const certified = account.deviceStatus === 'certified' && account.unlocked;
  const passkeys = account.list.unlockTargets.filter(
    (t) => t.kind === 'passkey'
  );
  const canUsePasskey =
    passkeysAvailable() && !identityChanged && passkeys.length > 0;
  const [removalLeft, setRemovalLeft] = useState<string | null>(null);
  const projectStep = () =>
    projectRemovalStep(ctx, (outcome) =>
      setRemovalLeft(removalNotice(outcome))
    );
  return (
    <>
      {removalLeft ? <Notice tone="warning">{removalLeft}</Notice> : null}
      {identityChanged ? (
        <Notice tone="warning" role="alert">
          Your encryption keys were replaced on another device, so this device
          no longer trusts them. Approve it again from that device by choosing
          Compare codes there, or enter the new recovery key.
        </Notice>
      ) : null}
      {account.unlockError ? (
        <Notice tone="warning" role="alert">
          This device could not unlock your keys: {account.unlockError}
        </Notice>
      ) : null}
      <Group title="This account">
        <SettingRow
          title="Your fingerprint"
          hint="What people compare to verify you. It changes only if you replace your recovery key."
        >
          <code className="encryption-code" aria-label="Your fingerprint">
            {account.fingerprint}
          </code>
        </SettingRow>
        <SettingRow
          title="This device"
          hint={
            thisDevice && account.deviceStatus !== 'none'
              ? thisDevice.label
              : 'No keys on this device yet.'
          }
        >
          <DeviceStatusBadge account={account} />
        </SettingRow>
      </Group>

      {!identityChanged &&
      (account.deviceStatus === 'certified' ||
        account.deviceStatus === 'approved') ? null : (
        <EnrollPanel {...shared} account={account} />
      )}
      {account.deviceStatus === 'approved' && flow?.kind !== 'recover' ? (
        <Group title="Certify this device">
          <SettingRow
            title="Certify with your recovery key"
            hint="Approved devices can read but not sign. Your recovery key certifies this one."
          >
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setFlow({ kind: 'recover' })}
            >
              <KeyRound size={14} aria-hidden="true" />
              Use recovery key
            </button>
          </SettingRow>
        </Group>
      ) : null}
      {flow?.kind === 'recover' ? (
        <RecoveryKeyEntry
          {...shared}
          title="Enter your recovery key"
          actionLabel="Unlock this device"
          onSubmit={(secret) =>
            enrollWithRecoveryKey(
              ctx,
              account,
              secret,
              thisDevice?.label ?? defaultDeviceLabel(navigator.userAgent)
            )
          }
        />
      ) : null}

      {account.deviceStatus !== 'certified' && canUsePasskey ? (
        <Group title="Unlock with a passkey">
          <SettingRow
            title="Use your passkey"
            hint="Choose a passkey for this account to unlock and certify this browser."
          >
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  enrollWithPasskey(
                    ctx,
                    account,
                    thisDevice?.label ?? defaultDeviceLabel(navigator.userAgent)
                  )
                )
              }
            >
              Use passkey
            </button>
          </SettingRow>
        </Group>
      ) : null}
      {certified ? (
        <EncryptedProjectRecovery
          ctx={ctx}
          account={account}
          canUsePasskey={canUsePasskey}
        />
      ) : null}
      <Group title="Devices" note={`${account.list.devices.length} certified`}>
        {account.list.devices.map((device) => (
          <SettingRow
            key={device.deviceId}
            title={device.label}
            hint={`Added ${formatDate(device.addedAt)}${
              device.deviceId === thisDevice?.deviceId ? ' · This device' : ''
            }`}
          >
            {device.deviceId === thisDevice?.deviceId ? (
              <Status tone="good">This device</Status>
            ) : (
              <button
                className="secondary"
                type="button"
                disabled={busy || !certified}
                aria-label={`Remove ${device.label}`}
                onClick={() =>
                  setFlow({
                    kind: 'remove',
                    deviceId: device.deviceId,
                    label: device.label
                  })
                }
              >
                <Trash2 size={14} aria-hidden="true" />
                Remove
              </button>
            )}
          </SettingRow>
        ))}
      </Group>
      <Group
        title="Read-only devices"
        note={`${account.approvedDevices.length} approved`}
      >
        {account.approvedDevices.map((device) => (
          <SettingRow
            key={device.deviceId}
            title={device.label}
            hint={`Approved ${formatDate(device.approvedAt)}`}
          >
            <Status tone="warning">Read-only</Status>
          </SettingRow>
        ))}
        <SettingRow
          title="Revoke read-only access"
          hint="Replaces your account and encryption keys. All read-only devices must be approved again; certified devices keep working."
        >
          <button
            className="secondary"
            type="button"
            disabled={busy || !certified}
            onClick={() => setFlow({ kind: 'revoke-read-only' })}
          >
            Revoke read-only devices
          </button>
        </SettingRow>
      </Group>
      {flow?.kind === 'revoke-read-only' ? (
        <RecoveryKeyEntry
          {...shared}
          title="Revoke read-only devices"
          intro="All read-only devices will need approval again. Certified devices keep working."
          actionLabel="Revoke read-only access"
          danger
          onSubmit={(secret) =>
            revokeReadOnlyDevices(ctx, account, secret, projectStep())
          }
          onPasskey={
            canUsePasskey
              ? () =>
                  revokeReadOnlyDevices(ctx, account, 'passkey', projectStep())
              : undefined
          }
        />
      ) : null}
      {flow?.kind === 'remove' ? (
        <RecoveryKeyEntry
          {...shared}
          title={`Remove ${flow.label}`}
          intro="Removing a device replaces your account key and encryption key, so it cannot open anything new. Certified devices keep working. Read-only devices must be approved again."
          actionLabel="Remove device"
          danger
          onSubmit={(secret) =>
            removeDevice(ctx, account, flow.deviceId, secret, projectStep())
          }
          onPasskey={
            canUsePasskey
              ? () =>
                  removeDevice(
                    ctx,
                    account,
                    flow.deviceId,
                    'passkey',
                    projectStep()
                  )
              : undefined
          }
        />
      ) : null}

      <Group title="Unlock methods">
        <SettingRow
          title="Device key"
          hint="Kept in this browser, where script cannot read it. Each device unlocks with its own."
        >
          <Status tone={account.unlocked ? 'good' : 'warning'}>
            {account.unlocked ? 'Unlocked' : 'Locked'}
          </Status>
        </SettingRow>
        <SettingRow
          title="Recovery key"
          hint={`Set up ${formatDate(account.createdAt)}. It opens your keys on any device and certifies new ones.`}
        >
          <Status tone="good">Confirmed</Status>
        </SettingRow>
        <SettingRow
          title="Passkeys"
          hint={
            passkeysAvailable()
              ? 'Requires a passkey that supports PRF. Your recovery key authorizes adding one.'
              : 'Passkeys are unavailable here. Use your recovery key or another device.'
          }
        >
          <button
            className="secondary"
            type="button"
            disabled={busy || !certified || !passkeysAvailable()}
            onClick={() => setFlow({ kind: 'add-passkey' })}
          >
            Add passkey
          </button>
        </SettingRow>
        {passkeys.map((target, index) => (
          <SettingRow
            key={target.targetId}
            title={`Passkey ${index + 1}`}
            hint={`Added ${formatDate(target.addedAt)} · ${target.targetId.slice(3, 15)}`}
          >
            <button
              className="secondary"
              type="button"
              disabled={busy || !certified}
              aria-label={`Remove passkey ${index + 1}`}
              onClick={() =>
                setFlow({ kind: 'remove-passkey', targetId: target.targetId })
              }
            >
              Remove
            </button>
          </SettingRow>
        ))}
      </Group>
      {flow?.kind === 'add-passkey' ? (
        <RecoveryKeyEntry
          {...shared}
          title="Add a passkey"
          actionLabel="Create passkey"
          intro="Save a passkey for encryption unlock. If enrollment fails, remove the newly saved passkey from your provider before trying again. Your recovery key remains available."
          onSubmit={(secret) => addPasskey(ctx, account, secret)}
        />
      ) : null}
      {flow?.kind === 'remove-passkey' ? (
        <RecoveryKeyEntry
          {...shared}
          title="Remove passkey"
          actionLabel="Remove passkey"
          danger
          intro="This replaces your account and encryption keys. The removed passkey cannot open future keys. Delete it from your passkey provider separately."
          onSubmit={(secret) =>
            removePasskey(ctx, account, flow.targetId, secret, projectStep())
          }
          onPasskey={
            canUsePasskey
              ? () =>
                  removePasskey(
                    ctx,
                    account,
                    flow.targetId,
                    'passkey',
                    projectStep()
                  )
              : undefined
          }
        />
      ) : null}

      {certified ? <ApprovalsPanel {...shared} account={account} /> : null}

      {certified ? (
        flow?.kind === 'replace' ? (
          <RecoveryKeyFlow
            {...shared}
            title="Your new recovery key"
            intro="Replacing your recovery key also replaces your identity. Every other device must be approved again, and everyone who verified you must verify your new fingerprint."
            finishLabel="Replace recovery key"
            askOldKey
            onFinish={(secret, oldSecret) =>
              replaceRecoveryKey(ctx, account, secret, oldSecret)
            }
          />
        ) : (
          <Group title="Recovery">
            <SettingRow
              title="Replace recovery key"
              hint="For a lost or exposed key. This replaces your identity: other devices must be approved again and contacts must verify you again."
            >
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => setFlow({ kind: 'replace' })}
              >
                <KeyRound size={14} aria-hidden="true" />
                Replace…
              </button>
            </SettingRow>
          </Group>
        )
      ) : null}

      <PreviousKeySets previous={account.previous} />
      <div className="settings-button-row">
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => void onReload()}
        >
          <RefreshCcw size={13} aria-hidden="true" />
          Refresh
        </button>
        {thisDevice && account.deviceStatus === 'removed' ? (
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await forgetThisDevice(ctx);
                return loadEncryption(ctx);
              })
            }
          >
            Forget this device’s keys
          </button>
        ) : null}
      </div>
    </>
  );
}

function DeviceStatusBadge({ account }: { account: AccountView }) {
  switch (account.deviceStatus) {
    case 'certified':
      return <Status tone="good">Certified</Status>;
    case 'approved':
      return <Status tone="warning">Approved, read-only</Status>;
    case 'pending':
      return <Status tone="warning">Waiting for approval</Status>;
    case 'removed':
      return <Status tone="warning">Removed</Status>;
    default:
      return <Status>Not unlocked</Status>;
  }
}

function EnrollPanel({
  account,
  ...shared
}: Shared & { account: AccountView }) {
  const { ctx, busy, run, flow, setFlow } = shared;
  const label =
    account.device?.label ?? defaultDeviceLabel(navigator.userAgent);
  const step = flow?.kind === 'request' ? flow.step : null;

  // Poll the approval request while this device waits.
  useEffect(() => {
    if (!step || step.step === 'done' || step.step === 'expired') return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void advanceApprovalAsNewDevice(ctx)
        .then((next) => {
          if (stopped) return;
          if (next.step === 'done') {
            setFlow(null);
            void run(async () => next.state);
          } else {
            setFlow({ kind: 'request', step: next });
          }
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [ctx, run, setFlow, step]);

  if (step && (step.step === 'waiting' || step.step === 'compare')) {
    return (
      <Group title="Approve this device">
        {step.step === 'waiting' ? (
          <SettingRow
            title="Scan this code"
            hint="On a device that is already unlocked, open Settings › Encryption and approve this one: scan the code, type it, or choose Compare codes."
          >
            <ScanCodeDisplay code={step.scanCode} />
          </SettingRow>
        ) : (
          <SettingRow
            title="Compare these digits"
            hint={
              step.confirmed
                ? 'Confirmed. Waiting for the other device to approve.'
                : 'Confirm only if the other device shows exactly the same six digits.'
            }
          >
            <div className="encryption-recovery">
              <output className="encryption-sas" aria-label="Approval code">
                {step.code}
              </output>
              {step.confirmed ? null : (
                <button
                  className="primary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const next = await confirmApprovalCode(ctx);
                      if (next.step === 'done') {
                        setFlow(null);
                        return next.state;
                      }
                      setFlow({ kind: 'request', step: next });
                    })
                  }
                >
                  Codes match
                </button>
              )}
            </div>
          </SettingRow>
        )}
        <div className="settings-button-row">
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await cancelApprovalRequest(ctx);
                setFlow(null);
                return loadEncryption(ctx);
              })
            }
          >
            Cancel request
          </button>
        </div>
      </Group>
    );
  }
  return (
    <Group title="Unlock this device">
      {step?.step === 'expired' ? (
        <Notice tone="warning" role="status">
          That approval request expired. Ask again.
        </Notice>
      ) : null}
      <SettingRow
        title="Approve from another device"
        hint="Show a code to scan or compare on a device that is already unlocked."
      >
        <button
          className="primary"
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const next = await requestApproval(ctx, account, label);
              setFlow({ kind: 'request', step: next });
            })
          }
        >
          <QrCode size={14} aria-hidden="true" />
          Ask for approval
        </button>
      </SettingRow>
      <SettingRow
        title="Use your recovery key"
        hint="Unlocks and certifies this device on its own."
      >
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => setFlow({ kind: 'recover' })}
        >
          <KeyRound size={14} aria-hidden="true" />
          Enter recovery key
        </button>
      </SettingRow>
    </Group>
  );
}

function ScanCodeDisplay({ code }: { code: string }) {
  const { path, size } = useMemo(() => qrSvgPath(encodeQr(code)), [code]);
  return (
    <div className="encryption-scan">
      <svg
        className="encryption-qr"
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Device approval QR code"
        shapeRendering="crispEdges"
      >
        <rect width={size} height={size} fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
      <code className="encryption-code" aria-label="Device approval code">
        {code}
      </code>
    </div>
  );
}

function ApprovalsPanel({
  account,
  ...shared
}: Shared & { account: AccountView }) {
  const { ctx, busy, run, flow, setFlow } = shared;
  const [approvals, setApprovals] = useState<E2eeApprovalRecord[]>([]);
  const approving = flow?.kind === 'approve' ? flow : null;

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
    const timer = window.setInterval(refresh, 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [ctx]);

  return (
    <Group title="Approve a new device">
      {approvals.length === 0 ? (
        <SettingRow
          title="Approval requests"
          hint="A device that asks for approval appears here. It needs your account to be signed in on it first."
        >
          <Status>None waiting</Status>
        </SettingRow>
      ) : null}
      {approvals.map((approval) =>
        approving?.approval.id === approval.id ? (
          <ApproveDevice
            key={approval.id}
            {...shared}
            account={account}
            approval={approval}
            mode={approving.mode}
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
                  setFlow({ kind: 'approve', approval, mode: 'scan' })
                }
              >
                <QrCode size={14} aria-hidden="true" />
                Scan code
              </button>
              <button
                className="secondary"
                type="button"
                disabled={
                  busy || !approval.commitment || approval.state !== 'requested'
                }
                onClick={() =>
                  void run(async () => {
                    const responded = await beginCompareApproval(
                      ctx,
                      account,
                      approval.id
                    );
                    setFlow({
                      kind: 'approve',
                      approval: responded,
                      mode: 'compare'
                    });
                  })
                }
              >
                Compare codes
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await denyApproval(ctx, approval.id);
                    setApprovals((list) =>
                      list.filter((item) => item.id !== approval.id)
                    );
                  })
                }
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
  ...shared
}: Shared & {
  account: AccountView;
  approval: E2eeApprovalRecord;
  mode: 'scan' | 'compare';
}) {
  const { ctx, busy, run, setFlow } = shared;
  const [scanned, setScanned] = useState('');
  const [recoveryText, setRecoveryText] = useState('');
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

  const approve = () =>
    void run(async () => {
      const secret = recoveryText.trim()
        ? await readRecoveryKey(recoveryText)
        : null;
      const next = await approveDevice(
        ctx,
        account,
        current,
        mode === 'scan' ? { kind: 'scan', code: scanned } : { kind: 'compare' },
        secret
      );
      setFlow(null);
      return next;
    });

  return (
    <div
      className="encryption-approve"
      aria-label={`Approve ${approval.label}`}
    >
      {mode === 'scan' ? (
        <SettingRow
          title="Code from the new device"
          hint="Scan the QR code it shows, or type the code under it."
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
      <SettingRow
        title="Certify the new device"
        hint="Optional. Without it the device can read but not sign until it certifies itself."
      >
        <input
          className="settings-text-wide"
          value={recoveryText}
          aria-label="Recovery key to certify the new device"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-…"
          onChange={(event) => setRecoveryText(event.target.value)}
        />
      </SettingRow>
      <div className="settings-button-row">
        <button
          className="primary"
          type="button"
          disabled={
            busy || (mode === 'scan' ? scanned.trim() === '' : code === null)
          }
          onClick={approve}
        >
          {mode === 'compare' ? 'Codes match, approve' : 'Approve device'}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => setFlow(null)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

/** Camera scanning where the browser has a QR detector; typing works anywhere. */
function QrScanner({ onCode }: { onCode(code: string): void }) {
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const Detector = (
    globalThis as {
      BarcodeDetector?: new (options: {
        formats: string[];
      }) => BarcodeDetectorLike;
    }
  ).BarcodeDetector;

  useEffect(() => {
    if (!scanning || !Detector) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    const detector = new Detector({ formats: ['qr_code'] });
    void navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' } })
      .then(async (media) => {
        stream = media;
        const video = videoRef.current;
        if (!video || stopped) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = media;
        await video.play();
        while (!stopped) {
          const [found] = await detector.detect(video).catch(() => []);
          if (stopped) return;
          if (found?.rawValue) {
            onCode(found.rawValue);
            setScanning(false);
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 300));
        }
      })
      .catch(() => setScanning(false));
    return () => {
      stopped = true;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [Detector, onCode, scanning]);

  if (!Detector || !navigator.mediaDevices) return null;
  return scanning ? (
    <div className="encryption-camera">
      <video ref={videoRef} muted playsInline aria-label="Camera" />
      <button
        className="secondary"
        type="button"
        onClick={() => setScanning(false)}
      >
        Stop camera
      </button>
    </div>
  ) : (
    <button
      className="secondary"
      type="button"
      onClick={() => setScanning(true)}
    >
      <QrCode size={14} aria-hidden="true" />
      Scan with camera
    </button>
  );
}

/**
 * Shows a fresh recovery key, then requires it typed back before `onFinish`
 * runs: setup cannot complete with an unsaved key.
 */
function RecoveryKeyFlow({
  title,
  intro,
  finishLabel,
  askOldKey = false,
  onFinish,
  ...shared
}: Shared & {
  title: string;
  intro?: string;
  finishLabel: string;
  askOldKey?: boolean;
  onFinish(secret: Bytes, oldSecret: Bytes | null): Promise<EncryptionState>;
}) {
  const { busy, run, setFlow } = shared;
  const [recovery, setRecovery] = useState<{
    secret: Bytes;
    formatted: string;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [oldTyped, setOldTyped] = useState('');
  const [mismatch, setMismatch] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void generateRecoveryKey().then((key) => {
      if (!cancelled) setRecovery(key);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!recovery) return null;

  const download = () => {
    const blob = new Blob(
      [
        `OpenZCAD recovery key\n\n${recovery.formatted}\n\nKeep this somewhere safe and offline. It opens your encryption keys on any device. OpenZCAD cannot recover it for you.\n`
      ],
      { type: 'text/plain' }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'openzcad-recovery-key.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  const finish = () =>
    void run(async () => {
      let parsed: Bytes | null;
      try {
        parsed = await parseRecoveryKey(typed);
      } catch {
        parsed = null;
      }
      const matches =
        parsed !== null &&
        parsed.every((byte, index) => byte === recovery.secret[index]);
      setMismatch(!matches);
      if (!matches) return;
      const oldSecret =
        askOldKey && oldTyped.trim() ? await readRecoveryKey(oldTyped) : null;
      const next = await onFinish(recovery.secret, oldSecret);
      setFlow(null);
      return next;
    });

  return (
    <Group title={title}>
      {intro ? <Notice tone="warning">{intro}</Notice> : null}
      {!confirming ? (
        <>
          <SettingRow
            title="Your recovery key"
            hint="Your only way back if you lose every device. OpenZCAD cannot recover it, and support cannot see your projects."
          >
            <div className="encryption-recovery">
              <code className="encryption-code" aria-label="Recovery key">
                {recovery.formatted}
              </code>
              <div className="encryption-actions">
                <button
                  className="secondary"
                  type="button"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText(recovery.formatted)
                      .catch(() => undefined)
                  }
                >
                  <Copy size={14} aria-hidden="true" />
                  Copy
                </button>
                <button className="secondary" type="button" onClick={download}>
                  <Download size={14} aria-hidden="true" />
                  Download
                </button>
              </div>
            </div>
          </SettingRow>
          <SettingRow
            title="I saved my recovery key"
            hint="In a password manager or on paper, somewhere other than this device."
          >
            <input
              type="checkbox"
              checked={saved}
              aria-label="I saved my recovery key"
              onChange={(event) => setSaved(event.target.checked)}
            />
          </SettingRow>
          <div className="settings-button-row">
            <button
              className="primary"
              type="button"
              disabled={!saved}
              onClick={() => setConfirming(true)}
            >
              Continue
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => setFlow(null)}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <SettingRow
            title="Confirm recovery key"
            hint="Type or paste the key you saved."
          >
            <input
              className="settings-text-wide"
              value={typed}
              aria-label="Confirm recovery key"
              aria-invalid={mismatch}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setTyped(event.target.value);
                setMismatch(false);
              }}
            />
          </SettingRow>
          {mismatch ? (
            <Notice tone="warning" role="alert">
              That does not match the recovery key above. Go back and check what
              you saved.
            </Notice>
          ) : null}
          {askOldKey ? (
            <SettingRow
              title="Current recovery key"
              hint="Optional. If you still have it, it signs the hand-over to your new identity; otherwise this device signs it."
            >
              <input
                className="settings-text-wide"
                value={oldTyped}
                aria-label="Current recovery key"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setOldTyped(event.target.value)}
              />
            </SettingRow>
          ) : null}
          <div className="settings-button-row">
            <button
              className="primary"
              type="button"
              disabled={busy || typed.trim() === ''}
              onClick={finish}
            >
              {finishLabel}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Back
            </button>
          </div>
        </>
      )}
    </Group>
  );
}

/** Asks for the recovery key to authorize one action. */
function RecoveryKeyEntry({
  title,
  intro,
  actionLabel,
  danger = false,
  onSubmit,
  onPasskey,
  ...shared
}: Shared & {
  title: string;
  intro?: string;
  actionLabel: string;
  danger?: boolean;
  onSubmit(secret: Bytes): Promise<EncryptionState>;
  onPasskey?(): Promise<EncryptionState>;
}) {
  const { busy, run, setFlow } = shared;
  const [text, setText] = useState('');
  return (
    <Group title={title} tone={danger ? 'danger' : undefined}>
      {intro ? <Notice tone="info">{intro}</Notice> : null}
      <SettingRow
        title="Recovery key to confirm"
        hint="Opens your identity key for this one change, then it is forgotten."
      >
        <input
          className="settings-text-wide"
          value={text}
          aria-label="Recovery key"
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX-…"
          onChange={(event) => setText(event.target.value)}
        />
      </SettingRow>
      <div className="settings-button-row">
        <button
          className={danger ? 'secondary danger' : 'primary'}
          type="button"
          disabled={busy || text.trim() === ''}
          onClick={() =>
            void run(async () => {
              const secret = await readRecoveryKey(text);
              try {
                const next = await onSubmit(secret);
                setText('');
                setFlow(null);
                return next;
              } finally {
                secret.fill(0);
              }
            })
          }
        >
          {actionLabel}
        </button>
        {onPasskey ? (
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = await onPasskey();
                setText('');
                setFlow(null);
                return next;
              })
            }
          >
            Confirm with passkey
          </button>
        ) : null}
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => setFlow(null)}
        >
          Cancel
        </button>
      </div>
    </Group>
  );
}

function PreviousKeySets({ previous }: { previous: AccountView['previous'] }) {
  if (previous.length === 0) return null;
  return (
    <Group title="Devices from replaced keys" note="Not trusted; approve again">
      {previous.flatMap((set) =>
        set.devices.map((device) => (
          <SettingRow
            key={`${set.generation}:${device.deviceId}`}
            title={device.label}
            hint={`Added ${formatDate(device.addedAt)} · key set from ${formatDate(set.createdAt)}`}
            compact
          />
        ))
      )}
    </Group>
  );
}
