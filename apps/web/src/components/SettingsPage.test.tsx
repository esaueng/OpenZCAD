import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultAppSettings,
  loadLocalAppSettings,
  saveLocalAppSettings
} from '../lib/appSettings';
import {
  KERNEL_BUILD,
  kernelBuildDetail,
  kernelBuildLabel
} from '../lib/kernelBuild';
import {
  toUserId,
  type AppSettings,
  type AppSettingsResponse,
  type HealthResponse
} from '@openzcad/shared';
import { openExternalUrl } from '../lib/desktopBridge';
import type * as DesktopBridge from '../lib/desktopBridge';
import { SettingsPage } from './SettingsPage';
import { POINTER_CONTROL_GROUPS } from '../lib/controlReference';
import { api } from '../lib/api';
import { modalHoldsKeyboard, useModalFocus } from '../lib/useModalFocus';
import { updateSettingsViewState } from '../lib/settingsViewState';
import { loadAssistantStatus } from '../lib/assistantStream';

vi.mock('../lib/assistantStream', () => ({
  loadAssistantStatus: vi.fn()
}));

// The desktop app opens external links through native code.
vi.mock('../lib/desktopBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof DesktopBridge>()),
  openExternalUrl: vi.fn()
}));

// Account loads storage usage for a signed-in profile; no test reaches a server.
const storageUsage = {
  projectCount: 3,
  documentBytes: 2_048,
  revisionBytes: 1_024,
  revisionCount: 4,
  projectStorageBytes: 3_072,
  documentLimitBytes: 10 * 1_048_576,
  maxRevisionsPerProject: 20,
  artifactBytes: 5 * 1_048_576,
  artifactCount: 2,
  artifactLimitBytes: 100 * 1_048_576,
  trashedProjectCount: 0,
  storageBytes: 3_072 + 5 * 1_048_576,
  storageLimitBytes: 100 * 1_048_576
};

beforeEach(() => {
  vi.spyOn(api, 'storageUsage').mockResolvedValue(storageUsage);
  vi.mocked(loadAssistantStatus).mockImplementation(
    () => new Promise(() => {})
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderSettings(
  health: HealthResponse | null = null,
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {}
) {
  return render(settingsElement(health, overrides));
}

function settingsElement(
  health: HealthResponse | null = null,
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {}
) {
  return (
    <SettingsPage
      settings={defaultAppSettings()}
      cloudFunctionsEnabled={true}
      accountState={null}
      authConfig={null}
      authConfigStatus="unavailable"
      health={health}
      session={null}
      busy={false}
      message=""
      onChange={vi.fn()}
      onCloudFunctionsEnabledChange={vi.fn()}
      onSaveCredential={vi.fn()}
      onDeleteCredential={vi.fn()}
      onTestAssistant={vi.fn()}
      onRequestLoginCode={vi.fn()}
      onVerifyLoginCode={vi.fn()}
      onRefreshAuthConfig={vi.fn()}
      onStartDesktopLogin={vi.fn()}
      onDesktopAuthorizationCodeChange={vi.fn()}
      onApproveDesktopLogin={vi.fn()}
      onLogout={vi.fn()}
      onDeleteCloudData={vi.fn()}
      onReset={vi.fn()}
      onApplyViewportDefaults={vi.fn()}
      onExportDiagnostics={vi.fn()}
      onExportInteractionLog={vi.fn()}
      onDismissProjectInvitation={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />
  );
}

describe('device-key sign-out choice', () => {
  const session = {
    userId: toUserId('user_sign_out_keys'),
    displayName: 'person',
    mode: 'email-code' as const
  };

  it('reports an unreadable key store without signing out and permits retry', async () => {
    const store = await import('../lib/e2ee/deviceStore');
    vi.spyOn(store, 'hasStoredDevice')
      .mockRejectedValueOnce(new Error('IndexedDB unavailable'))
      .mockResolvedValue(true);
    const onLogout = vi.fn();
    const user = userEvent.setup();
    renderSettings(null, { initialSection: 'account', session, onLogout });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not check/i
    );
    expect(onLogout).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('button', { name: 'Remove device keys' })
    ).toBeEnabled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('keeps a failed removal visible and retries the explicit choice before logout', async () => {
    const store = await import('../lib/e2ee/deviceStore');
    vi.spyOn(store, 'hasStoredDevice').mockResolvedValue(true);
    let signedOut = false;
    const remove = vi
      .fn()
      .mockRejectedValueOnce(new Error('Deletion aborted'))
      .mockResolvedValue(undefined);
    const onLogout = vi.fn(
      async (choice?: { userId: string; keepDevice?: boolean }) => {
        if (choice?.keepDevice === false) await remove();
        signedOut = true;
      }
    );
    const user = userEvent.setup();
    renderSettings(null, { initialSection: 'account', session, onLogout });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(
      await screen.findByRole('button', { name: 'Remove device keys' })
    );
    expect(
      await screen.findByText(/could not complete sign-out/i)
    ).toBeVisible();
    expect(signedOut).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Remove device keys' })
    ).toBeEnabled();
    await user.click(
      screen.getByRole('button', { name: 'Remove device keys' })
    );
    await waitFor(() => expect(signedOut).toBe(true));
    expect(remove).toHaveBeenCalledTimes(2);
    expect(onLogout.mock.calls).toEqual([
      [{ userId: session.userId, keepDevice: false }],
      [{ userId: session.userId, keepDevice: false }]
    ]);
    expect(
      screen.queryByRole('button', { name: 'Remove device keys' })
    ).toBeNull();
  });

  it('withdraws the prompt when another account replaces the one that opened it', async () => {
    const store = await import('../lib/e2ee/deviceStore');
    vi.spyOn(store, 'hasStoredDevice').mockResolvedValue(true);
    const onLogout = vi.fn();
    const other = { ...session, userId: toUserId('user_sign_out_other') };
    const user = userEvent.setup();
    const view = renderSettings(null, {
      initialSection: 'account',
      session,
      onLogout
    });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('button', { name: 'Remove device keys' })
    ).toBeEnabled();
    const rerender = (current: typeof session) =>
      view.rerender(
        settingsElement(null, {
          initialSection: 'account',
          session: current,
          onLogout
        })
      );
    rerender(other);
    expect(
      screen.queryByRole('button', { name: 'Remove device keys' })
    ).toBeNull();
    // The prompt does not come back for the account that opened it either.
    rerender(session);
    expect(
      screen.queryByRole('button', { name: 'Remove device keys' })
    ).toBeNull();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'does not sign out a replacement account after a pending device lookup returns %s',
    async (hasDevice) => {
      const store = await import('../lib/e2ee/deviceStore');
      let finish!: (value: boolean) => void;
      const lookup = vi.spyOn(store, 'hasStoredDevice').mockReturnValue(
        new Promise<boolean>((resolve) => {
          finish = resolve;
        })
      );
      const onLogout = vi.fn();
      const user = userEvent.setup();
      const view = renderSettings(null, {
        initialSection: 'account',
        session,
        onLogout
      });
      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      await waitFor(() => expect(lookup).toHaveBeenCalledWith(session.userId));
      view.rerender(
        settingsElement(null, {
          initialSection: 'account',
          session: {
            ...session,
            userId: toUserId('user_sign_out_replacement')
          },
          onLogout
        })
      );
      finish(hasDevice);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled()
      );
      expect(onLogout).not.toHaveBeenCalled();
      expect(
        screen.queryByRole('button', { name: 'Remove device keys' })
      ).toBeNull();
    }
  );

  it('binds direct sign-out without device keys to the inspected account', async () => {
    const store = await import('../lib/e2ee/deviceStore');
    vi.spyOn(store, 'hasStoredDevice').mockResolvedValue(false);
    const onLogout = vi.fn();
    renderSettings(null, { initialSection: 'account', session, onLogout });
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() =>
      expect(onLogout).toHaveBeenCalledExactlyOnceWith({
        userId: session.userId
      })
    );
  });

  it.each([true, false])(
    'disables repeated actions while the %s device-key choice completes',
    async (keepDevice) => {
      const store = await import('../lib/e2ee/deviceStore');
      vi.spyOn(store, 'hasStoredDevice').mockResolvedValue(true);
      let finish!: () => void;
      const onLogout = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      const user = userEvent.setup();
      renderSettings(null, { initialSection: 'account', session, onLogout });
      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      await user.click(
        await screen.findByRole('button', {
          name: keepDevice ? 'Keep unlocked' : 'Remove device keys'
        })
      );
      expect(onLogout).toHaveBeenCalledExactlyOnceWith({
        userId: session.userId,
        keepDevice
      });
      for (const name of [
        'Sign out',
        'Keep unlocked',
        'Remove device keys',
        'Cancel'
      ])
        expect(screen.getByRole('button', { name })).toBeDisabled();
      finish();
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Remove device keys' })
        ).toBeNull()
      );
    }
  );
});

/**
 * Settings wired the way App wires it: every change comes back as the new
 * `settings`, so a field sees its own commits as it would in the app.
 */
function renderStatefulSettings(
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {}
) {
  const commits: AppSettings[] = [];
  function Harness() {
    const [settings, setSettings] = useState(defaultAppSettings);
    return (
      <SettingsPage
        settings={settings}
        cloudFunctionsEnabled={true}
        accountState={null}
        authConfig={null}
        authConfigStatus="unavailable"
        health={null}
        session={null}
        busy={false}
        message=""
        onChange={(next) => {
          commits.push(next);
          setSettings(next);
        }}
        onCloudFunctionsEnabledChange={vi.fn()}
        onSaveCredential={vi.fn()}
        onDeleteCredential={vi.fn()}
        onTestAssistant={vi.fn()}
        onRequestLoginCode={vi.fn()}
        onVerifyLoginCode={vi.fn()}
        onRefreshAuthConfig={vi.fn()}
        onStartDesktopLogin={vi.fn()}
        onDesktopAuthorizationCodeChange={vi.fn()}
        onApproveDesktopLogin={vi.fn()}
        onLogout={vi.fn()}
        onDeleteCloudData={vi.fn()}
        onReset={vi.fn()}
        onApplyViewportDefaults={vi.fn()}
        onExportDiagnostics={vi.fn()}
        onExportInteractionLog={vi.fn()}
        onDismissProjectInvitation={vi.fn()}
        onClose={vi.fn()}
        {...overrides}
      />
    );
  }
  render(<Harness />);
  return {
    latest: () => commits.at(-1) ?? defaultAppSettings()
  };
}

describe('settings number fields', () => {
  /**
   * Bound straight to the setting, every keystroke through an out-of-range
   * value was put back: "12" in a 4–24 field left 10, and "0.5" in linear
   * snap saved 1.5.
   */
  it('accepts a value whose first digit is below the floor', async () => {
    const user = userEvent.setup();
    const { latest } = renderStatefulSettings({ initialSection: 'sketching' });
    const tolerance = screen.getByLabelText('Sketch snap tolerance');

    await user.clear(tolerance);
    await user.type(tolerance, '12');
    expect(tolerance).toHaveValue(12);
    expect(latest().sketching.snapTolerancePx).toBe(12);
    await user.tab();
    expect(tolerance).toHaveValue(12);
    expect(latest().sketching.snapTolerancePx).toBe(12);
  });

  it('types a fractional linear snap without corrupting it', async () => {
    const user = userEvent.setup();
    const { latest } = renderStatefulSettings({ initialSection: 'sketching' });
    const linear = screen.getByLabelText('Linear snap increment');

    await user.clear(linear);
    await user.type(linear, '0.5');
    await user.tab();
    expect(linear).toHaveValue(0.5);
    expect(latest().sketching.linearSnap).toBe(0.5);
  });

  it('clamps an out-of-range tolerance on blur to the value storage keeps', async () => {
    const user = userEvent.setup();
    const { latest } = renderStatefulSettings({ initialSection: 'sketching' });
    const tolerance = screen.getByLabelText('Sketch snap tolerance');

    await user.clear(tolerance);
    await user.type(tolerance, '500');
    // Still being typed: shown as typed, never committed out of range.
    expect(tolerance).toHaveValue(500);
    expect(latest().sketching.snapTolerancePx).toBeLessThanOrEqual(24);
    await user.tab();

    expect(tolerance).toHaveValue(24);
    expect(latest().sketching.snapTolerancePx).toBe(24);
    // What the page shows is what a reload reads back, not the default.
    window.localStorage.clear();
    saveLocalAppSettings(latest());
    expect(loadLocalAppSettings().sketching.snapTolerancePx).toBe(24);
  });

  // I69 (13 November review): 500 became 24 with nothing said, and no field
  // showed its range.
  it('shows each field’s range and says when a value was pulled to a bound', async () => {
    const user = userEvent.setup();
    renderStatefulSettings({ initialSection: 'sketching' });
    const tolerance = screen.getByLabelText('Sketch snap tolerance');
    expect(tolerance).toHaveAccessibleDescription(/^\d+ px – 24 px$/);

    await user.clear(tolerance);
    await user.type(tolerance, '500');
    await user.tab();
    expect(
      screen.getByText('500 px is above the maximum, so it is set to 24 px.')
    ).toHaveAttribute('role', 'status');

    // The next keystroke takes the note away; an in-range value says nothing.
    await user.clear(tolerance);
    await user.type(tolerance, '12');
    await user.tab();
    expect(screen.queryByText(/is above the maximum/)).toBeNull();
    expect(screen.queryByText(/is below the minimum/)).toBeNull();
  });

  it('says when a value was raised to the minimum', async () => {
    const user = userEvent.setup();
    renderStatefulSettings({ initialSection: 'sketching' });
    const linear = screen.getByLabelText('Linear snap increment');
    await user.clear(linear);
    await user.type(linear, '0');
    await user.tab();
    expect(linear).toHaveValue(0.001);
    expect(
      screen.getByText('0 is below the minimum, so it is set to 0.001.')
    ).toBeVisible();
  });

  // I69/I11: the linear snap is in the open project's units, and now says so.
  it('names the linear snap’s unit from the open project', () => {
    renderSettings(null, {
      initialSection: 'sketching',
      documentUnits: 'inch'
    });
    const linear = screen.getByLabelText('Linear snap increment');
    expect(linear.closest('.settings-unit-input')).toHaveTextContent('in');
    expect(linear).toHaveAccessibleDescription('0.001 in – 10,000 in');
    expect(screen.getByText('In this project’s units.')).toBeVisible();
  });

  it('leaves the linear snap unitless from the start screen', () => {
    renderSettings(null, { initialSection: 'sketching' });
    expect(screen.getByText('In each project’s own units.')).toBeVisible();
    expect(
      screen.getByLabelText('Linear snap increment')
    ).toHaveAccessibleDescription('0.001 – 10,000');
  });

  it('does not offer the angular snap no tool reads yet', () => {
    renderSettings(null, { initialSection: 'sketching' });
    expect(screen.queryByLabelText('Angular snap increment')).toBeNull();
  });

  it.each([
    { label: 'Sketch snap tolerance', key: 'snapTolerancePx', value: 4.5 },
    { label: 'Linear snap increment', key: 'linearSnap', value: 2.25 }
  ] as const)(
    'preserves fractional $label through storage',
    async ({ label, key, value }) => {
      const user = userEvent.setup();
      const { latest } = renderStatefulSettings({
        initialSection: 'sketching'
      });
      const field = screen.getByLabelText(label);

      await user.clear(field);
      await user.type(field, String(value));
      expect(latest().sketching[key]).toBe(value);
      await user.tab();
      expect(field).toHaveValue(value);
      expect(latest().sketching[key]).toBe(value);
      window.localStorage.clear();
      saveLocalAppSettings(latest());
      expect(loadLocalAppSettings().sketching[key]).toBe(value);
    }
  );

  it('restores the setting when a field is left empty', async () => {
    const user = userEvent.setup();
    const { latest } = renderStatefulSettings({ initialSection: 'sketching' });
    const tolerance = screen.getByLabelText('Sketch snap tolerance');
    const before = latest().sketching.snapTolerancePx;

    await user.clear(tolerance);
    expect(tolerance).toHaveValue(null);
    await user.tab();
    expect(tolerance).toHaveValue(before);
    expect(latest().sketching.snapTolerancePx).toBe(before);
  });

  it('keeps the default output budget on the step grid', () => {
    const personal = defaultAppSettings();
    personal.assistant.credentialSource = 'personal';
    renderSettings(null, { settings: personal, initialSection: 'assistant' });

    // The step grid starts at `min`: a 1024 floor with a 1024 step made the
    // 32000 default a step mismatch and sent the arrow keys to 32768 (and a
    // 0.001 floor with a 0.1 step did the same to linear snap's 1).
    const budget = screen.getByLabelText<HTMLInputElement>(
      'Output budget (tokens)'
    );
    expect(budget).toHaveValue(personal.assistant.maxOutputTokens);
    expect(budget.validity.stepMismatch).toBe(false);
  });
});

describe('settings navigation', () => {
  it('lets Appearance break only at its syllable in the phone rail', async () => {
    renderSettings();
    const button = await screen.findByRole('button', { name: 'Appearance' });
    // Shown with a soft hyphen, so a rail narrower than the word breaks it
    // as "Appear-" over "ance" rather than at an arbitrary letter; the
    // button keeps the plain name.
    expect(button.querySelector('span')?.textContent).toBe('Appear­ance');
    expect(button).toHaveAccessibleName('Appearance');
  });

  it('opens on the heading without focusing the active nav item or close button', async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    const onClose = vi.fn();
    renderSettings(null, { onClose });

    expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'General' })).not.toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClose).not.toHaveBeenCalled();
  });

  // The same owner-mounted focus hook and delayed body as App's overlay.
  function SettingsDialog({
    initiallyOpen,
    loaded
  }: {
    initiallyOpen: boolean;
    loaded: boolean;
  }) {
    const [open, setOpen] = useState(initiallyOpen);
    const dialogRef = useRef<HTMLDivElement>(null);
    useModalFocus(dialogRef, { enabled: open, autoFocus: true });
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open Settings
        </button>
        {open && (
          <div
            ref={dialogRef}
            role="dialog"
            aria-label="Settings"
            tabIndex={-1}
          >
            {loaded && settingsElement(null, { onClose: () => setOpen(false) })}
          </div>
        )}
      </>
    );
  }

  it.each([
    { initiallyOpen: true, loaded: true },
    { initiallyOpen: true, loaded: false },
    { initiallyOpen: false, loaded: true },
    { initiallyOpen: false, loaded: false }
  ])(
    'keeps modal keyboard navigation on open/restore (restored: $initiallyOpen, ready: $loaded)',
    async ({ initiallyOpen, loaded }) => {
      const user = userEvent.setup();
      window.localStorage.clear();
      if (initiallyOpen) {
        updateSettingsViewState({ open: true, activeSection: 'account' });
      }
      const { rerender } = render(
        <SettingsDialog initiallyOpen={initiallyOpen} loaded={loaded} />
      );
      const opener = screen.getByText('Open Settings');
      if (!initiallyOpen) await user.click(opener);

      expect(opener).toHaveAttribute('inert');
      expect(modalHoldsKeyboard()).toBe(true);
      if (!loaded) {
        expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveFocus();
        rerender(<SettingsDialog initiallyOpen={initiallyOpen} loaded />);
      }

      await waitFor(() =>
        expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus()
      );
      const activeSection = screen.getByRole('button', {
        name: initiallyOpen ? 'Account' : 'General'
      });
      expect(activeSection).toHaveAttribute('aria-current', 'page');
      expect(activeSection).not.toHaveFocus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible();

      await user.tab();
      expect(
        screen.getByRole('textbox', { name: 'Find a setting' })
      ).toHaveFocus();
      await user.tab({ shift: true });
      const navigation = screen.getByRole('navigation');
      const lastSection = within(navigation).getAllByRole('button').at(-1)!;
      expect(lastSection).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(lastSection).toHaveAttribute('aria-current', 'page');
      expect(lastSection).toHaveFocus();

      // Cycling from the first Tab stop still wraps within the dialog.
      const brand = screen.getByRole('button', { name: /OpenZCAD/ });
      brand.focus();
      await user.tab({ shift: true });
      expect(screen.getByRole('dialog')).toContainElement(
        document.activeElement as HTMLElement
      );
      expect(brand).not.toHaveFocus();
      await user.tab();
      expect(brand).toHaveFocus();

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
      expect(modalHoldsKeyboard()).toBe(false);
      expect(opener).not.toHaveAttribute('inert');
      if (!initiallyOpen) expect(opener).toHaveFocus();
    }
  );

  it('clears a search with Escape before Escape closes Settings', async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    const onClose = vi.fn();
    renderSettings(null, { onClose });
    const search = screen.getByLabelText('Find a setting');

    await user.type(search, 'snap');
    await user.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows no section while a search matches nothing', async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    renderSettings();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'General'
    );

    await user.type(screen.getByLabelText('Find a setting'), 'zzzz');

    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(
      screen.getByText(/Clear the search to see every section/)
    ).toBeVisible();
  });

  it('puts the way back in the head’s corner, outside the scrolling page', () => {
    window.localStorage.clear();
    renderSettings(null, { initialSection: 'viewport' });
    const back = screen.getByRole('button', {
      name: 'Close settings and go back to workspace'
    });
    // Where the library's and the workspace's Settings button sits.
    expect(back.closest('.corner-slot')).not.toBeNull();
    expect(back.closest('.settings-head')).not.toBeNull();
    // The head is not inside the page that scrolls, so neither moves.
    expect(back.closest('.settings-content')).toBeNull();
    expect(back.closest('.settings-nav')).toBeNull();
  });

  it('names the way back after what is behind Settings', () => {
    window.localStorage.clear();
    const view = renderSettings(null, { initialSection: 'viewport' });
    expect(
      screen.getByRole('button', {
        name: 'Close settings and go back to workspace'
      })
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Apply defaults to current view' })
    ).toBeEnabled();
    view.unmount();

    renderSettings(null, { initialSection: 'viewport', workspaceOpen: false });
    expect(
      screen.getByRole('button', {
        name: 'Close settings and go back to projects'
      })
    ).toBeVisible();
    // No project is open, so there is no view to apply the defaults to.
    expect(
      screen.getByRole('button', { name: 'Apply defaults to current view' })
    ).toBeDisabled();
    expect(screen.getByText(/Open a project to apply/)).toBeVisible();
  });

  it('does not call a profile it could not load connected', () => {
    const session = {
      userId: toUserId('user_footer'),
      displayName: 'person',
      email: 'person@example.com',
      mode: 'email-code' as const
    };
    const view = renderSettings(null, {
      authConfigStatus: 'ready',
      session,
      accountState: null
    });
    expect(screen.getByText('Cloud profile unavailable')).toBeVisible();
    view.unmount();

    renderSettings(null, {
      authConfigStatus: 'ready',
      session,
      accountState: {
        settings: defaultAppSettings(),
        revision: 1,
        synced: true,
        credential: { stored: false, storageAvailable: true },
        effectiveAssistant: {
          configured: false,
          source: 'deployment',
          provider: 'openrouter',
          model: '',
          reasoningEffort: 'provider-default'
        }
      }
    });
    expect(screen.getByText('Cloud profile connected')).toBeVisible();
  });
});

describe('assistant data disclosure', () => {
  it('does not promise free access when a restricted deployment denies the account', () => {
    const settings = defaultAppSettings();
    settings.assistant.enabled = true;
    renderSettings(null, {
      settings,
      initialSection: 'assistant',
      session: {
        userId: toUserId('user_restricted'),
        displayName: 'Restricted user',
        email: 'restricted@example.com',
        mode: 'email-code'
      },
      accountState: {
        settings,
        revision: 1,
        synced: true,
        credential: { stored: false, storageAvailable: true },
        effectiveAssistant: {
          configured: false,
          source: 'deployment',
          provider: 'openrouter',
          model: 'minimax/minimax-m3.1-flash:free',
          reasoningEffort: 'high'
        }
      }
    });
    expect(screen.getByText('Unavailable')).toBeVisible();
    expect(
      screen.queryByText(/Free with no personal API key/)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/may retain this data or use it for training/)
    ).toBeVisible();
  });

  it.each(['openai', 'responses-compatible'] as const)(
    'discloses the effective %s deployment provider instead of OpenRouter',
    (provider) => {
      const settings = defaultAppSettings();
      renderSettings(null, {
        initialSection: 'assistant',
        accountState: {
          settings,
          revision: 1,
          synced: true,
          credential: { stored: false, storageAvailable: true },
          effectiveAssistant: {
            configured: true,
            source: 'deployment',
            provider,
            model: 'deployment-model',
            reasoningEffort: 'high'
          }
        }
      });

      expect(screen.queryByText(/OpenRouter/)).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Free with no personal API key/)
      ).not.toBeInTheDocument();
      if (provider === 'openai') {
        expect(
          screen.getByText(/OpenAI may retain API data/)
        ).toHaveTextContent(
          'API data is not used for training unless the deployment operator opts in'
        );
        expect(
          screen.getByRole('link', { name: 'OpenAI API data policies' })
        ).toHaveAttribute(
          'href',
          'https://developers.openai.com/api/docs/guides/your-data'
        );
      } else {
        expect(
          screen.getByText(/The configured AI provider may retain this data/)
        ).toHaveTextContent(
          'Ask your deployment operator which service and data policies apply.'
        );
        expect(
          screen.queryByRole('link', { name: /data policies/ })
        ).not.toBeInTheDocument();
      }
    }
  );

  it('reserves the data notice while loading, without flashing fallback copy', async () => {
    let finishRead!: (
      result: Awaited<ReturnType<typeof loadAssistantStatus>>
    ) => void;
    vi.mocked(loadAssistantStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        })
    );
    const { rerender } = renderSettings(null, { initialSection: 'assistant' });
    const signal = vi.mocked(loadAssistantStatus).mock.calls.at(-1)?.[0];
    expect(screen.getByText('Loading…')).toBeVisible();
    expect(
      screen.getByRole('status', { name: 'Loading assistant data policies' })
    ).toBeVisible();
    expect(screen.queryByText(/Ask your deployment operator/)).toBeNull();
    expect(
      screen.queryByText('Status appears when the server is reachable.')
    ).toBeNull();
    expect(screen.queryByText('Not configured')).toBeNull();
    expect(screen.queryByRole('link', { name: /data policies/ })).toBeNull();
    const reserve = document.querySelector('.settings-assistant-data-reserve');
    expect(reserve).toHaveAttribute('aria-hidden', 'true');

    const settings = defaultAppSettings();
    rerender(
      settingsElement(null, {
        initialSection: 'assistant',
        accountState: {
          settings,
          revision: 1,
          synced: true,
          credential: { stored: false, storageAvailable: true },
          effectiveAssistant: {
            configured: false,
            source: 'deployment',
            provider: 'openrouter',
            model: 'openai/gpt-5-luna',
            reasoningEffort: 'high'
          }
        }
      })
    );
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('Off')).toBeVisible();
    expect(
      screen.getByText('openrouter · openai/gpt-5-luna · high reasoning')
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'OpenRouter data policies' })
    ).toBeVisible();
    expect(screen.queryByText(/Ask your deployment operator/)).toBeNull();
    expect(document.querySelector('.settings-assistant-data-reserve')).toBe(
      reserve
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finishRead({
        configured: true,
        provider: 'openai',
        model: 'stale-model',
        reasoningEffort: 'high'
      });
    });
    expect(screen.queryByText(/stale-model/)).toBeNull();
    expect(
      screen.getByRole('link', { name: 'OpenRouter data policies' })
    ).toBeVisible();
  });

  it('keeps the unreachable message and generic policy after the server fails', async () => {
    vi.mocked(loadAssistantStatus).mockRejectedValue(new Error('Offline'));
    renderSettings(null, { initialSection: 'assistant' });
    expect(
      await screen.findByText('Status appears when the server is reachable.')
    ).toBeVisible();
    expect(screen.getByText('Unavailable')).toBeVisible();
    expect(screen.getByText(/Ask your deployment operator/)).toBeVisible();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.queryByText(/OpenRouter/)).toBeNull();
  });

  it('loads the deployment policy even when no account settings arrive', async () => {
    vi.mocked(loadAssistantStatus).mockResolvedValue({
      configured: false,
      source: 'deployment',
      provider: 'openai',
      model: 'gpt-5-luna',
      reasoningEffort: 'high'
    });
    renderSettings(null, { initialSection: 'assistant' });
    expect(
      await screen.findByRole('link', { name: 'OpenAI API data policies' })
    ).toBeVisible();
    expect(screen.getByText('Off')).toBeVisible();
    expect(screen.queryByText(/Ask your deployment operator/)).toBeNull();
  });

  it.each([
    { enabled: false, configured: false, badge: 'Off' },
    { enabled: false, configured: true, badge: 'Off' },
    { enabled: true, configured: true, badge: 'Ready' },
    { enabled: true, configured: false, badge: 'Unavailable' }
  ])(
    'labels enabled=$enabled and configured=$configured as $badge',
    ({ enabled, configured, badge }) => {
      const settings = defaultAppSettings();
      settings.assistant.enabled = enabled;
      renderSettings(null, {
        settings,
        initialSection: 'assistant',
        accountState: {
          settings,
          revision: 1,
          synced: true,
          credential: { stored: false, storageAvailable: true },
          effectiveAssistant: {
            configured,
            source: 'deployment',
            provider: 'openrouter',
            model: 'deployment-model',
            reasoningEffort: 'high'
          }
        }
      });
      expect(screen.getByText(badge)).toBeVisible();
      expect(screen.queryByText('Not configured')).toBeNull();
    }
  );

  it('explains the free built-in model and data use, then keeps the personal model option', async () => {
    const user = userEvent.setup();
    const settings = defaultAppSettings();
    renderStatefulSettings({
      initialSection: 'assistant',
      accountState: {
        settings,
        revision: 1,
        synced: true,
        credential: { stored: false, storageAvailable: true },
        effectiveAssistant: {
          configured: true,
          source: 'deployment',
          provider: 'openrouter',
          model: 'minimax/minimax-m3.1-flash:free',
          reasoningEffort: 'high'
        }
      }
    });

    expect(screen.getByText(/Free with no personal API key/)).toBeVisible();
    expect(
      screen.getByText(/may retain this data or use it for training/)
    ).toBeVisible();
    expect(
      screen.getByText(/The built-in assistant sends your prompts/)
    ).toHaveTextContent('conversation, model context, and any attachments');
    expect(
      screen.getByRole('link', { name: 'OpenRouter data policies' })
    ).toHaveAttribute(
      'href',
      'https://openrouter.ai/docs/guides/privacy/provider-logging'
    );
    await user.click(screen.getByRole('radio', { name: 'Personal token' }));
    expect(screen.getByLabelText('AI provider')).toBeVisible();
    expect(screen.getByLabelText('AI model')).toBeVisible();
    expect(screen.getByLabelText('Personal API token')).toBeVisible();
    expect(
      screen.getByText(/That provider’s data retention, training policies/)
    ).toBeVisible();
    expect(
      screen.queryByText(/Free with no personal API key/)
    ).not.toBeInTheDocument();
  });
});

describe('settings accessible names', () => {
  it('start each control name with its visible title', async () => {
    const user = userEvent.setup();
    const personal = defaultAppSettings();
    personal.assistant.credentialSource = 'personal';
    renderSettings(null, { settings: personal, initialSection: 'controls' });

    expect(
      screen.getByRole('checkbox', { name: 'Zoom toward the pointer' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'AI Assistant' }));
    expect(screen.getByLabelText('Output budget (tokens)')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Request timeout (seconds)')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Personal API token')).toBeInTheDocument();
  });

  it('shows the token visibility state to sighted users too', async () => {
    const user = userEvent.setup();
    const personal = defaultAppSettings();
    personal.assistant.credentialSource = 'personal';
    renderSettings(null, { settings: personal, initialSection: 'assistant' });

    const reveal = screen.getByRole('button', { name: 'Show token' });
    expect(reveal).toHaveAttribute('title', 'Show token');
    await user.click(reveal);
    const conceal = screen.getByRole('button', { name: 'Hide token' });
    expect(conceal).toHaveAttribute('title', 'Hide token');
  });
});

describe('settings offline mode', () => {
  it('keeps local features available and removes cloud-only surfaces', async () => {
    const user = userEvent.setup();
    const onCloudFunctionsEnabledChange = vi.fn();
    renderSettings(null, {
      cloudFunctionsEnabled: false,
      onCloudFunctionsEnabledChange
    });

    expect(screen.getByText('Offline mode')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI Assistant' })).toBeNull();
    expect(
      screen.queryByRole('checkbox', { name: 'AI assistant' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Project sharing' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Saving' }));
    expect(screen.getByText('Local autosave')).toBeInTheDocument();
    expect(screen.getByText('Always on')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Cloud autosave' })
    ).toBeDisabled();
    expect(screen.getByText('Disabled')).toBeInTheDocument();

    // Account stays reachable offline, holding only the way back: the cloud
    // switch, never the sign-in, sharing, or storage it would block.
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByText(/Cloud features are off/)).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Project sharing' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Storage' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Cloud features' }));
    expect(onCloudFunctionsEnabledChange).toHaveBeenCalledWith(true);
  });
});

describe('settings viewport copy', () => {
  it('describes navigation as desktop CAD does, without naming products', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('button', { name: 'Controls' }));
    expect(screen.getByText('Pan matches desktop CAD.')).toBeInTheDocument();
    expect(
      screen.getByText('Off zooms toward the middle of the view.')
    ).toBeInTheDocument();
  });
});

describe('settings controls section', () => {
  it('opens on one keyboard header, not a banner stacked above it', async () => {
    const user = userEvent.setup();
    const { container } = renderSettings();

    await user.click(screen.getByRole('button', { name: 'Controls' }));

    expect(screen.queryByText('Shortcuts are fixed and context-aware.')).toBe(
      null
    );
    const headers = container.querySelectorAll('.settings-group-head');
    // The remappable keys under one header, then the keys that keep one
    // meaning everywhere, then the pointer.
    expect([...headers].map((header) => header.textContent)).toEqual([
      'Navigation',
      expect.stringContaining('3D mouse'),
      'SpaceMouse keys',
      expect.stringContaining('Keyboard'),
      expect.stringContaining('Fixed keys'),
      'Mouse & pointer'
    ]);
    expect(
      screen.getByRole('button', { name: 'Reset all shortcuts' })
    ).toBeDisabled();
    // The banner's guidance lives on beside the one header.
    expect(headers[3]).toHaveTextContent(
      'Workspace shortcuts pause while you type in a field'
    );
  });
});

describe('settings control reference details', () => {
  it('shows each binding’s explanation from a button, not only a tooltip', async () => {
    const user = userEvent.setup();
    renderSettings(null, { initialSection: 'controls' });

    const pointer = POINTER_CONTROL_GROUPS[0];
    const sample = pointer.items[0];
    const toggle = screen.getByRole('button', {
      name: `Details for ${pointer.title}`
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(sample.detail)).toBeNull();

    // Reachable by keyboard: focus it and press Enter.
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(sample.detail)).toBeVisible();
    // The name does not change with the state.
    expect(toggle).toHaveAccessibleName(`Details for ${pointer.title}`);

    await user.click(toggle);
    expect(screen.queryByText(sample.detail)).toBeNull();
  });
});

describe('settings assistant section', () => {
  it('keeps the master toggle on the AI Assistant page while disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<ComponentProps<typeof SettingsPage>['onChange']>();
    renderSettings(null, { onChange });

    expect(
      screen.queryByRole('checkbox', { name: 'AI assistant' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'AI Assistant' }));

    const toggle = screen.getByRole('checkbox', { name: 'AI assistant' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0]?.[0].assistant.enabled).toBe(true);
  });

  function personalAssistantState(
    lastValidatedAt?: string
  ): AppSettingsResponse {
    const settings = defaultAppSettings();
    settings.assistant.enabled = true;
    settings.assistant.credentialSource = 'personal';
    return {
      settings,
      revision: 1,
      synced: true,
      credential: {
        stored: true,
        hint: '••••test',
        updatedAt: '2026-08-30T12:00:00.000Z',
        ...(lastValidatedAt ? { lastValidatedAt } : {}),
        storageAvailable: true
      },
      effectiveAssistant: {
        configured: true,
        source: 'personal',
        provider: 'openrouter',
        model: 'openai/gpt-5.6-sol',
        reasoningEffort: 'high'
      }
    };
  }

  it('disables Off for always-thinking Anthropic models', () => {
    const accountState = personalAssistantState();
    accountState.settings.assistant.provider = 'anthropic';
    accountState.settings.assistant.model = 'claude-opus-5-5';
    renderSettings(null, {
      settings: accountState.settings,
      accountState,
      initialSection: 'assistant'
    });
    expect(screen.getByRole('option', { name: 'Off' })).toBeDisabled();
  });

  it('resets Off when editing the Anthropic model to an unsupported one', async () => {
    const user = userEvent.setup();
    const accountState = personalAssistantState();
    accountState.settings.assistant.provider = 'anthropic';
    accountState.settings.assistant.model = 'claude-sonnet-5-5';
    accountState.settings.assistant.reasoningEffort = 'off';
    const onChange = vi.fn<ComponentProps<typeof SettingsPage>['onChange']>();
    renderSettings(null, {
      settings: accountState.settings,
      accountState,
      initialSection: 'assistant',
      onChange
    });
    await user.clear(screen.getByRole('textbox', { name: 'AI model' }));
    expect(onChange.mock.calls.at(-1)?.[0].assistant.reasoningEffort).toBe(
      'provider-default'
    );
  });

  it('selects Anthropic with its official endpoint and Claude default', async () => {
    const user = userEvent.setup();
    const accountState = personalAssistantState();
    const onChange = vi.fn<ComponentProps<typeof SettingsPage>['onChange']>();
    renderSettings(null, {
      settings: accountState.settings,
      accountState,
      initialSection: 'assistant',
      session: {
        userId: toUserId('user_provider_switch'),
        displayName: 'person',
        mode: 'email-code'
      },
      onChange
    });
    await user.type(
      screen.getByLabelText('Personal API token'),
      'test-other-provider-token'
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'AI provider' }),
      'anthropic'
    );
    expect(screen.getByLabelText('Personal API token')).toHaveValue('');
    expect(onChange).toHaveBeenCalledOnce();
    const next = onChange.mock.calls[0]![0];
    expect(next.assistant).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      baseUrl: ''
    });
    expect(
      screen.queryByRole('textbox', { name: 'AI API endpoint' })
    ).toBeNull();
  });

  it('labels an untested saved credential as configured, not ready', () => {
    const accountState = personalAssistantState();
    renderSettings(null, {
      settings: accountState.settings,
      accountState,
      initialSection: 'assistant',
      session: {
        userId: toUserId('user_ai'),
        displayName: 'person',
        email: 'person@example.com',
        mode: 'email-code'
      }
    });

    expect(screen.getByText(/Configured · openai\/gpt-5.6-sol/)).toHaveClass(
      'settings-state',
      'warning'
    );
    expect(screen.queryByText(/Ready · openai\/gpt-5.6-sol/)).toBeNull();
  });

  it('labels a credential validated only after a completed test', () => {
    const accountState = personalAssistantState('2026-08-30T12:01:00.000Z');
    renderSettings(null, {
      settings: accountState.settings,
      accountState,
      initialSection: 'assistant',
      session: {
        userId: toUserId('user_ai'),
        displayName: 'person',
        email: 'person@example.com',
        mode: 'email-code'
      }
    });

    expect(screen.getByText(/Validated · openai\/gpt-5.6-sol/)).toHaveClass(
      'settings-state',
      'good'
    );
  });
});

describe('settings advanced section', () => {
  it('reports the kernel build the app was compiled against', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(screen.getByText('Kernel version')).toBeInTheDocument();
    const value = screen.getByTitle(kernelBuildDetail(KERNEL_BUILD));
    expect(value).toHaveTextContent(kernelBuildLabel(KERNEL_BUILD));
    // The abbreviated commit is what the row shows; the full one is the
    // tooltip, so a defect report can carry an unambiguous sha.
    expect(value.textContent).toMatch(/^Remus /);
  });

  it('turns the frame rate overlay on, off by default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSettings(null, { onChange });

    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    const toggle = screen.getByRole('checkbox', {
      name: 'Frame rate overlay'
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    const next = onChange.mock.calls[0]![0] as AppSettings;
    expect(next.experiments.frameRateOverlay).toBe(true);
    // The neighbouring switch in the same group is carried, not reset.
    expect(next.experiments.directManipulation).toBe(true);
  });

  it('offers the support exports that left the File menu', async () => {
    const user = userEvent.setup();
    const onExportDiagnostics = vi.fn();
    const onExportInteractionLog = vi.fn();
    renderSettings(null, { onExportDiagnostics, onExportInteractionLog });

    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    await user.click(
      screen.getByRole('button', { name: 'Export diagnostics' })
    );
    await user.click(
      screen.getByRole('button', { name: 'Export interaction log' })
    );

    expect(onExportDiagnostics).toHaveBeenCalledOnce();
    expect(onExportInteractionLog).toHaveBeenCalledOnce();
  });

  it('exports diagnostics only with a project open, the log always', async () => {
    // From the start screen there is no project to take a snapshot of; the
    // interaction log is the device's, and needs none.
    const user = userEvent.setup();
    renderSettings(null, { workspaceOpen: false });

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(
      screen.getByRole('button', { name: 'Export diagnostics' })
    ).toBeDisabled();
    expect(
      screen.getByText(/^Open a project to export a sanitized snapshot/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Export interaction log' })
    ).toBeEnabled();
  });

  it('finds the support exports by searching for troubleshooting', async () => {
    const user = userEvent.setup();
    renderSettings();

    const field = screen.getByLabelText('Find a setting');
    await user.type(field, 'troubleshooting');

    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(
      screen.getByRole('button', { name: 'Export diagnostics' })
    ).toBeInTheDocument();
    // Settings restores the last search; leave none for the next test.
    await user.clear(field);
  });

  it('finds the frame rate overlay by searching for fps', async () => {
    const user = userEvent.setup();
    renderSettings();

    const field = screen.getByLabelText('Find a setting');
    await user.type(field, 'fps');

    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(
      screen.getByRole('checkbox', { name: 'Frame rate overlay' })
    ).toBeInTheDocument();
    // Settings restores the last search; leave none for the next test.
    await user.clear(field);
  });

  it('finds it by searching for the kernel', async () => {
    const user = userEvent.setup();
    renderSettings();

    // Searching jumps to the only matching section, so the row is reachable
    // without knowing it lives under "Advanced".
    await user.type(screen.getByLabelText('Find a setting'), 'kernel version');

    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByText('Kernel version')).toBeInTheDocument();
  });

  /**
   * Production QA UI-04: below 580px the field used to be hidden, so a filter
   * typed in a wider window left the rail on its matches with no way out, and
   * a separate clear button stood in for it. The field now stays at every
   * width (13 November review, I70; settings.spec.ts checks it at 390px), so
   * the field itself is the way out, and the stand-in is gone.
   */
  it('leaves an active filter from the field itself, with no stand-in button', async () => {
    const user = userEvent.setup();
    // Start unfiltered: Settings restores the last search it was left on.
    window.localStorage.clear();
    renderSettings();
    const rail = screen.getByRole('complementary', {
      name: 'Settings sections'
    });
    const sectionsBefore = within(rail).getAllByRole('button').length;

    const field = screen.getByLabelText('Find a setting');
    await user.type(field, 'snap');
    expect(within(rail).getAllByRole('button').length).toBeLessThan(
      sectionsBefore
    );
    expect(
      screen.queryByRole('button', { name: /^Clear the filter/ })
    ).not.toBeInTheDocument();

    await user.clear(field);
    expect(within(rail).getAllByRole('button')).toHaveLength(sectionsBefore);
  });

  it('reports cloud project storage as not ready when health fails closed', async () => {
    const user = userEvent.setup();
    renderSettings({
      status: 'ok',
      environment: 'beta',
      time: '2026-08-03T12:00:00.000Z',
      documentStorageAccountingReady: false
    });

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(screen.getByText('Cloud project storage')).toBeInTheDocument();
    expect(screen.getByText('Not ready')).toHaveClass(
      'settings-state',
      'warning'
    );
  });
});

describe('settings desktop account section', () => {
  it('explains browser-only analytics without offering a desktop consent control', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {}
    });
    try {
      renderSettings(null, { initialSection: 'privacy' });
      expect(
        screen.queryByRole('checkbox', { name: 'Optional usage analytics' })
      ).toBeNull();
      expect(
        screen.getByText(/This desktop app does not send usage events/)
      ).toBeVisible();
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
    }
  });
  it('turns project sharing off from the account section', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSettings(null, { initialSection: 'account', onChange });

    await user.click(screen.getByRole('checkbox', { name: 'Project sharing' }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ collaboration: { enabled: false } })
    );
  });

  it('offers the secure browser handoff when native auth is ready', async () => {
    const user = userEvent.setup();
    const onStartDesktopLogin = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {}
    });

    try {
      renderSettings(null, {
        initialSection: 'account',
        authConfig: {
          mode: 'email-code',
          emailCodeEnabled: true,
          desktopAuthEnabled: true
        },
        authConfigStatus: 'ready',
        onStartDesktopLogin
      });

      expect(screen.getByText('Sign in with your browser')).toBeInTheDocument();
      expect(screen.getByText(/macOS stores only/)).toBeInTheDocument();
      await user.click(
        screen.getByRole('button', { name: 'Continue in browser' })
      );
      expect(onStartDesktopLogin).toHaveBeenCalledOnce();
    } finally {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
    }
  });

  it('keeps all six digits when a copied code is pasted with whitespace', async () => {
    const user = userEvent.setup();
    const onVerifyLoginCode = vi.fn().mockResolvedValue(undefined);
    const turnstile = {
      render: vi.fn(
        (
          _container: HTMLElement,
          options: { callback(token: string): void }
        ) => {
          options.callback('turnstile-token');
          return 'widget-1';
        }
      ),
      remove: vi.fn(),
      reset: vi.fn()
    };
    Object.defineProperty(window, 'turnstile', {
      configurable: true,
      value: turnstile
    });
    // Stands in for the loaded Turnstile script so the widget does not fetch it.
    const script = document.createElement('script');
    script.dataset.openzcadTurnstile = 'true';
    document.head.append(script);

    try {
      renderSettings(null, {
        initialSection: 'account',
        authConfig: {
          mode: 'email-code',
          emailCodeEnabled: true,
          turnstileSiteKey: 'site-key'
        },
        authConfigStatus: 'ready',
        onRequestLoginCode: vi.fn().mockResolvedValue({
          challengeId: 'challenge-1',
          expiresInSeconds: 600
        }),
        onVerifyLoginCode
      });

      await user.type(
        screen.getByLabelText('Email address'),
        'person@example.com'
      );
      await user.click(screen.getByRole('button', { name: 'Email me a code' }));
      const codeField = await screen.findByLabelText('Email sign-in code');
      // A selection copied from the email often carries a leading or
      // trailing space or line break. A length cap on the field cut the
      // pasted text before the digit filter ran and dropped the last digit.
      await user.click(codeField);
      await user.paste(' 730418\n');
      expect(codeField).toHaveValue('730418');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(onVerifyLoginCode).toHaveBeenCalledWith('challenge-1', '730418');
    } finally {
      script.remove();
      delete (window as Window & { turnstile?: unknown }).turnstile;
    }
  });

  it('says a refused sign-in code at the field', async () => {
    // 13 November review I4: the refusal showed only in small mono text
    // beside the Settings title, and the field had no error state.
    const user = userEvent.setup();
    const refused = Object.assign(new Error('That sign-in code is invalid.'), {
      status: 400
    });
    const onVerifyLoginCode = vi.fn().mockRejectedValue(refused);
    Object.defineProperty(window, 'turnstile', {
      configurable: true,
      value: {
        render: vi.fn(
          (
            _container: HTMLElement,
            options: { callback(token: string): void }
          ) => {
            options.callback('turnstile-token');
            return 'widget-1';
          }
        ),
        remove: vi.fn(),
        reset: vi.fn()
      }
    });
    const script = document.createElement('script');
    script.dataset.openzcadTurnstile = 'true';
    document.head.append(script);
    try {
      renderSettings(null, {
        initialSection: 'account',
        authConfig: {
          mode: 'email-code',
          emailCodeEnabled: true,
          turnstileSiteKey: 'site-key'
        },
        authConfigStatus: 'ready',
        onRequestLoginCode: vi.fn().mockResolvedValue({
          challengeId: 'challenge-1',
          expiresInSeconds: 600
        }),
        onVerifyLoginCode
      });
      await user.type(
        screen.getByLabelText('Email address'),
        'person@example.com'
      );
      await user.click(screen.getByRole('button', { name: 'Email me a code' }));
      const codeField = await screen.findByLabelText('Email sign-in code');
      await user.type(codeField, '111111');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      await waitFor(() => expect(codeField).toHaveAttribute('aria-invalid'));
      expect(codeField).toHaveAccessibleDescription(
        'That sign-in code is invalid.'
      );
      // The refused code is cleared (I81), so the next digit is the edit.
      await user.type(codeField, '1');
      expect(codeField).not.toHaveAttribute('aria-invalid');
      expect(codeField).not.toHaveAccessibleDescription();
    } finally {
      script.remove();
      delete (window as Window & { turnstile?: unknown }).turnstile;
    }
  });

  // Design review I81: no Resend, a placeholder that looked typed, and a
  // wrong code left in the field.
  it('clears a wrong code, uses a neutral placeholder and offers a new code after a wait', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onVerifyLoginCode = vi
      .fn()
      .mockRejectedValue(new Error('That sign-in code is invalid.'));
    const onRequestLoginCode = vi
      .fn()
      .mockResolvedValueOnce({
        challengeId: 'challenge-1',
        expiresInSeconds: 600
      })
      .mockResolvedValueOnce({
        challengeId: 'challenge-2',
        expiresInSeconds: 600
      });
    Object.defineProperty(window, 'turnstile', {
      configurable: true,
      value: {
        render: vi.fn(
          (
            _container: HTMLElement,
            options: { callback(token: string): void }
          ) => {
            options.callback('turnstile-token');
            return 'widget-1';
          }
        ),
        remove: vi.fn(),
        reset: vi.fn()
      }
    });
    const script = document.createElement('script');
    script.dataset.openzcadTurnstile = 'true';
    document.head.append(script);
    try {
      renderSettings(null, {
        initialSection: 'account',
        authConfig: {
          mode: 'email-code',
          emailCodeEnabled: true,
          turnstileSiteKey: 'site-key'
        },
        authConfigStatus: 'ready',
        onRequestLoginCode,
        onVerifyLoginCode
      });
      await user.type(
        screen.getByLabelText('Email address'),
        'person@example.com'
      );
      await user.click(screen.getByRole('button', { name: 'Email me a code' }));
      const codeField = await screen.findByLabelText('Email sign-in code');
      expect(codeField).toHaveAttribute('placeholder', '6-digit code');
      await user.type(codeField, '123456');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      await waitFor(() => expect(codeField).toHaveValue(''));
      expect(codeField).toHaveFocus();

      expect(
        screen.getByRole('button', { name: /^Send a new code/ })
      ).toBeDisabled();
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      const resend = await screen.findByRole('button', {
        name: 'Send a new code'
      });
      await waitFor(() => expect(resend).toBeEnabled());
      await user.click(resend);
      expect(onRequestLoginCode).toHaveBeenLastCalledWith(
        'person@example.com',
        'turnstile-token'
      );
      await user.type(
        await screen.findByLabelText('Email sign-in code'),
        '654321'
      );
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(onVerifyLoginCode).toHaveBeenLastCalledWith(
        'challenge-2',
        '654321'
      );
    } finally {
      script.remove();
      delete (window as Window & { turnstile?: unknown }).turnstile;
      vi.useRealTimers();
    }
  });

  it('links the privacy policy from the email sign-in form', () => {
    Object.defineProperty(window, 'turnstile', {
      configurable: true,
      value: {
        render: vi.fn(() => 'widget-1'),
        remove: vi.fn(),
        reset: vi.fn()
      }
    });
    // Stands in for the loaded Turnstile script so the widget does not fetch it.
    const script = document.createElement('script');
    script.dataset.openzcadTurnstile = 'true';
    document.head.append(script);
    try {
      renderSettings(null, {
        initialSection: 'account',
        authConfig: {
          mode: 'email-code',
          emailCodeEnabled: true,
          turnstileSiteKey: 'site-key'
        },
        authConfigStatus: 'ready'
      });
      const form = screen
        .getByRole('button', { name: 'Email me a code' })
        .closest('form')!;
      const link = within(form).getByRole('link', { name: 'Privacy policy' });
      expect(link).toHaveAttribute('href', '/privacy');
      // A new tab: following it must not drop an unsaved workspace.
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer');
    } finally {
      script.remove();
      delete (window as Window & { turnstile?: unknown }).turnstile;
    }
  });

  it('requires an explicit approval before connecting the desktop app', async () => {
    const onApproveDesktopLogin = vi.fn().mockResolvedValue(undefined);

    renderSettings(null, {
      initialSection: 'account',
      session: {
        userId: toUserId('user_desktop'),
        displayName: 'person',
        email: 'person@example.com',
        mode: 'email-code'
      },
      desktopAuthorizationAttempt: 'attempt-1234567890',
      desktopAuthorizationCode: '',
      onDesktopAuthorizationCodeChange: vi.fn(),
      onApproveDesktopLogin
    });

    expect(
      screen.getByText(/Enter the 8-character code shown/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continue in OpenZCAD' })
    ).toBeDisabled();
    expect(onApproveDesktopLogin).not.toHaveBeenCalled();
  });
});

describe('settings privacy and data section', () => {
  const session = {
    userId: toUserId('user_privacy'),
    displayName: 'person',
    email: 'person@example.com',
    mode: 'email-code' as const
  };
  const readyHealth: HealthResponse = {
    status: 'ok',
    environment: 'beta',
    time: '2026-08-05T12:00:00.000Z',
    documentStorageAccountingReady: true,
    projectObjectStorageReady: true,
    accountErasureReady: true,
    projectErasureReady: true
  };

  it('links the privacy policy while signed out', () => {
    renderSettings(null, { initialSection: 'privacy' });
    const link = screen.getByRole('link', { name: 'Read the policy' });
    expect(link).toHaveAttribute('href', '/privacy');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    // In a browser the anchor itself opens the new tab; no native call.
    link.addEventListener('click', (event) => event.preventDefault(), {
      once: true
    });
    fireEvent.click(link);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(screen.getByText('Privacy policy')).toBeInTheDocument();
  });

  it('opens the hosted privacy policy in the system browser from the desktop app', async () => {
    vi.mocked(openExternalUrl).mockResolvedValue(true);
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    try {
      renderSettings(null, { initialSection: 'privacy', session });
      const link = screen.getByRole('link', { name: 'Read the policy' });
      expect(link).toHaveAttribute('href', 'https://zcad.app/privacy');
      // WKWebView ignores target="_blank"; the native shell opens the page.
      expect(fireEvent.click(link)).toBe(false);
      await waitFor(() =>
        expect(openExternalUrl).toHaveBeenCalledWith('https://zcad.app/privacy')
      );
    } finally {
      vi.mocked(openExternalUrl).mockReset();
      delete (window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
    }
  });

  it('finds the privacy policy from the settings search', async () => {
    const user = userEvent.setup();
    renderSettings(null, { initialSection: 'general' });
    await user.type(screen.getByLabelText('Find a setting'), 'privacy policy');
    expect(
      await screen.findByRole('link', { name: 'Read the policy' })
    ).toHaveAttribute('href', '/privacy');
  });

  it('starts profile details blurred, reveals them in place and keeps the choice when settings reopen', async () => {
    const user = userEvent.setup();
    const view = renderSettings(null, { initialSection: 'account', session });
    const profileRow = screen
      .getByRole('button', { name: 'Sign out' })
      .closest<HTMLElement>('.setting-row')!;
    const profile = within(profileRow);
    expect(view.container.innerHTML).not.toContain(session.email);
    // The fixture's name is a word the button's own label contains, so the
    // check reads the text a screenshot shows.
    expect(profileRow.textContent).not.toContain(session.displayName);
    // The name and email are their own switches: no separate show button.
    expect(screen.queryByText('Personal information')).toBeNull();
    const [name, email] = profile.getAllByRole('button', {
      name: 'Show personal info'
    });
    expect(name).not.toHaveAttribute('aria-pressed');
    await user.click(email!);
    expect(profile.getByRole('button', { name: session.email })).toBeVisible();
    // One switch: the name shows with the email, as project sharing does.
    const shownName = profile.getByRole('button', {
      name: session.displayName
    });
    expect(shownName).toHaveAttribute('title', 'Hide personal info');
    await user.click(shownName);
    expect(view.container.innerHTML).not.toContain(session.email);
    expect(profileRow.textContent).not.toContain(session.displayName);
    await user.click(
      profile.getAllByRole('button', { name: 'Show personal info' })[0]!
    );
    view.unmount();
    // The switch is session state shared with project sharing, not panel state.
    renderSettings(null, { initialSection: 'account', session });
    expect(
      screen.getByRole('button', { name: session.displayName })
    ).toBeVisible();
    expect(screen.getByRole('button', { name: session.email })).toBeVisible();
  });

  it('keeps all cloud deletion functions together on Privacy & data', async () => {
    const user = userEvent.setup();
    renderSettings(readyHealth, { initialSection: 'privacy', session });
    const scope = screen.getByRole('radiogroup', { name: 'What to delete' });

    // One button, relabelled and re-explained by the chosen scope.
    expect(
      screen.getByRole('button', { name: 'Delete projects' })
    ).toBeEnabled();
    expect(screen.getByText(/Your profile stays/)).toBeVisible();
    await user.click(within(scope).getByText('Profile'));
    expect(
      screen.getByRole('button', { name: 'Delete profile' })
    ).toBeEnabled();
    expect(screen.getByText(/Projects stay, owned anonymously/)).toBeVisible();
    await user.click(within(scope).getByText('Everything'));
    expect(
      screen.getByRole('button', { name: 'Delete all data' })
    ).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Delete projects' })
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Cloud deletion never touches it/)).toBeVisible();
  });

  it('keeps the storage meter in range when the account is over its allowance', async () => {
    vi.mocked(api.storageUsage).mockResolvedValue({
      ...storageUsage,
      artifactBytes: 120 * 1_048_576,
      storageBytes: 120 * 1_048_576
    });
    renderSettings(readyHealth, { initialSection: 'account', session });

    const meter = await screen.findByRole('meter', { name: 'Storage used' });
    const limit = String(storageUsage.storageLimitBytes);
    // The bar is full, never past full; the text says by how much.
    expect(meter).toHaveAttribute('aria-valuemax', limit);
    expect(meter).toHaveAttribute('aria-valuenow', limit);
    expect(meter).toHaveAttribute(
      'aria-valuetext',
      '120 MB of 100 MB · over allowance'
    );
    expect(screen.getByText('120 MB of 100 MB · over allowance')).toBeVisible();
  });

  it('shows one storage row: projects and files in one meter, with the breakdown', async () => {
    renderSettings(readyHealth, { initialSection: 'account', session });

    const meter = await screen.findByRole('meter', { name: 'Storage used' });
    expect(meter).toHaveAttribute(
      'aria-valuenow',
      String(5 * 1_048_576 + 3_072)
    );
    expect(meter).toHaveAttribute('aria-valuetext', '5 MB of 100 MB');
    expect(
      screen.getByText(
        'Projects 3 KB · Imports and exports 5 MB. 3 projects · 4 save states.'
      )
    ).toBeVisible();
    // The two allowances are gone.
    expect(screen.queryByText('Account storage')).not.toBeInTheDocument();
    expect(screen.queryByText('Cloud file storage')).not.toBeInTheDocument();
  });

  it('formats Premium membership limits and account storage readably', async () => {
    vi.mocked(api.storageUsage).mockResolvedValue({
      ...storageUsage,
      projectCount: 129,
      revisionCount: 0,
      documentLimitBytes: 24 * 1024 ** 2,
      maxRevisionsPerProject: 50,
      projectStorageBytes: 0,
      artifactBytes: 24 * 1024 ** 2,
      storageBytes: 24 * 1024 ** 2,
      storageLimitBytes: 100 * 1024 ** 3,
      artifactLimitBytes: 100 * 1024 ** 3
    });
    renderSettings(readyHealth, {
      initialSection: 'account',
      session: {
        ...session,
        entitlements: {
          tier: 'premium',
          projectLimit: 10_000,
          storageLimitBytes: 100 * 1024 ** 3,
          projectStorageLimitBytes: 100 * 1024 ** 3,
          artifactLimitBytes: 100 * 1024 ** 3,
          ai: {
            requestLimit: 500,
            costLimitUnits: 2400,
            windowSeconds: 600,
            concurrencyLimit: 8
          }
        }
      }
    });

    expect(
      screen.getByText(
        '10,000 cloud projects · 100 GB storage · 500 hosted AI requests per 10 minutes'
      )
    ).toBeVisible();
    expect(
      await screen.findByText(
        'Projects 0 B · Imports and exports 24 MB. 129 projects · 0 save states.'
      )
    ).toBeVisible();
    expect(screen.getByRole('meter', { name: 'Storage used' })).toHaveAttribute(
      'aria-valuetext',
      '24 MB of 100 GB'
    );
    expect(screen.getByText('24 MB of 100 GB')).toBeVisible();
  });

  it('names the membership allowance from an older server by its project storage', () => {
    renderSettings(readyHealth, {
      initialSection: 'account',
      session: {
        ...session,
        entitlements: {
          tier: 'free',
          projectLimit: 100,
          projectStorageLimitBytes: 1024 ** 3,
          artifactLimitBytes: 1024 ** 3,
          ai: {
            requestLimit: 6,
            costLimitUnits: 24,
            windowSeconds: 600,
            concurrencyLimit: 2
          }
        }
      }
    });
    expect(
      screen.getByText(
        '100 cloud projects · 1 GB storage · 6 hosted AI requests per 10 minutes'
      )
    ).toBeVisible();
  });

  it('groups large counts and says trashed projects still count', async () => {
    vi.mocked(api.storageUsage).mockResolvedValue({
      ...storageUsage,
      projectCount: 1_234,
      trashedProjectCount: 21,
      revisionCount: 12_345,
      maxRevisionsPerProject: 1_000
    });
    renderSettings(readyHealth, { initialSection: 'account', session });
    expect(
      await screen.findByText(
        'Projects 3 KB · Imports and exports 5 MB. 1,234 projects · 21 in trash · 12,345 save states.'
      )
    ).toBeVisible();
    // Trashed projects are still stored: the row says so, one click away.
    expect(screen.getByText('Trash counts toward storage')).toBeVisible();
  });

  it('states storage as the quota measures it, against a GB allowance', async () => {
    const gibibyte = 1_073_741_824;
    const projects = Math.round(24.8 * 1_048_576);
    // An older server: no combined figure or limit, only the parts.
    const { storageBytes, storageLimitBytes, ...older } = storageUsage;
    void storageBytes;
    void storageLimitBytes;
    vi.mocked(api.storageUsage).mockResolvedValue({
      ...older,
      // Logical sizes differ from stored ones; the quota counts stored bytes.
      documentBytes: 40 * 1_048_576,
      revisionBytes: 0,
      projectStorageBytes: projects,
      artifactLimitBytes: 25 * gibibyte,
      entitlements: {
        tier: 'premium',
        projectLimit: 10_000,
        projectStorageLimitBytes: 25 * gibibyte,
        artifactLimitBytes: 25 * gibibyte,
        ai: {
          requestLimit: 600,
          costLimitUnits: 2_400,
          windowSeconds: 600,
          concurrencyLimit: 8
        }
      }
    });
    renderSettings(readyHealth, { initialSection: 'account', session });

    // Large allowances read in GB, never as "25600.0 MB".
    const meter = await screen.findByRole('meter', { name: 'Storage used' });
    expect(meter).toHaveAttribute(
      'aria-valuenow',
      String(projects + 5 * 1_048_576)
    );
    expect(meter).toHaveAttribute('aria-valuemax', String(25 * gibibyte));
    expect(screen.getByText('29.8 MB of 25 GB')).toBeVisible();
    expect(
      screen.getByText(/^Projects 24\.8 MB · Imports and exports 5 MB\./)
    ).toBeVisible();
  });

  it('names an account storage overage outright', async () => {
    vi.mocked(api.storageUsage).mockResolvedValue({
      ...storageUsage,
      projectStorageBytes: 2 * 1_073_741_824,
      artifactBytes: 0,
      storageBytes: 2 * 1_073_741_824,
      storageLimitBytes: 1_073_741_824,
      entitlements: {
        tier: 'free',
        projectLimit: 100,
        storageLimitBytes: 1_073_741_824,
        projectStorageLimitBytes: 1_073_741_824,
        artifactLimitBytes: 1_073_741_824,
        ai: {
          requestLimit: 6,
          costLimitUnits: 24,
          windowSeconds: 600,
          concurrencyLimit: 2
        }
      }
    });
    renderSettings(readyHealth, { initialSection: 'account', session });

    expect(
      await screen.findByRole('meter', { name: 'Storage used' })
    ).toHaveAttribute('aria-valuetext', '2 GB of 1 GB · over allowance');
  });

  it('keeps the Account page usable when the storage report omits fields', async () => {
    // Older servers and the e2e stubs send only the document fields.
    vi.mocked(api.storageUsage).mockResolvedValue({
      projectCount: 0,
      documentBytes: 0,
      revisionBytes: 0,
      revisionCount: 0,
      documentLimitBytes: 1_500_000,
      maxRevisionsPerProject: 50
    } as unknown as typeof storageUsage);
    renderSettings(readyHealth, { initialSection: 'account', session });

    expect(
      await screen.findByText(
        'Projects 0 B · Imports and exports 0 B. 0 projects · 0 save states.'
      )
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Storage' })).toBeVisible();
  });

  it('names the diagnostic download for what it downloads', () => {
    renderSettings(readyHealth, { initialSection: 'privacy', session });

    expect(
      screen.getByRole('button', { name: 'Download diagnostic report' })
    ).toBeInTheDocument();
  });

  it('keeps the full analytics disclosure, local operations included', async () => {
    const user = userEvent.setup();
    renderSettings(readyHealth, { initialSection: 'privacy', session });

    await user.click(screen.getByText('What’s collected'));
    expect(
      screen.getByText(
        /Local operations are counted only with this switch on\./
      )
    ).toBeVisible();
    expect(
      screen.getByText(/this expanded scope requires a fresh choice\./)
    ).toBeVisible();
  });

  // I10 (13 November review): one paragraph of jargon became a plain list of
  // what is sent, what never is, and how to stop — every statement kept.
  it('says what analytics send, never send, and how to stop', async () => {
    const user = userEvent.setup();
    renderSettings(readyHealth, { initialSection: 'privacy', session });

    await user.click(screen.getByText('What’s collected'));
    const disclosure = screen.getByText('What’s collected').closest('details')!;
    for (const heading of ['Sent', 'Never sent', 'How to stop']) {
      expect(within(disclosure).getByText(heading)).toBeVisible();
    }
    // Glimpse is named, and said what it is.
    expect(disclosure).toHaveTextContent(
      'Glimpse, the usage-counting service OpenZCAD runs for itself'
    );
    for (const statement of [
      'feature categories, workflow steps and exports',
      'Diagnostic codes',
      'part count, project file size and transfer size',
      'Coarse timings',
      'Model contents or geometry',
      'File names or project names',
      'Anything that identifies you',
      'It is off until you turn it on.',
      'Turn it off here and sending stops at once.',
      'Do Not Track or Global Privacy Control',
      'turning off Cloud features, pauses sending and keeps this choice',
      'kept in this browser only, and separately for each app',
      'cannot be traced back to you or removed',
      'basic server counters measure API activity and reliability'
    ]) {
      expect(disclosure).toHaveTextContent(statement);
    }
    expect(
      within(disclosure).getByRole('link', { name: 'privacy policy' })
    ).toHaveAttribute('href', expect.stringContaining('/privacy'));
    // Wording only: the switch still starts off.
    expect(
      screen.getByRole('checkbox', { name: 'Optional usage analytics' })
    ).not.toBeChecked();
  });

  it('shows storage usage on Account, where the profile that owns it is', async () => {
    renderSettings(readyHealth, { initialSection: 'account', session });

    expect(await screen.findByText(/3 projects/)).toBeInTheDocument();
    expect(screen.getByText(/^5.* of 100/)).toBeInTheDocument();
    expect(api.storageUsage).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate destructive cloud actions on Account or Saving', async () => {
    const user = userEvent.setup();
    renderSettings(readyHealth, { initialSection: 'account', session });

    expect(
      screen.queryByRole('button', { name: 'Delete all data' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Saving' }));
    expect(
      screen.queryByRole('button', { name: 'Delete projects' })
    ).not.toBeInTheDocument();
  });

  it('requires the exact email before permanent deletion', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'accountDeletionPreview').mockResolvedValue({
      confirmationKind: 'email',
      confirmationText: 'person@example.com',
      projectCount: 2,
      documentBytes: 1_024,
      revisionBytes: 2_048,
      revisionCount: 5,
      collaboratorCount: 1
    });
    const onDeleteCloudData = vi.fn().mockResolvedValue(undefined);
    renderSettings(readyHealth, {
      initialSection: 'privacy',
      session,
      onDeleteCloudData
    });

    await user.click(
      within(
        screen.getByRole('radiogroup', { name: 'What to delete' })
      ).getByText('Everything')
    );
    await user.click(screen.getByRole('button', { name: 'Delete all data' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete all cloud data?'
    });
    const confirm = within(dialog).getByRole('button', {
      name: 'Delete all cloud data'
    });
    expect(confirm).toBeDisabled();
    expect(dialog.innerHTML).not.toContain(session.email);
    const confirmation = within(dialog).getByLabelText('Deletion confirmation');
    // Masked only while it is not being typed in (design review I78): the
    // field shows what is typed while focused and masks again on blur.
    act(() => confirmation.focus());
    expect(confirmation).toHaveAttribute('type', 'text');
    act(() => confirmation.blur());
    expect(confirmation).toHaveAttribute('type', 'password');
    await user.click(
      within(dialog).getByRole('button', { name: 'Show personal info' })
    );
    expect(within(dialog).getByText(session.email)).toBeVisible();
    expect(confirmation).toHaveAttribute('type', 'text');
    await user.click(
      within(dialog).getByRole('button', { name: session.email })
    );
    expect(dialog.innerHTML).not.toContain(session.email);
    expect(confirmation).toHaveAttribute('type', 'password');
    expect(
      within(dialog).getByText(/Local projects and settings/)
    ).toBeVisible();

    await user.type(
      within(dialog).getByLabelText('Deletion confirmation'),
      'PERSON@example.com'
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(onDeleteCloudData).toHaveBeenCalledWith('all', 'PERSON@example.com');
  });

  it('fails closed when the erasure migrations are not ready', () => {
    renderSettings(
      {
        ...readyHealth,
        accountErasureReady: false,
        projectErasureReady: false
      },
      { initialSection: 'privacy', session }
    );
    expect(
      screen.getByRole('button', { name: 'Delete projects' })
    ).toBeDisabled();
    expect(
      screen.getByText(/Cloud data deletion isn’t available on this server/)
    ).toBeVisible();
  });

  it('keeps profile deletion available when project object storage is unavailable', async () => {
    const user = userEvent.setup();
    renderSettings(
      {
        ...readyHealth,
        projectObjectStorageReady: false,
        projectErasureReady: false
      },
      { initialSection: 'privacy', session }
    );
    const scope = screen.getByRole('radiogroup', { name: 'What to delete' });
    expect(
      screen.getByRole('button', { name: 'Delete projects' })
    ).toBeDisabled();
    expect(
      screen.getByText(/Profile-only deletion remains available/)
    ).toBeVisible();
    await user.click(within(scope).getByText('Everything'));
    expect(
      screen.getByRole('button', { name: 'Delete all data' })
    ).toBeDisabled();
    await user.click(within(scope).getByText('Profile'));
    expect(
      screen.getByRole('button', { name: 'Delete profile' })
    ).toBeEnabled();
    // The notice is about projects, so it leaves with them.
    expect(
      screen.queryByText(/Profile-only deletion remains available/)
    ).not.toBeInTheDocument();
  });
});

describe('settings project invitation handoff', () => {
  it('keeps the pending link focused on account sign-in without exposing it', () => {
    renderSettings(null, {
      initialSection: 'account',
      projectInvitationPending: true,
      authConfigStatus: 'unavailable'
    });

    expect(screen.getByText(/Project invitation ready/)).toBeInTheDocument();
    expect(screen.queryByText(/invite=/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeEnabled();
  });
});

describe('settings page pattern', () => {
  it('shows a short choice whole, as one option per radio', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<ComponentProps<typeof SettingsPage>['onChange']>();
    renderSettings(null, { initialSection: 'appearance', onChange });

    const theme = screen.getByRole('radiogroup', { name: 'Theme' });
    const options = within(theme).getAllByRole('radio');
    expect(
      options.map((option) => option.closest('label')?.textContent)
    ).toEqual(['System', 'Light', 'Dark']);
    expect(within(theme).getByRole('radio', { name: 'System' })).toBeChecked();

    await user.click(within(theme).getByRole('radio', { name: 'Light' }));
    expect(onChange.mock.calls[0]?.[0].appearance.theme).toBe('light');
  });

  it('offers small, medium and large library cards, small first', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<ComponentProps<typeof SettingsPage>['onChange']>();
    renderSettings(null, { initialSection: 'appearance', onChange });

    const size = screen.getByRole('radiogroup', { name: 'Library card size' });
    expect(
      within(size)
        .getAllByRole('radio')
        .map((option) => option.closest('label')?.textContent)
    ).toEqual(['Small', 'Medium', 'Large']);
    expect(within(size).getByRole('radio', { name: 'Small' })).toBeChecked();
    await user.click(within(size).getByRole('radio', { name: 'Large' }));
    expect(onChange.mock.calls[0]?.[0].appearance.libraryCardSize).toBe(
      'large'
    );
  });

  it('offers Show, Faint and Hide for tangent edges, Faint by default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<ComponentProps<typeof SettingsPage>['onChange']>();
    renderSettings(null, { initialSection: 'viewport', onChange });

    const tangent = screen.getByRole('radiogroup', { name: 'Tangent edges' });
    expect(
      within(tangent)
        .getAllByRole('radio')
        .map((option) => option.closest('label')?.textContent)
    ).toEqual(['Show', 'Faint', 'Hide']);
    expect(within(tangent).getByRole('radio', { name: 'Faint' })).toBeChecked();
    await user.click(within(tangent).getByRole('radio', { name: 'Hide' }));
    expect(onChange.mock.calls[0]?.[0].viewport.tangentEdges).toBe('hide');
  });

  it('offers Free and Turntable orbiting under Controls, Free by default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<ComponentProps<typeof SettingsPage>['onChange']>();
    renderSettings(null, { initialSection: 'controls', onChange });

    const orbit = screen.getByRole('radiogroup', { name: 'Orbit' });
    expect(
      within(orbit)
        .getAllByRole('radio')
        .map((option) => option.closest('label')?.textContent)
    ).toEqual(['Free', 'Turntable']);
    expect(within(orbit).getByRole('radio', { name: 'Free' })).toBeChecked();
    await user.click(within(orbit).getByRole('radio', { name: 'Turntable' }));
    expect(onChange.mock.calls[0]?.[0].viewport.orbitMode).toBe('turntable');
  });

  it('finds the tangent edge setting by the words people use for it', async () => {
    const user = userEvent.setup();
    window.localStorage.clear();
    renderSettings();
    await user.type(screen.getByLabelText('Find a setting'), 'fillet');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'Viewport'
    );
    expect(
      screen.getByRole('radiogroup', { name: 'Tangent edges' })
    ).toBeVisible();
  });

  it('names an abbreviated unit in full for assistive technology', () => {
    renderSettings(null, { initialSection: 'general' });
    const units = screen.getByRole('radiogroup', { name: 'Default units' });
    expect(
      within(units).getByRole('radio', { name: 'Millimeters' })
    ).toBeChecked();
    expect(within(units).getByRole('radio', { name: 'Inches' })).toBeVisible();
  });

  /**
   * Settings had grown a paragraph under every row. Each row now carries at
   * most one short line; anything longer belongs behind a disclosure.
   */
  it('keeps every row hint to one short line on every page', async () => {
    const user = userEvent.setup();
    const { container } = renderSettings();
    const nav = screen.getByRole('complementary', {
      name: 'Settings sections'
    });
    const labels = within(nav)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
      .filter((label): label is string => Boolean(label));
    expect(labels.length).toBeGreaterThanOrEqual(10);

    for (const label of labels) {
      await user.click(within(nav).getByRole('button', { name: label }));
      const tooLong = [...container.querySelectorAll('.setting-copy > small')]
        .map((hint) => hint.textContent ?? '')
        .filter((hint) => hint.length === 0 || hint.length > 100);
      expect({ label, tooLong }).toEqual({ label, tooLong: [] });
    }
  });
});
