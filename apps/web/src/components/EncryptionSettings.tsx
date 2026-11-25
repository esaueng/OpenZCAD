import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react';
import {
  Fingerprint,
  KeyRound,
  Lock,
  QrCode,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2
} from 'lucide-react';
import {
  addPasskey,
  advanceApprovalAsNewDevice,
  cancelApprovalRequest,
  confirmApprovalCode,
  defaultDeviceLabel,
  enrollWithPasskey,
  enrollWithRecoveryKey,
  EncryptionFlowError,
  forgetThisDevice,
  loadEncryption,
  removeDevice,
  removePasskey,
  requestApproval,
  revokeReadOnlyDevices,
  type AccountView,
  type E2eeContext,
  type EncryptionState,
  type NewDeviceApprovalStep
} from '../lib/e2ee/accountKeys';
import type { RemovalOutcome } from '../lib/e2ee/deviceRemoval';
import { createE2eeApi } from '../lib/e2ee/e2eeApi';
import { projectRemovalStep } from '../lib/e2ee/projectRemovalStep';
import { notifyContactsChanged } from '../lib/e2ee/contactFocus';
import {
  deviceKeyFactory,
  deviceKeyStore
} from '../lib/e2ee/keychainDeviceKeys';
import {
  passkeyEnrollmentCleanup,
  passkeysAvailable
} from '../lib/e2ee/passkeys';
import { invalidateAccountKeyReads } from '../lib/e2ee/unlockedKeys';
import {
  encryptionStateChanged,
  observeEncryptionState
} from '../lib/e2ee/encryptionStateEvents';
import {
  getKeySessionRevision,
  getKeySessionVersion,
  isCurrentKeySession,
  isKeySessionActive,
  requestKeySessionRecheck,
  subscribeKeySessionVersion
} from '../lib/e2ee/keySession';
import {
  Group,
  MoreGroups,
  Notice,
  SettingRow,
  Status,
  Summary
} from './settingsControls';
import { ProjectEncryptionPreference } from './ProjectEncryptionPreference';
import { ExistingProjectEncryption } from './ExistingProjectEncryption';
import { StopProjectEncryption } from './StopProjectEncryption';
import { EncryptedPinRecovery } from './EncryptedPinReset';
import { EncryptedProjectRecovery } from './EncryptedProjectRecovery';
import { EncryptionContacts } from './EncryptionContacts';
import { EncryptedInvitations } from './EncryptedInvitations';
import { AssistantAccessSettings } from './AssistantAccessSettings';
import {
  AuthorizeDialog,
  type AuthorizeRequest
} from './encryption/AuthorizeDialog';
import {
  ApprovalRequests,
  PendingLinkNotice
} from './encryption/ApprovalRequests';
import {
  ReplaceRecoveryKeyDialog,
  SetupDialog
} from './encryption/SetupDialog';
import { QrScanner, ScanCodeDisplay } from './encryption/qr';
import {
  formatDate,
  messageFor,
  type RunOptions,
  type Shared
} from './encryption/flow';
import '../styles/components/encryption.css';

/** Where Settings › Encryption › Encrypt existing projects starts. */
const EXISTING_PROJECTS_ID = 'encryption-existing-projects';

/**
 * Settings › Encryption (ADR-024; simplified in the L11 plan of 2026-11-16).
 * One status line with one next action, then this device's unlock options
 * or the requests to join, the devices and ways in (passkeys, recovery
 * key), projects, people, and everything rare folded under Advanced. Setup,
 * recovery-key replacement and every key-authorized action are dialogs.
 * Loaded lazily with its crypto, only when the section opens.
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

type Dialog =
  | null
  | { kind: 'setup' }
  | { kind: 'replace' }
  | { kind: 'authorize'; request: AuthorizeRequest };

function AccountEncryptionSettings({ userId }: { userId: string }) {
  const lifetime = useMemo(
    () => ({ userId, active: false, generation: 0 }),
    [userId]
  );
  const ctx = useMemo<E2eeContext>(() => {
    const revision = getKeySessionRevision();
    const context: E2eeContext = {
      userId,
      readScope: lifetime,
      api: createE2eeApi(),
      store: deviceKeyStore(),
      createDeviceKeys: deviceKeyFactory(),
      isCurrent: () => lifetime.active && isCurrentKeySession(revision),
      // L11 (D4): every action authorized here renews the share delegation
      // in passing when it is due.
      afterIdentityKey: (step) =>
        import('../lib/e2ee/shareDelegationInPassing').then((page) =>
          page.renewShareDelegationInPassing(context, step)
        )
    };
    return context;
  }, [userId, lifetime]);
  const [state, setState] = useState<EncryptionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [request, setRequest] = useState<NewDeviceApprovalStep | null>(null);

  const run = useCallback(
    async (
      work: () => Promise<EncryptionState | void>,
      options: RunOptions = {}
    ) => {
      const generation = lifetime.generation;
      const isCurrent = () =>
        lifetime.active && lifetime.generation === generation;
      if (!isCurrent()) return false;
      setBusy(true);
      setError(null);
      try {
        const next = await work();
        if (!isCurrent()) return false;
        if (next) {
          setState(next);
          // A change made here (setup, unlock, a device added or removed,
          // a key replaced, a recovery) always retires the page's
          // encrypted-project clients. A plain reload does so only when it
          // found the account changed: retiring them drops their verified
          // caches, and the shelf's next listing then reads every
          // project's authority and device lists again.
          const changed = observeEncryptionState(userId, next);
          if (!options.readOnly || changed) encryptionStateChanged(userId);
        }
        return true;
      } catch (caught) {
        if (!isCurrent()) return false;
        const cleanup = passkeyEnrollmentCleanup(caught);
        const message = `${messageFor(caught)}${cleanup ? ` ${cleanup}` : ''}`;
        if (options.onError) options.onError(message);
        else setError(message);
        return false;
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    [lifetime, userId]
  );

  const reload = useCallback(
    () => run(() => loadEncryption(ctx), { readOnly: true }),
    [ctx, run]
  );

  useEffect(() => {
    lifetime.active = true;
    lifetime.generation++;
    void reload();
    return () => {
      lifetime.active = false;
      lifetime.generation++;
      invalidateAccountKeyReads(userId, lifetime);
    };
  }, [reload, lifetime, userId]);

  const shared: Shared = { ctx, busy, run };
  const closeDialog = () => setDialog(null);
  const dialogs =
    dialog?.kind === 'setup' ? (
      <SetupDialog
        {...shared}
        userId={userId}
        onClose={closeDialog}
        onEncryptExisting={() => {
          closeDialog();
          window.requestAnimationFrame(() =>
            document
              .getElementById(EXISTING_PROJECTS_ID)
              ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          );
        }}
      />
    ) : dialog?.kind === 'replace' &&
      state &&
      (state.kind === 'ready' || state.kind === 'identity-changed') ? (
      <ReplaceRecoveryKeyDialog
        {...shared}
        account={state.account}
        onClose={closeDialog}
      />
    ) : dialog?.kind === 'authorize' ? (
      <AuthorizeDialog
        busy={busy}
        run={run}
        request={dialog.request}
        onClose={closeDialog}
      />
    ) : null;

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

  const unlocked = state.kind === 'ready' && state.account.unlocked;
  return (
    <div className="encryption-settings">
      {error ? (
        <Group>
          <Notice tone="warning" role="alert">
            {error}
          </Notice>
        </Group>
      ) : null}
      {state.kind === 'fork' ? (
        <Group>
          <Summary
            icon={<ShieldAlert size={18} />}
            tone="warning"
            title="Device list did not verify"
            action={<RetryButton onClick={() => void reload()} />}
            alert
          >
            {state.message} Nothing was unlocked.
          </Summary>
          <Notice tone="warning">
            If this keeps happening, compare your fingerprint (under Advanced
            encryption settings) on another device before trusting this one.
          </Notice>
        </Group>
      ) : state.kind === 'not-set-up' ? (
        <>
          <Group>
            <Summary
              icon={<ShieldOff size={18} />}
              tone="off"
              title="Encryption is off"
              action={
                <button
                  className="primary"
                  type="button"
                  disabled={busy}
                  onClick={() => setDialog({ kind: 'setup' })}
                >
                  <ShieldCheck size={14} aria-hidden="true" />
                  Set up encryption
                </button>
              }
            >
              Turn it on so only your devices can read your cloud projects.
            </Summary>
            <PendingLinkNotice />
          </Group>
          <EncryptedInvitations ready={false} />
        </>
      ) : (
        <AccountPanel
          {...shared}
          userId={userId}
          account={state.account}
          identityChanged={state.kind === 'identity-changed'}
          request={request}
          setRequest={setRequest}
          onReload={reload}
          openDialog={setDialog}
          projects={
            <>
              {state.kind === 'ready' ? (
                <EncryptedInvitations ready={state.account.unlocked} />
              ) : null}
              <div id={EXISTING_PROJECTS_ID}>
                <ExistingProjectEncryption
                  userId={userId}
                  unlocked={unlocked}
                />
              </div>
              <AssistantAccessSettings userId={userId} unlocked={unlocked} />
              <EncryptedPinRecovery />
            </>
          }
          contacts={
            state.kind === 'ready' ? (
              <EncryptionContacts
                keys={ctx}
                account={state.account}
                Scanner={QrScanner}
                onConfirmFromDevice={
                  state.account.device &&
                  (state.account.deviceStatus === 'certified' ||
                    state.account.deviceStatus === 'approved')
                    ? () =>
                        void run(async () => {
                          // The approval exchange hands this device the
                          // approver's contacts head (ADR-024).
                          setRequest(
                            await requestApproval(
                              ctx,
                              state.account,
                              state.account.device?.label ??
                                defaultDeviceLabel(navigator.userAgent)
                            )
                          );
                        })
                    : undefined
                }
              />
            ) : null
          }
          advanced={
            <StopProjectEncryption userId={userId} unlocked={unlocked} />
          }
        />
      )}
      {dialogs}
    </div>
  );
}

function RetryButton({ onClick }: { onClick(): void }) {
  return (
    <button className="secondary" type="button" onClick={onClick}>
      <RefreshCcw size={13} aria-hidden="true" />
      Retry
    </button>
  );
}

/** What a removal left for the other devices, in plain words. */
function removalNotice(outcome: RemovalOutcome): string | null {
  const left = outcome.left.filter((item) => item.projectId !== '*').length;
  if (outcome.left.length === 0) return null;
  if (left === 0)
    return 'The device was removed, but its encrypted projects could not be updated yet. Your other devices update each one before their next save.';
  return `The device was removed. ${left} encrypted ${left === 1 ? 'project gets' : 'projects get'} new keys the next time another of your devices saves ${left === 1 ? 'it' : 'them'}.`;
}

interface StatusLine {
  tone: 'good' | 'warning';
  icon: ReactNode;
  title: string;
  text: string;
  alert?: true;
}

/** Where this device stands, in one headline and one sentence (plan §4.6). */
export function statusLine(
  account: AccountView,
  identityChanged: boolean,
  encryptNew: boolean | null
): StatusLine {
  const label = account.device?.label ?? 'This device';
  const warning = (title: string, text: string, alert?: true): StatusLine => ({
    tone: 'warning',
    icon: <ShieldAlert size={18} />,
    title,
    text,
    alert
  });
  if (identityChanged)
    return warning(
      'Keys changed on another device',
      'Your keys were replaced on another device. Approve this one again from there, or use the new recovery key.',
      true
    );
  if (account.unlockError)
    return {
      ...warning(
        'Locked on this device',
        `This device could not unlock your keys: ${account.unlockError}`,
        true
      ),
      icon: <Lock size={18} />
    };
  switch (account.deviceStatus) {
    case 'certified':
      return encryptNew === false
        ? warning(
            'Keys ready · new projects aren’t encrypted',
            'Your keys are set up, but new cloud projects are still saved without encryption. Turn on Encrypt new projects below.'
          )
        : {
            tone: 'good',
            icon: <ShieldCheck size={18} />,
            title: 'Encryption is on',
            text: `${label} encrypts your cloud projects before they leave it, and can open the ones you already encrypted.`
          };
    case 'approved':
      return warning(
        'Finish setting up this device',
        'This device can open encrypted projects but can’t save them yet. Confirm with a passkey or your recovery key, or ask another device to approve it again.'
      );
    case 'pending':
      return warning(
        'Waiting for approval',
        'Approve this device from one that is already unlocked.'
      );
    case 'removed':
      return warning(
        'Removed from your account',
        'This device’s keys no longer open anything new.'
      );
    default:
      return {
        ...warning(
          'Locked on this device',
          'Unlock it to open and save encrypted projects here.'
        ),
        icon: <Lock size={18} />
      };
  }
}

function AccountPanel({
  userId,
  account,
  identityChanged,
  request,
  setRequest,
  onReload,
  openDialog,
  projects,
  contacts,
  advanced,
  ...shared
}: Shared & {
  userId: string;
  account: AccountView;
  identityChanged: boolean;
  request: NewDeviceApprovalStep | null;
  setRequest(step: NewDeviceApprovalStep | null): void;
  onReload(): Promise<boolean>;
  openDialog(dialog: Dialog): void;
  /** Invitations, existing projects, assistant access and pin recovery. */
  projects: ReactNode;
  /** The contacts list, once this device holds keys. */
  contacts: ReactNode;
  /** Rare, beta-only project tools, folded under Advanced. */
  advanced: ReactNode;
}) {
  const { ctx, busy, run } = shared;
  const thisDevice = account.device;
  const certified = account.deviceStatus === 'certified' && account.unlocked;
  const enrolled =
    account.deviceStatus === 'certified' || account.deviceStatus === 'approved';
  const passkeys = account.list.unlockTargets.filter(
    (t) => t.kind === 'passkey'
  );
  const canUsePasskey =
    passkeysAvailable() && !identityChanged && passkeys.length > 0;
  const [removalLeft, setRemovalLeft] = useState<string | null>(null);
  const [encryptNew, setEncryptNew] = useState<boolean | null>(null);
  const projectStep = () =>
    projectRemovalStep(ctx, (outcome) =>
      setRemovalLeft(removalNotice(outcome))
    );
  const authorize = (request: AuthorizeRequest) =>
    openDialog({ kind: 'authorize', request });
  const waiting =
    request !== null &&
    (request.step === 'waiting' || request.step === 'compare');
  const status: StatusLine =
    waiting && account.deviceStatus !== 'certified'
      ? {
          tone: 'warning',
          icon: <QrCode size={18} />,
          title: 'Waiting for approval',
          text: 'Approve this device from one that is already unlocked: scan its code, or compare the digits.'
        }
      : statusLine(account, identityChanged, encryptNew);
  const showUnlock =
    identityChanged ||
    !enrolled ||
    waiting ||
    account.deviceStatus === 'approved';
  const deviceCount =
    account.list.devices.length + account.approvedDevices.length;
  const label = thisDevice?.label ?? defaultDeviceLabel(navigator.userAgent);

  return (
    <>
      <Group>
        <Summary
          icon={status.icon}
          tone={status.tone}
          title={status.title}
          alert={status.alert}
          action={
            <>
              <DeviceStatusBadge
                account={account}
                identityChanged={identityChanged}
              />
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
            </>
          }
        >
          {status.text}
        </Summary>
        {removalLeft ? <Notice tone="warning">{removalLeft}</Notice> : null}
        {certified ? null : <PendingLinkNotice />}
      </Group>

      {showUnlock ? (
        <EnrollPanel
          {...shared}
          account={account}
          identityChanged={identityChanged}
          step={request}
          setStep={setRequest}
          passkey={canUsePasskey}
          onUnlock={(method) =>
            authorize({
              title:
                account.deviceStatus === 'approved'
                  ? 'Finish setting up this device'
                  : 'Unlock this device',
              body:
                method === 'passkey'
                  ? 'Your browser asks for the passkey you saved for OpenZCAD encryption.'
                  : 'Your recovery key unlocks this device on its own. It can’t check that the device list it receives is the newest one, so approval from another device is safer when you have one.',
              actionLabel: 'Unlock this device',
              passkey: method === 'passkey',
              recoveryKey: method === 'recovery',
              work: (authorization) =>
                authorization === 'passkey'
                  ? enrollWithPasskey(ctx, account, label)
                  : enrollWithRecoveryKey(ctx, account, authorization, label)
            })
          }
        />
      ) : null}

      {certified ? (
        <ApprovalRequests
          {...shared}
          account={account}
          passkey={canUsePasskey}
          onAuthorize={authorize}
        />
      ) : null}

      <Group
        title="Devices"
        note={`${deviceCount} ${deviceCount === 1 ? 'device' : 'devices'}`}
      >
        {[...account.list.devices]
          .sort(
            (a, b) =>
              Number(b.deviceId === thisDevice?.deviceId) -
              Number(a.deviceId === thisDevice?.deviceId)
          )
          .map((device) => (
            <SettingRow
              key={device.deviceId}
              title={device.label}
              hint={`Added ${formatDate(device.addedAt)}`}
            >
              {device.deviceId === thisDevice?.deviceId ? (
                <Status tone="good">This device</Status>
              ) : certified ? (
                // A locked device shows no Remove at all: a disabled one
                // beside the only certified device read as a threat (I83).
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${device.label}`}
                  onClick={() =>
                    authorize({
                      title: `Remove ${device.label}`,
                      body: 'It won’t open anything new. Your keys are replaced; your other devices keep working, and devices that aren’t finished setting up must be approved again.',
                      actionLabel: 'Remove device',
                      danger: true,
                      passkey: canUsePasskey,
                      work: (authorization) =>
                        removeDevice(
                          ctx,
                          account,
                          device.deviceId,
                          authorization,
                          projectStep()
                        )
                    })
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Remove
                </button>
              ) : null}
            </SettingRow>
          ))}
        {account.approvedDevices.map((device) => (
          <SettingRow
            key={device.deviceId}
            title={device.label}
            hint={`Approved ${formatDate(device.approvedAt)} · can open, can’t save`}
          >
            <Status tone="warning">
              {device.deviceId === thisDevice?.deviceId
                ? 'This device · not finished'
                : 'Not finished'}
            </Status>
          </SettingRow>
        ))}
        {certified ? (
          <SettingRow
            title="Add a device"
            hint="On the new device, sign in and open Settings › Encryption, then choose Ask for approval. Point this device’s camera (or your phone’s camera app) at the QR code it shows, or compare codes."
          />
        ) : null}
      </Group>

      {enrolled && !identityChanged ? (
        <Group title="Passkeys and recovery key">
          <SettingRow
            title="Passkeys"
            hint={
              !passkeysAvailable()
                ? 'Not available in this browser. Add one from a browser that supports passkeys.'
                : passkeys.length === 0
                  ? 'Unlock new devices and confirm changes with one touch, instead of typing the recovery key.'
                  : 'Unlock new devices and confirm changes with one touch.'
            }
          >
            <button
              className={passkeys.length === 0 ? 'primary' : 'secondary'}
              type="button"
              disabled={busy || !certified || !passkeysAvailable()}
              onClick={() =>
                authorize({
                  title: 'Add a passkey',
                  body:
                    passkeys.length > 0
                      ? 'Confirm with a passkey you already have or your recovery key. Your browser then asks where to save the new one.'
                      : 'Confirm with your recovery key. Your browser then asks where to save the passkey.',
                  actionLabel: 'Create passkey',
                  passkey: canUsePasskey,
                  work: (authorization) =>
                    addPasskey(ctx, account, authorization)
                })
              }
            >
              <Fingerprint size={14} aria-hidden="true" />
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
                  authorize({
                    title: 'Remove passkey',
                    body: 'Your keys are replaced so it opens nothing new. Delete it from your password manager separately.',
                    actionLabel: 'Remove passkey',
                    danger: true,
                    passkey: canUsePasskey,
                    work: (authorization) =>
                      removePasskey(
                        ctx,
                        account,
                        target.targetId,
                        authorization,
                        projectStep()
                      )
                  })
                }
              >
                Remove
              </button>
            </SettingRow>
          ))}
          <SettingRow
            title="Recovery key"
            hint={`Saved ${formatDate(account.createdAt)}. Opens your keys on any device.`}
          >
            {certified ? (
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => openDialog({ kind: 'replace' })}
              >
                <KeyRound size={14} aria-hidden="true" />
                Replace…
              </button>
            ) : (
              <Status tone="good">Confirmed</Status>
            )}
          </SettingRow>
        </Group>
      ) : null}

      <ProjectEncryptionPreference
        userId={userId}
        unlocked={account.unlocked && !identityChanged}
        onEncryptNewChange={setEncryptNew}
      />
      {projects}

      {/* Contacts sign with this device's keys; a locked one has none yet. */}
      {enrolled && !identityChanged ? contacts : null}

      <MoreGroups title="Advanced encryption settings">
        <Group title="Identity">
          <SettingRow
            title="Your fingerprint"
            hint="Changes only when you replace your keys. Compare it on your own devices if one says its device list did not verify. People verify you with your contact code instead."
          >
            <code className="encryption-code" aria-label="Your fingerprint">
              {account.fingerprint}
            </code>
          </SettingRow>
        </Group>
        {account.approvedDevices.length > 0 ? (
          <Group
            title="Read-only devices"
            note="From before approval certified"
          >
            <SettingRow
              title="Revoke read-only access"
              hint="Devices that aren’t finished setting up must ask to join again. Replaces your keys; your other devices keep working."
            >
              <button
                className="secondary"
                type="button"
                disabled={busy || !certified}
                onClick={() =>
                  authorize({
                    title: 'Revoke read-only devices',
                    body: 'All devices that aren’t finished setting up will need approval again. Your other devices keep working.',
                    actionLabel: 'Revoke read-only access',
                    danger: true,
                    passkey: canUsePasskey,
                    work: (authorization) =>
                      revokeReadOnlyDevices(
                        ctx,
                        account,
                        authorization,
                        projectStep()
                      )
                  })
                }
              >
                Revoke read-only devices
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
        {advanced}
        <PreviousKeySets previous={account.previous} />
      </MoreGroups>
    </>
  );
}

/** This device's state in a word or two, beside the status line. */
function DeviceStatusBadge({
  account,
  identityChanged
}: {
  account: AccountView;
  identityChanged: boolean;
}) {
  if (identityChanged) return <Status tone="warning">Keys changed</Status>;
  switch (account.deviceStatus) {
    case 'certified':
      return account.unlocked ? (
        <Status tone="good">Unlocked</Status>
      ) : (
        <Status tone="warning">Locked</Status>
      );
    case 'approved':
      return <Status tone="warning">Not finished</Status>;
    case 'pending':
      return <Status tone="warning">Waiting for approval</Status>;
    case 'removed':
      return <Status tone="warning">Removed</Status>;
    default:
      return <Status>Locked</Status>;
  }
}

/**
 * This device's way in: approval from another device (recommended, since it
 * hands over the newest verified device list), a passkey, or the recovery
 * key; and, while a request is open, the QR code and digits to show.
 */
function EnrollPanel({
  account,
  identityChanged = false,
  step,
  setStep,
  passkey,
  onUnlock,
  ...shared
}: Shared & {
  account: AccountView;
  identityChanged?: boolean;
  step: NewDeviceApprovalStep | null;
  setStep(step: NewDeviceApprovalStep | null): void;
  /** The account has a passkey this browser can use. */
  passkey: boolean;
  onUnlock(method: 'passkey' | 'recovery'): void;
}) {
  const { ctx, busy, run } = shared;
  const label =
    account.device?.label ?? defaultDeviceLabel(navigator.userAgent);
  const finishing = account.deviceStatus === 'approved';

  // Poll the approval request while this device waits.
  useEffect(() => {
    if (!step || step.step === 'done' || step.step === 'expired') return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void advanceApprovalAsNewDevice(ctx)
        .then((next) => {
          if (stopped) return;
          if (next.step === 'done') {
            setStep(null);
            void run(async () => next.state);
            // The grant may have confirmed this device's contacts list.
            notifyContactsChanged();
          } else {
            setStep(next);
          }
        })
        .catch((caught: unknown) => {
          if (stopped) return;
          if (
            caught instanceof EncryptionFlowError &&
            caught.code === 'grant-invalid'
          ) {
            window.clearInterval(timer);
          }
          void run(async () => {
            throw caught;
          });
        });
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [ctx, run, setStep, step]);

  const ask = () =>
    void run(async () => {
      setStep(await requestApproval(ctx, account, label));
    });

  if (step && (step.step === 'waiting' || step.step === 'compare')) {
    return (
      <Group title="Approve this device">
        {step.step === 'waiting' ? (
          <div className="encryption-waiting">
            <ScanCodeDisplay code={step.scanCode} />
            <ol className="encryption-steps">
              <li>
                <strong>With a phone:</strong> point its camera at this code and
                open the link. Approve there.
              </li>
              <li>
                <strong>With another computer:</strong> open Settings ›
                Encryption there. This device appears under Requests to join:
                choose Scan code, or Compare codes.
              </li>
            </ol>
          </div>
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
                      const next = await confirmApprovalCode(
                        ctx,
                        step.approval
                      );
                      if (next.step === 'done') {
                        setStep(null);
                        notifyContactsChanged();
                        return next.state;
                      }
                      setStep(next);
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
                setStep(null);
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
  // A certified device here is only asking another to confirm its contacts.
  if (account.deviceStatus === 'certified' && !identityChanged) return null;
  return (
    <Group
      title={finishing ? 'Finish setting up this device' : 'Unlock this device'}
    >
      {step?.step === 'expired' ? (
        <Notice tone="warning" role="status">
          That approval request expired. Ask again.
        </Notice>
      ) : null}
      {account.device?.approval ? (
        <SettingRow
          title="Continue your approval request"
          hint="Pick up where this device left off."
        >
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = await advanceApprovalAsNewDevice(ctx);
                if (next.step === 'done') {
                  setStep(null);
                  notifyContactsChanged();
                  return next.state;
                }
                setStep(next);
              })
            }
          >
            Resume approval
          </button>
        </SettingRow>
      ) : null}
      <SettingRow
        title="Approve from another device"
        hint="Recommended. Shows a QR code your phone’s camera can open, or six digits to compare."
      >
        <button className="primary" type="button" disabled={busy} onClick={ask}>
          <QrCode size={14} aria-hidden="true" />
          Ask for approval
        </button>
      </SettingRow>
      {passkey ? (
        <SettingRow
          title="Use your passkey"
          hint="One touch, if your passkey is saved where this browser can reach it."
        >
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={() => onUnlock('passkey')}
          >
            <Fingerprint size={14} aria-hidden="true" />
            Use passkey
          </button>
        </SettingRow>
      ) : null}
      <SettingRow
        title="Use your recovery key"
        hint="Works on its own, when no other device is at hand."
      >
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => onUnlock('recovery')}
        >
          <KeyRound size={14} aria-hidden="true" />
          Enter recovery key
        </button>
      </SettingRow>
    </Group>
  );
}

export { EnrollPanel };

function PreviousKeySets({ previous }: { previous: AccountView['previous'] }) {
  if (previous.length === 0) return null;
  return (
    <Group title="Devices from replaced keys" note="Approve again to trust">
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
