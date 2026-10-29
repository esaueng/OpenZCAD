import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
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
  documentLimitBytes: 10 * 1_048_576,
  maxRevisionsPerProject: 20,
  artifactBytes: 5 * 1_048_576,
  artifactCount: 2,
  artifactLimitBytes: 100 * 1_048_576
};

beforeEach(() => {
  vi.spyOn(api, 'storageUsage').mockResolvedValue(storageUsage);
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
  it('opens on the active section, not the brand button that closes it', () => {
    window.localStorage.clear();
    const onClose = vi.fn();
    renderSettings(null, { onClose });

    expect(screen.getByRole('button', { name: 'General' })).toHaveFocus();
  });

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
    renderSettings(null, {
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
    expect(screen.getByText('Not configured')).toBeVisible();
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

  it('does not assume a provider before deployment status is available', () => {
    renderSettings(null, { initialSection: 'assistant' });
    expect(screen.getByText(/Ask your deployment operator/)).toBeVisible();
    expect(screen.queryByText(/OpenRouter/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /data policies/ })
    ).not.toBeInTheDocument();
  });

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
    expect(screen.queryByText('Account storage')).not.toBeInTheDocument();
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
      expect.stringContaining('Keyboard'),
      expect.stringContaining('Fixed keys'),
      'Mouse & pointer'
    ]);
    expect(
      screen.getByRole('button', { name: 'Reset all shortcuts' })
    ).toBeDisabled();
    // The banner's guidance lives on beside the one header.
    expect(headers[1]).toHaveTextContent(/Paused while you type/);
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
   * Production QA UI-04: below 580px the field is hidden, so a filter typed
   * in a wider window left the rail on its matches with no way out.
   */
  it('offers a way out of an active filter that does not need the field', async () => {
    const user = userEvent.setup();
    // Start unfiltered: Settings restores the last search it was left on.
    window.localStorage.clear();
    renderSettings();
    const sectionsBefore = within(
      screen.getByRole('complementary', { name: 'Settings sections' })
    ).getAllByRole('button').length;
    expect(
      screen.queryByRole('button', { name: /^Clear the filter/ })
    ).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Find a setting'), 'snap');
    const clear = screen.getByRole('button', {
      name: 'Clear the filter “snap”'
    });
    await user.click(clear);

    expect(screen.getByLabelText('Find a setting')).toHaveValue('');
    expect(
      screen.queryByRole('button', { name: /^Clear the filter/ })
    ).not.toBeInTheDocument();
    expect(
      within(
        screen.getByRole('complementary', { name: 'Settings sections' })
      ).getAllByRole('button')
    ).toHaveLength(sectionsBefore);
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

  it('starts profile details hidden and keeps the choice when settings reopen', async () => {
    const user = userEvent.setup();
    const view = renderSettings(null, { initialSection: 'account', session });
    expect(view.container.innerHTML).not.toContain(session.email);
    expect(screen.getByText('Name hidden')).toBeVisible();
    expect(screen.getByText('Email hidden')).toBeVisible();
    // The label names the action and so carries the state; aria-pressed on
    // top of it announced "Hide personal info, pressed".
    const show = screen.getByRole('button', { name: 'Show personal info' });
    expect(show).not.toHaveAttribute('aria-pressed');
    await user.click(show);
    expect(screen.getByText(session.displayName)).toBeVisible();
    expect(screen.getByText(session.email)).toBeVisible();
    const hide = screen.getByRole('button', { name: 'Hide personal info' });
    expect(hide).not.toHaveAttribute('aria-pressed');
    await user.click(hide);
    expect(view.container.innerHTML).not.toContain(session.email);
    await user.click(
      screen.getByRole('button', { name: 'Show personal info' })
    );
    view.unmount();
    // The switch is session state shared with project sharing, not panel state.
    renderSettings(null, { initialSection: 'account', session });
    expect(screen.getByText(session.displayName)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Hide personal info' })
    ).toBeVisible();
  });

  it('keeps all cloud deletion functions together on Privacy & data', () => {
    renderSettings(readyHealth, { initialSection: 'privacy', session });

    expect(
      screen.getByRole('button', { name: 'Delete projects' })
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Delete profile' })
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Delete all data' })
    ).toBeEnabled();
    expect(screen.getByText(/cloud deletions below never touch/)).toBeVisible();
  });

  it('keeps the file meter in range when the account is over its allowance', async () => {
    vi.mocked(api.storageUsage).mockResolvedValue({
      ...storageUsage,
      artifactBytes: 120 * 1_048_576
    });
    renderSettings(readyHealth, { initialSection: 'account', session });

    const meter = await screen.findByRole('meter', {
      name: 'Cloud file storage used'
    });
    const limit = String(storageUsage.artifactLimitBytes);
    // The bar is full, never past full; the text says by how much.
    expect(meter).toHaveAttribute('aria-valuemax', limit);
    expect(meter).toHaveAttribute('aria-valuenow', limit);
    expect(meter).toHaveAttribute(
      'aria-valuetext',
      '120.0 MB of 100.0 MB · over allowance'
    );
    expect(
      screen.getByText('120.0 MB of 100.0 MB · over allowance')
    ).toBeVisible();
  });

  it('reports in-range file usage as it is', async () => {
    renderSettings(readyHealth, { initialSection: 'account', session });

    const meter = await screen.findByRole('meter', {
      name: 'Cloud file storage used'
    });
    expect(meter).toHaveAttribute('aria-valuenow', String(5 * 1_048_576));
    expect(meter).toHaveAttribute('aria-valuetext', '5.0 MB of 100.0 MB');
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
    expect(screen.getByText(/Local operations require opt-in\./)).toBeVisible();
    expect(
      screen.getByText(/This expanded scope requires a fresh choice\./)
    ).toBeVisible();
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
    expect(confirmation).toHaveAttribute('type', 'password');
    await user.click(
      within(dialog).getByRole('button', { name: 'Show personal info' })
    );
    expect(within(dialog).getByText(session.email)).toBeVisible();
    expect(confirmation).toHaveAttribute('type', 'text');
    await user.click(
      within(dialog).getByRole('button', { name: 'Hide personal info' })
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

  it('keeps profile deletion available when project object storage is unavailable', () => {
    renderSettings(
      {
        ...readyHealth,
        projectObjectStorageReady: false,
        projectErasureReady: false
      },
      { initialSection: 'privacy', session }
    );
    expect(
      screen.getByRole('button', { name: 'Delete projects' })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Delete all data' })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Delete profile' })
    ).toBeEnabled();
    expect(
      screen.getByText(/Profile-only deletion remains available/)
    ).toBeVisible();
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
