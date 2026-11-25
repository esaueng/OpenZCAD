import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvitationPassResult } from '../lib/e2ee/invitationRunner';

/**
 * "Shared with you" (L11 plan of 2026-11-25, §3.2): what an encrypted
 * invitation link opens. Without keys it turns encryption on through the
 * setup dialog and comes back; unlocked, it accepts the link by itself
 * (the library's `acceptEncryptedInvitation`), waits for the owner's
 * device, and opens the project once the app's runner joined it.
 */

const loadEncryption = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const acceptEncryptedInvitation =
  vi.fn<(...args: unknown[]) => Promise<unknown>>();
const syncInvitationsNow = vi.fn<() => Promise<InvitationPassResult | null>>();
const clearPendingEncryptedInvitation = vi.fn<() => void>();
const requestContactVerification = vi.fn<(userId: string) => void>();
let passListener: ((result: InvitationPassResult) => void) | null = null;

vi.mock('../lib/e2ee/accountKeys', () => ({
  loadEncryption: (...args: unknown[]) => loadEncryption(...args)
}));
vi.mock('../lib/e2ee/e2eeApi', () => ({ createE2eeApi: () => ({}) }));
vi.mock('../lib/e2ee/keychainDeviceKeys', () => ({
  deviceKeyStore: () => ({}),
  deviceKeyFactory: () => undefined
}));
vi.mock('../lib/e2ee/encryptedProjects', () => ({
  encryptedInvitations: async () => ({
    people: {
      inspect: async () => ({ email: 'alice@example.com' })
    }
  })
}));
vi.mock('../lib/e2ee/invitations', () => ({
  acceptEncryptedInvitation: (...args: unknown[]) =>
    acceptEncryptedInvitation(...args)
}));
vi.mock('../lib/e2ee/encryptedInvitationLink', () => ({
  clearPendingEncryptedInvitation: () => clearPendingEncryptedInvitation()
}));
vi.mock('../lib/e2ee/invitationRunner', () => ({
  syncInvitationsNow: () => syncInvitationsNow(),
  subscribeInvitationPasses: (
    listener: (result: InvitationPassResult) => void
  ) => {
    passListener = listener;
    return () => {
      if (passListener === listener) passListener = null;
    };
  }
}));
vi.mock('../lib/e2ee/contactFocus', () => ({
  requestContactVerification: (userId: string) =>
    requestContactVerification(userId)
}));
vi.mock('./encryption/SetupDialog', () => ({
  SetupDialog: ({ onClose }: { onClose(): void }) => (
    <div role="dialog" aria-label="Set up encryption">
      <button type="button" onClick={onClose}>
        Finish setup
      </button>
    </div>
  )
}));

const { SharedWithYouDialog } = await import('./SharedWithYouDialog');

const TOKEN = 'a'.repeat(43);
const invitation = {
  invitationId: 'inv_1',
  projectId: 'proj_1',
  inviterUserId: 'user_alice',
  completedAt: null
};
const ready = { kind: 'ready', account: { unlocked: true } };

function pass(overrides: Partial<InvitationPassResult> = {}) {
  return {
    incoming: [],
    outgoing: [],
    joined: [],
    completed: [],
    failed: [],
    renewed: [],
    errors: [],
    ...overrides
  } satisfies InvitationPassResult;
}

function landing(
  overrides: Partial<Parameters<typeof SharedWithYouDialog>[0]> = {}
) {
  const props = {
    token: TOKEN,
    userId: 'user_bob' as string | null,
    shown: true,
    onSignIn: vi.fn(),
    onOpenEncryptionSettings: vi.fn(),
    onOpenProject: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  };
  return { props, ...render(<SharedWithYouDialog {...props} />) };
}

beforeEach(() => {
  loadEncryption.mockReset();
  acceptEncryptedInvitation.mockReset();
  syncInvitationsNow.mockReset();
  syncInvitationsNow.mockResolvedValue(pass());
  clearPendingEncryptedInvitation.mockReset();
  requestContactVerification.mockReset();
  passListener = null;
});

describe('SharedWithYouDialog', () => {
  it('turns encryption on, accepts the link by itself and opens the project once joined', async () => {
    loadEncryption.mockResolvedValue({ kind: 'not-set-up' });
    acceptEncryptedInvitation.mockResolvedValue({ invitation, linked: true });
    const { props } = landing();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Turn on encryption to open it'
      })
    );
    // Nothing is accepted before this device holds keys.
    expect(acceptEncryptedInvitation).not.toHaveBeenCalled();
    loadEncryption.mockResolvedValue(ready);
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(
      await screen.findByText(/device to add you…/, {}, { timeout: 2000 })
    ).toBeTruthy();
    // The opened link is the intent: the library's accept, with its token.
    expect(acceptEncryptedInvitation).toHaveBeenCalledOnce();
    expect(acceptEncryptedInvitation.mock.calls[0]![1]).toBe(TOKEN);
    expect(clearPendingEncryptedInvitation).toHaveBeenCalled();
    expect(syncInvitationsNow).toHaveBeenCalled();
    expect(props.onOpenProject).not.toHaveBeenCalled();
    // The runner's next pass joined it: the project opens.
    await waitFor(() => expect(passListener).not.toBeNull());
    act(() => passListener!(pass({ joined: ['proj_1'] })));
    expect(props.onOpenProject).toHaveBeenCalledWith('proj_1');
  });

  it('asks a signed-out visitor to sign in', async () => {
    const { props } = landing({ userId: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(props.onSignIn).toHaveBeenCalled();
    expect(loadEncryption).not.toHaveBeenCalled();
    expect(acceptEncryptedInvitation).not.toHaveBeenCalled();
  });

  it('sends a locked device to unlock first, and accepts nothing meanwhile', async () => {
    loadEncryption.mockResolvedValue({
      kind: 'ready',
      account: { unlocked: false }
    });
    const { props } = landing();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Unlock encryption' })
    );
    expect(props.onOpenEncryptionSettings).toHaveBeenCalled();
    expect(acceptEncryptedInvitation).not.toHaveBeenCalled();
  });

  it('says what the owner verification still waits for, and leads there', async () => {
    loadEncryption.mockResolvedValue(ready);
    acceptEncryptedInvitation.mockResolvedValue({ invitation, linked: true });
    syncInvitationsNow.mockResolvedValue(
      pass({
        incoming: [
          {
            record: invitation,
            state: 'verify-owner'
          } as unknown as InvitationPassResult['incoming'][number]
        ]
      })
    );
    const { props } = landing();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Compare codes' })
    );
    expect(requestContactVerification).toHaveBeenCalledWith('user_alice');
    expect(props.onOpenEncryptionSettings).toHaveBeenCalled();
  });

  it('opens a project the account was added to before at once', async () => {
    loadEncryption.mockResolvedValue(ready);
    acceptEncryptedInvitation.mockResolvedValue({
      invitation: { ...invitation, completedAt: '2026-11-20T00:00:00Z' },
      linked: true
    });
    const { props } = landing();
    await waitFor(() =>
      expect(props.onOpenProject).toHaveBeenCalledWith('proj_1')
    );
  });

  it('says when the invitation is gone, and can try again', async () => {
    loadEncryption.mockResolvedValue(ready);
    acceptEncryptedInvitation.mockRejectedValue(
      Object.assign(new Error('Project invitation is invalid or expired.'), {
        status: 404
      })
    );
    landing();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /no longer valid/
    );
    expect(acceptEncryptedInvitation).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(acceptEncryptedInvitation).toHaveBeenCalledTimes(2)
    );
  });

  it('keeps its place while Settings covers it', async () => {
    loadEncryption.mockResolvedValue(ready);
    acceptEncryptedInvitation.mockResolvedValue({ invitation, linked: true });
    const { props, rerender } = landing();
    await screen.findByText(/device to add you…/);
    rerender(<SharedWithYouDialog {...props} shown={false} />);
    expect(screen.queryByText(/device to add you…/)).toBeNull();
    rerender(<SharedWithYouDialog {...props} shown />);
    expect(screen.getByText(/device to add you…/)).toBeTruthy();
    expect(acceptEncryptedInvitation).toHaveBeenCalledOnce();
  });
});
