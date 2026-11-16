import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { E2eeApprovalRecord } from '@openzcad/shared';
import type * as KeysModule from '../../lib/e2ee/accountKeys';
import type { AccountView, E2eeContext } from '../../lib/e2ee/accountKeys';
import {
  captureDeviceApprovalLink,
  clearPendingDeviceApproval,
  pendingDeviceApproval
} from '../../lib/e2ee/deviceApprovalLink';
import { testRun } from '../../test/encryptionRun';
import type { AuthorizeRequest } from './AuthorizeDialog';

const keys = vi.hoisted(() => ({
  approvalMatchesScanCode: vi.fn(),
  approvalIsReconfirmation: vi.fn(),
  approveDevice: vi.fn()
}));
vi.mock('../../lib/e2ee/accountKeys', async (original) => ({
  ...(await original<typeof KeysModule>()),
  ...keys
}));
const { ApprovalRequests } = await import('./ApprovalRequests');

const CODE = '0123456789ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGHJK';
const approval = {
  id: 'apr_phone',
  label: 'Safari on iPhone',
  createdAt: Date.now(),
  state: 'requested',
  commitment: 'c',
  signingKey: 's',
  unlockKey: 'u'
} as unknown as E2eeApprovalRecord;
const account = { userId: 'user_alice' } as AccountView;

afterEach(() => {
  clearPendingDeviceApproval();
  vi.clearAllMocks();
});

function show() {
  const onAuthorize = vi.fn<(request: AuthorizeRequest) => void>();
  const ctx = {
    userId: 'user_alice',
    api: { listApprovals: vi.fn(async () => ({ approvals: [approval] })) }
  } as unknown as E2eeContext;
  render(
    <ApprovalRequests
      ctx={ctx}
      busy={false}
      run={testRun()}
      account={account}
      passkey
      onAuthorize={onAuthorize}
    />
  );
  return { onAuthorize, ctx };
}

describe('requests to join, opened from a scanned approval link', () => {
  it('offers to approve the device whose code the camera opened, with a passkey', async () => {
    captureDeviceApprovalLink(
      { hash: `#approve-device=${CODE}`, pathname: '/', search: '' },
      { replaceState: () => {}, state: null }
    );
    keys.approvalMatchesScanCode.mockResolvedValue(true);
    keys.approvalIsReconfirmation.mockReturnValue(false);
    keys.approveDevice.mockResolvedValue(undefined);
    const { onAuthorize, ctx } = show();
    expect(
      await screen.findByText(/You scanned this device’s code/)
    ).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onAuthorize).toHaveBeenCalledOnce());
    const request = onAuthorize.mock.calls[0]![0];
    expect(request).toMatchObject({
      title: 'Approve “Safari on iPhone”',
      passkey: true
    });
    await request.work('passkey');
    expect(keys.approveDevice).toHaveBeenCalledWith(
      ctx,
      account,
      approval,
      { kind: 'scan', code: CODE },
      'passkey'
    );
    // The link is used up once the device is approved.
    expect(pendingDeviceApproval()).toBeNull();
  });

  it('refuses a code that names no listed request before any prompt', async () => {
    keys.approvalMatchesScanCode.mockResolvedValue(false);
    const { onAuthorize } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Scan code' }));
    fireEvent.change(screen.getByLabelText('Code from the new device'), {
      target: { value: `OZD1:${CODE}` }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve device' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That code does not match the device asking for approval'
    );
    expect(onAuthorize).not.toHaveBeenCalled();
    expect(keys.approveDevice).not.toHaveBeenCalled();
  });

  it('approves a contacts reconfirmation without asking for a key', async () => {
    keys.approvalMatchesScanCode.mockResolvedValue(true);
    keys.approvalIsReconfirmation.mockReturnValue(true);
    keys.approveDevice.mockResolvedValue(undefined);
    const { onAuthorize } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Scan code' }));
    fireEvent.change(screen.getByLabelText('Code from the new device'), {
      target: { value: CODE }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve device' }));
    await waitFor(() => expect(keys.approveDevice).toHaveBeenCalledOnce());
    expect(keys.approveDevice.mock.calls[0]![4]).toBeNull();
    expect(onAuthorize).not.toHaveBeenCalled();
  });
});
