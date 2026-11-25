import { useState } from 'react';
import { QrCode, Trash2 } from 'lucide-react';
import type { AccountView } from '../../lib/e2ee/accountKeys';
import { Group, Notice, SettingRow, Status } from '../settingsControls';
import { ApprovalRequests } from './ApprovalRequests';
import type { AuthorizeRequest } from './AuthorizeDialog';
import {
  DEVICES_SHOWN,
  STALE_AFTER_DAYS,
  lastUsedDays,
  orderDevices,
  staleDeviceIds,
  usedText
} from './deviceActivity';
import { EncryptionDialog } from './EncryptionDialog';
import { formatDate, type Shared } from './flow';

type Device = AccountView['list']['devices'][number];

/**
 * Settings › Encryption › Devices (L11 plan §6): this device first, then
 * the most recently used, three at a time with "Show all"; an offer to
 * remove every device nobody has used for a month at once; and "Add a
 * device", whose steps open in a dialog.
 */
export function DevicesGroup({
  account,
  certified,
  busy,
  onAddDevice,
  onRemove,
  onRemoveStale,
  now = Date.now()
}: {
  account: AccountView;
  /** This device is certified and unlocked: it can add and remove. */
  certified: boolean;
  busy: boolean;
  onAddDevice(): void;
  onRemove(device: Device): void;
  onRemoveStale(devices: Device[]): void;
  now?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const self = account.device?.deviceId;
  const days = lastUsedDays(account);
  const listed = orderDevices(account, days);
  const approvedSelf = account.approvedDevices.filter(
    (device) => device.deviceId === self
  );
  const approvedOthers = account.approvedDevices.filter(
    (device) => device.deviceId !== self
  );
  const rows = [
    ...approvedSelf.map((device) => ({ kind: 'approved' as const, device })),
    ...listed.map((device) => ({ kind: 'listed' as const, device })),
    ...approvedOthers.map((device) => ({ kind: 'approved' as const, device }))
  ];
  const shown = showAll ? rows : rows.slice(0, DEVICES_SHOWN);
  const staleIds = certified ? new Set(staleDeviceIds(account, now)) : null;
  const stale = staleIds
    ? account.list.devices.filter((device) => staleIds.has(device.deviceId))
    : [];
  const count = rows.length;

  return (
    <Group
      title="Devices"
      note={`${count} ${count === 1 ? 'device' : 'devices'}`}
      action={
        certified ? (
          <button
            className="secondary"
            type="button"
            disabled={busy}
            onClick={onAddDevice}
          >
            <QrCode size={14} aria-hidden="true" />
            Add a device
          </button>
        ) : undefined
      }
    >
      {shown.map((row) =>
        row.kind === 'approved' ? (
          <SettingRow
            key={row.device.deviceId}
            title={row.device.label}
            hint={`Approved ${formatDate(row.device.approvedAt)} · can open, can’t save`}
          >
            <Status tone="warning">
              {row.device.deviceId === self
                ? 'This device · not finished'
                : 'Not finished'}
            </Status>
          </SettingRow>
        ) : (
          <SettingRow
            key={row.device.deviceId}
            title={row.device.label}
            hint={deviceHint(
              row.device.deviceId === self
                ? 'In use now'
                : usedText(days.get(row.device.deviceId), now),
              row.device.addedAt
            )}
          >
            {row.device.deviceId === self ? (
              <Status tone="good">This device</Status>
            ) : certified ? (
              // A locked device shows no Remove at all: a disabled one
              // beside the only certified device read as a threat (I83).
              <button
                className="secondary"
                type="button"
                disabled={busy}
                aria-label={`Remove ${row.device.label}`}
                onClick={() => onRemove(row.device)}
              >
                <Trash2 size={14} aria-hidden="true" />
                Remove
              </button>
            ) : null}
          </SettingRow>
        )
      )}
      {count > DEVICES_SHOWN ? (
        <div className="encryption-show-all">
          <button
            className="encryption-link-button"
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? 'Show fewer' : `Show all ${count}`}
          </button>
        </div>
      ) : null}
      {stale.length > 0 ? (
        <Notice
          tone="warning"
          role="status"
          action={
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => onRemoveStale(stale)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Remove them
            </button>
          }
        >
          {stale.length === 1
            ? `1 device hasn’t been used in ${STALE_AFTER_DAYS} days.`
            : `${stale.length} devices haven’t been used in ${STALE_AFTER_DAYS} days.`}
        </Notice>
      ) : null}
    </Group>
  );
}

/** "Used 5 days ago · added Oct 3", or "Added Oct 3" without a day. */
function deviceHint(used: string | null, addedAt: number): string {
  const added = formatDate(addedAt);
  return used ? `${used} · added ${added}` : `Added ${added}`;
}

/**
 * "Add a device": the steps on the new device, then its request to join,
 * which this dialog lists as it arrives with Scan code and Compare codes.
 * Approving opens the authorize dialog in its place.
 */
export function AddDeviceDialog({
  account,
  passkey,
  onAuthorize,
  onClose,
  ...shared
}: Shared & {
  account: AccountView;
  passkey: boolean;
  onAuthorize(request: AuthorizeRequest): void;
  onClose(): void;
}) {
  return (
    <EncryptionDialog
      title="Add a device"
      busy={shared.busy}
      onClose={onClose}
      footer={
        <button
          className="secondary"
          type="button"
          disabled={shared.busy}
          onClick={onClose}
        >
          Close
        </button>
      }
    >
      <ol className="encryption-steps">
        <li>
          On the new device, sign in and open Settings › Encryption, then choose{' '}
          <strong>Ask for approval</strong>.
        </li>
        <li>
          Point this device’s camera (or your phone’s camera app) at the QR code
          it shows, or compare codes. Its request appears below.
        </li>
      </ol>
      <ApprovalRequests
        {...shared}
        account={account}
        passkey={passkey}
        onAuthorize={onAuthorize}
        whenEmpty={
          <p className="encryption-add-device-wait" role="status">
            Waiting for the new device to ask…
          </p>
        }
      />
    </EncryptionDialog>
  );
}
