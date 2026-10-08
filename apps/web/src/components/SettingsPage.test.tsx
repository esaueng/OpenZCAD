import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { SettingsPage } from './SettingsPage';
import { api } from '../lib/api';

afterEach(() => {
  vi.restoreAllMocks();
});

function renderSettings(
  health: HealthResponse | null = null,
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {}
) {
  return render(
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

  it('clamps an out-of-range angle on blur to the value storage keeps', async () => {
    const user = userEvent.setup();
    const { latest } = renderStatefulSettings({ initialSection: 'sketching' });
    const angle = screen.getByLabelText('Angular snap increment');

    await user.clear(angle);
    await user.type(angle, '500');
    // Still being typed: shown as typed, never committed out of range.
    expect(angle).toHaveValue(500);
    expect(latest().sketching.angleSnap).toBeLessThanOrEqual(90);
    await user.tab();

    expect(angle).toHaveValue(90);
    expect(latest().sketching.angleSnap).toBe(90);
    // What the page shows is what a reload reads back, not the default.
    window.localStorage.clear();
    saveLocalAppSettings(latest());
    expect(loadLocalAppSettings().sketching.angleSnap).toBe(90);
  });

  it.each([
    { label: 'Sketch snap tolerance', key: 'snapTolerancePx', value: 4.5 },
    { label: 'Angular snap increment', key: 'angleSnap', value: 22.5 }
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
      screen.getByRole('button', { name: 'Back to workspace' })
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Apply defaults to current view' })
    ).toBeEnabled();
    view.unmount();

    renderSettings(null, { initialSection: 'viewport', workspaceOpen: false });
    expect(
      screen.getByRole('button', { name: 'Back to projects' })
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

describe('settings accessible names', () => {
  it('start each control name with its visible title', async () => {
    const user = userEvent.setup();
    const personal = defaultAppSettings();
    personal.assistant.credentialSource = 'personal';
    renderSettings(null, { settings: personal, initialSection: 'viewport' });

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
    expect(screen.queryByRole('button', { name: 'Account' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'AI Assistant' })).toBeNull();
    expect(
      screen.queryByRole('checkbox', { name: 'AI assistant' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Project sharing' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Files & autosave' }));
    expect(screen.getByText('Local autosave')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Cloud autosave' })
    ).toBeDisabled();
    expect(screen.getByText('Disabled')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'General' }));
    await user.click(screen.getByRole('checkbox', { name: 'Cloud features' }));
    expect(onCloudFunctionsEnabledChange).toHaveBeenCalledWith(true);
  });
});

describe('settings viewport copy', () => {
  it('describes navigation as desktop CAD does, without naming products', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole('button', { name: 'Viewport' }));
    expect(
      screen.getByText(
        /toward whatever is under the cursor, as desktop CAD does/
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/Pan matches desktop CAD;/)).toBeInTheDocument();
  });
});

describe('settings shortcuts section', () => {
  it('opens on one keyboard header, not a banner stacked above it', async () => {
    const user = userEvent.setup();
    const { container } = renderSettings();

    await user.click(screen.getByRole('button', { name: 'Shortcuts' }));

    expect(screen.queryByText('Shortcuts are fixed and context-aware.')).toBe(
      null
    );
    const headers = container.querySelectorAll(
      '.settings-control-collection > header'
    );
    expect([...headers].map((header) => header.textContent)).toEqual([
      expect.stringContaining('Keyboard'),
      expect.stringContaining('Mouse & pointer')
    ]);
    // The banner's guidance lives on in the one header.
    expect(headers[0]).toHaveTextContent(/pause while you type/);
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
    expect(
      screen.getByText(/ready to store your projects before they can sync/)
    ).toBeInTheDocument();
    expect(screen.getByText('Not ready')).toHaveClass(
      'settings-state',
      'warning'
    );
  });
});

describe('settings desktop account section', () => {
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
    expect(screen.getByText(/cloud actions below never touch/)).toBeVisible();
  });

  it('does not duplicate destructive cloud actions on Account or Files & autosave', async () => {
    const user = userEvent.setup();
    renderSettings(readyHealth, { initialSection: 'account', session });

    expect(
      screen.queryByRole('button', { name: 'Delete all data' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Files & autosave' }));
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
