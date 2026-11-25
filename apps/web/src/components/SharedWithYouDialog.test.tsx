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
const pendingEncryptedInvitation = vi.fn<() => string | null>();
/** The invitation route's accept, as the landing asks it again. */
const acceptRoute = vi.fn<(request: { token: string }) => Promise<unknown>>();
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
    api: { accept: (request: { token: string }) => acceptRoute(request) },
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
  clearPendingEncryptedInvitation: () => clearPendingEncryptedInvitation(),
  pendingEncryptedInvitation: () => pendingEncryptedInvitation()
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
  completedAt: null,
  revokedAt: null,
  expiresAt: Date.now() + 86_400_000
};
/** The runner still lists the invitation, waiting for the owner. */
const listed = (state = 'waiting-for-owner') =>
  pass({
    incoming: [
      {
        record: invitation,
        state
      } as unknown as InvitationPassResult['incoming'][number]
    ]
  });
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
  syncInvitationsNow.mockResolvedValue(listed());
  clearPendingEncryptedInvitation.mockReset();
  pendingEncryptedInvitation.mockReset();
  pendingEncryptedInvitation.mockReturnValue(TOKEN);
  acceptRoute.mockReset();
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

  it('opens a project another tab joined, which the runner no longer lists', async () => {
    loadEncryption.mockResolvedValue(ready);
    acceptEncryptedInvitation.mockResolvedValue({ invitation, linked: true });
    const { props } = landing();
    await screen.findByText(/device to add you…/);
    // The other tab took the Welcome: no join here, and no open invitation.
    acceptRoute.mockResolvedValue({
      invitation: { ...invitation, completedAt: '2026-11-25T10:00:00Z' }
    });
    await waitFor(() => expect(passListener).not.toBeNull());
    act(() => passListener!(pass()));
    await waitFor(() =>
      expect(props.onOpenProject).toHaveBeenCalledWith('proj_1')
    );
    expect(acceptRoute).toHaveBeenCalledWith({ token: TOKEN });
  });

  it('says an accepted invitation expired instead of waiting on it', async () => {
    loadEncryption.mockResolvedValue(ready);
    acceptEncryptedInvitation.mockResolvedValue({ invitation, linked: true });
    const { props } = landing();
    await screen.findByText(/device to add you…/);
    acceptRoute.mockResolvedValue({
      invitation: { ...invitation, expiresAt: Date.now() - 1000 }
    });
    await waitFor(() => expect(passListener).not.toBeNull());
    act(() => passListener!(pass()));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /This invitation expired\. Ask .* to invite you again\./
    );
    expect(screen.queryByText(/device to add you…/)).toBeNull();
    expect(props.onOpenProject).not.toHaveBeenCalled();
  });

  it('says so at once when the link it accepts again has expired', async () => {
    loadEncryption.mockResolvedValue(ready);
    acceptEncryptedInvitation.mockResolvedValue({
      invitation: { ...invitation, expiresAt: Date.now() - 1000 },
      linked: true
    });
    landing();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /This invitation expired/
    );
  });

  it('starts over for a second link, and the first one opens nothing', async () => {
    loadEncryption.mockResolvedValue(ready);
    let finishFirst: (value: unknown) => void = () => undefined;
    acceptEncryptedInvitation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        })
    );
    const second = 'b'.repeat(43);
    acceptEncryptedInvitation.mockResolvedValueOnce({
      invitation: { ...invitation, invitationId: 'inv_2', projectId: 'proj_2' },
      linked: true
    });
    const onOpenProject = vi.fn();
    const props = {
      userId: 'user_bob',
      shown: true,
      onSignIn: vi.fn(),
      onOpenEncryptionSettings: vi.fn(),
      onOpenProject,
      onClose: vi.fn()
    };
    // The app keys the landing on its link (`App.tsx`).
    const { rerender } = render(
      <SharedWithYouDialog key={TOKEN} token={TOKEN} {...props} />
    );
    await waitFor(() =>
      expect(acceptEncryptedInvitation).toHaveBeenCalledOnce()
    );
    // The second link arrives while the first is still being accepted.
    pendingEncryptedInvitation.mockReturnValue(second);
    rerender(<SharedWithYouDialog key={second} token={second} {...props} />);
    await waitFor(() =>
      expect(acceptEncryptedInvitation).toHaveBeenCalledTimes(2)
    );
    expect(acceptEncryptedInvitation.mock.calls[1]![1]).toBe(second);
    // The first finishes late, already completed: it neither opens its
    // project nor clears the second link's stored token.
    clearPendingEncryptedInvitation.mockClear();
    finishFirst({
      invitation: { ...invitation, completedAt: '2026-11-25T10:00:00Z' },
      linked: true
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onOpenProject).not.toHaveBeenCalledWith('proj_1');
    expect(clearPendingEncryptedInvitation).not.toHaveBeenCalled();
    expect(await screen.findByText(/device to add you…/)).toBeTruthy();
  });

  it('leaves a stored token of another link alone', async () => {
    loadEncryption.mockResolvedValue(ready);
    acceptEncryptedInvitation.mockResolvedValue({ invitation, linked: true });
    pendingEncryptedInvitation.mockReturnValue('c'.repeat(43));
    landing();
    await screen.findByText(/device to add you…/);
    expect(clearPendingEncryptedInvitation).not.toHaveBeenCalled();
  });

  it('ends the wait at the expiry it knows of, even with no pass at all', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      loadEncryption.mockResolvedValue(ready);
      const expiresAt = Date.now() + 15_000;
      acceptEncryptedInvitation.mockResolvedValue({
        invitation: { ...invitation, expiresAt },
        linked: true
      });
      // The runner cannot run here (no unlocked keys it accepts, say).
      syncInvitationsNow.mockResolvedValue(null);
      landing();
      await screen.findByText(/device to add you…/);
      vi.setSystemTime(expiresAt + 1);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect((await screen.findByRole('alert')).textContent).toMatch(
        /This invitation expired/
      );
      expect(acceptRoute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
