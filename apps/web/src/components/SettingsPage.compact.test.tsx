import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { toUserId, type AppSettings } from '@openzcad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppSettings } from '../lib/appSettings';
import { COMPACT_ENTRIES } from '../lib/actions/registry';
import { loadAssistantStatus } from '../lib/assistantStream';
import {
  loadSettingsViewState,
  updateSettingsViewState
} from '../lib/settingsViewState';
import { SettingsPage } from './SettingsPage';

vi.mock('../lib/assistantStream', () => ({
  loadAssistantStatus: vi.fn()
}));

beforeEach(() => {
  vi.mocked(loadAssistantStatus).mockImplementation(
    () => new Promise(() => {})
  );
  // Each test starts on the list, with no search left from the last.
  updateSettingsViewState({
    activeSection: 'general',
    query: '',
    sectionRequested: false
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function compactProps(
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {}
) {
  return {
    compact: true,
    settings: defaultAppSettings(),
    cloudFunctionsEnabled: true,
    accountState: null,
    authConfig: null,
    authConfigStatus: 'unavailable' as const,
    health: null,
    session: null,
    busy: false,
    message: '',
    onChange: vi.fn(),
    onCloudFunctionsEnabledChange: vi.fn(),
    onSaveCredential: vi.fn(),
    onDeleteCredential: vi.fn(),
    onTestAssistant: vi.fn(),
    onRequestLoginCode: vi.fn(),
    onVerifyLoginCode: vi.fn(),
    onRefreshAuthConfig: vi.fn(),
    onStartDesktopLogin: vi.fn(),
    onDesktopAuthorizationCodeChange: vi.fn(),
    onApproveDesktopLogin: vi.fn(),
    onLogout: vi.fn(),
    onDeleteCloudData: vi.fn(),
    onReset: vi.fn(),
    onApplyViewportDefaults: vi.fn(),
    onExportDiagnostics: vi.fn(),
    onExportInteractionLog: vi.fn(),
    onDismissProjectInvitation: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  };
}

function renderCompact(
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {}
) {
  const props = compactProps(overrides);
  const view = render(<SettingsPage {...props} />);
  return { ...view, props };
}

const page = () => document.querySelector<HTMLElement>('.settings-page')!;

describe('compact Settings', () => {
  it('opens on the list of sections under the search', () => {
    renderCompact();
    expect(page()).toHaveAttribute('data-shell', 'compact');
    expect(page()).toHaveClass('is-compact-list');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
    expect(screen.getByLabelText('Find a setting')).toBeInTheDocument();
    const sections = within(
      screen.getByRole('complementary', { name: 'Settings sections' })
    );
    for (const name of ['General', 'Appearance', 'Advanced']) {
      expect(sections.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('pushes a section full-screen with a way back to the list', () => {
    const onChange = vi.fn<(next: AppSettings) => void>();
    const { props } = renderCompact({ onChange });
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(page()).toHaveClass('is-compact-section');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Appearance'
    );
    // The existing controls, unchanged.
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole(
        'radio',
        { name: 'Dark' }
      )
    );
    expect(onChange.mock.lastCall?.[0].appearance.theme).toBe('dark');
    fireEvent.click(
      screen.getByRole('button', { name: 'Back to all settings' })
    );
    expect(page()).toHaveClass('is-compact-list');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('moves focus to a pushed section’s heading, and back to its row', () => {
    renderCompact();
    const row = screen.getByRole('button', { name: 'Appearance' });
    row.focus();
    fireEvent.click(row);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Appearance');
    expect(heading).toHaveFocus();
    fireEvent.click(
      screen.getByRole('button', { name: 'Back to all settings' })
    );
    expect(page()).toHaveClass('is-compact-list');
    expect(screen.getByRole('button', { name: 'Appearance' })).toHaveFocus();

    // Escape steps back to the same row, and a search result's section
    // takes focus to its heading too.
    fireEvent.click(screen.getByRole('button', { name: 'Viewport' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Viewport' })).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Find a setting'), {
      target: { value: 'Theme' }
    });
    fireEvent.click(
      within(
        screen.getByRole('list', { name: 'Matching settings' })
      ).getByRole('button', { name: /^Theme/ })
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Appearance'
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('steps back from a section on Escape before closing', () => {
    const { props } = renderCompact();
    fireEvent.click(screen.getByRole('button', { name: 'Viewport' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(page()).toHaveClass('is-compact-list');
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('finds a setting by its name and opens its section', () => {
    renderCompact();
    fireEvent.change(screen.getByLabelText('Find a setting'), {
      target: { value: 'theme' }
    });
    expect(page()).toHaveClass('is-compact-search');
    const results = within(
      screen.getByRole('list', { name: 'Matching settings' })
    );
    // The section's content shows under the results, as a search does on
    // the regular page.
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
    fireEvent.click(results.getByRole('button', { name: /^Theme/ }));
    expect(page()).toHaveClass('is-compact-section');
    expect(screen.getByLabelText('Find a setting')).toHaveValue('');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Appearance'
    );
  });

  // Account storage and Sign in to share on the project sheet, an
  // invitation or a device-approval link: each stores the section it wants.
  it('opens on the requested Account section, not the list', () => {
    // What openSettingsAt('account') stores.
    updateSettingsViewState({
      open: true,
      activeSection: 'account',
      query: '',
      scrollTop: 0
    });
    renderCompact();
    expect(page()).toHaveClass('is-compact-section');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Account'
    );
  });

  it('opens a return visit on the list, and a reload where it was', () => {
    // What openSettings() stores: no section asked for.
    updateSettingsViewState({ open: true, sectionRequested: false });
    const first = renderCompact();
    expect(page()).toHaveClass('is-compact-list');
    fireEvent.click(screen.getByRole('button', { name: 'Viewport' }));
    expect(loadSettingsViewState()).toMatchObject({
      activeSection: 'viewport',
      sectionRequested: true
    });
    first.unmount();
    // A reload with the section open comes back to it.
    renderCompact();
    expect(page()).toHaveClass('is-compact-section');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Viewport'
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Back to all settings' })
    );
    expect(loadSettingsViewState().sectionRequested).toBeUndefined();
  });

  it('keeps a search result’s section open across a reload', () => {
    const first = renderCompact();
    fireEvent.change(screen.getByLabelText('Find a setting'), {
      target: { value: 'reduce motion' }
    });
    fireEvent.click(
      within(screen.getByRole('list', { name: 'Matching settings' })).getByRole(
        'button',
        { name: /^Reduce motion/ }
      )
    );
    expect(page()).toHaveClass('is-compact-section');
    first.unmount();
    renderCompact();
    expect(page()).toHaveClass('is-compact-section');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Appearance'
    );
  });

  it('lists only settings its section draws for this account', () => {
    const search = (query: string) => {
      fireEvent.change(screen.getByLabelText('Find a setting'), {
        target: { value: query }
      });
      return screen.queryByRole('list', { name: 'Matching settings' });
    };
    // Signed out, Account draws no storage meter or membership.
    const signedOut = renderCompact();
    for (const query of ['Storage', 'Membership']) {
      const results = search(query);
      expect(
        results &&
          within(results).queryByRole('button', {
            name: new RegExp(`^${query}`)
          })
      ).toBeFalsy();
    }
    // Its signed-out row is listed.
    expect(
      within(search('Cloud data')!).getByRole('button', {
        name: /^Cloud data/
      })
    ).toBeInTheDocument();
    signedOut.unmount();

    renderCompact({
      session: {
        userId: toUserId('user_compact'),
        displayName: 'person',
        mode: 'email-code'
      }
    });
    expect(
      within(search('Storage')!).getByRole('button', { name: /^Storage/ })
    ).toBeInTheDocument();
    const results = search('Cloud data');
    expect(
      results && within(results).queryByRole('button', { name: /^Cloud data/ })
    ).toBeFalsy();
  });

  // PR #2219 review: a search left in Settings hid the section a
  // device-approval or invitation link opened it on, since compact Settings
  // shows a search's results before any section.
  it('opens a linked section after a search was left and Settings closed', () => {
    const { props, unmount } = renderCompact();
    fireEvent.change(screen.getByLabelText('Find a setting'), {
      target: { value: 'appearance' }
    });
    expect(page()).toHaveClass('is-compact-search');
    fireEvent.click(screen.getByRole('button', { name: /^Close settings/ }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    // Closing leaves no search for the next visit.
    expect(loadSettingsViewState().query).toBe('');
    unmount();
    expect(loadSettingsViewState().query).toBe('');
    // What a device-approval or invitation link stores.
    updateSettingsViewState({ open: true, activeSection: 'account' });
    renderCompact();
    expect(page()).toHaveClass('is-compact-section');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Account'
    );
    expect(screen.getByLabelText('Find a setting')).toHaveValue('');
  });

  it('opens a linked section over a search a reload left behind', () => {
    // Settings unmounted with a search, as a reload leaves it.
    const first = renderCompact();
    fireEvent.change(screen.getByLabelText('Find a setting'), {
      target: { value: 'appearance' }
    });
    first.unmount();
    expect(loadSettingsViewState().query).toBe('appearance');
    updateSettingsViewState({ open: true, activeSection: 'account' });
    renderCompact();
    expect(page()).toHaveClass('is-compact-section');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Account'
    );
  });

  // PR #2219 review: opened at the regular width and narrowed to compact on
  // its list, a reload came back on a section, because the page-hide save
  // still read the layout Settings had opened in.
  it('saves the list for a reload after a resize to compact', () => {
    updateSettingsViewState({ open: true, sectionRequested: false });
    const props = compactProps({ compact: false });
    const view = render(<SettingsPage {...props} />);
    view.rerender(<SettingsPage {...props} compact />);
    expect(page()).toHaveClass('is-compact-list');
    window.dispatchEvent(new Event('pagehide'));
    expect(loadSettingsViewState().sectionRequested).toBeUndefined();
    view.unmount();
    expect(loadSettingsViewState().sectionRequested).toBeUndefined();
    renderCompact();
    expect(page()).toHaveClass('is-compact-list');
  });

  // PR #2219 review: a refused email code was read twice, by the field's
  // alert and by the header's line, which compact Settings shows.
  it('announces a refused sign-in code once, and keeps it shown', async () => {
    const refused = 'That sign-in code is invalid.';
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
    // The page's status line as App writes it: verifying, then the error,
    // before the promise Settings waits on rejects.
    function Harness() {
      const [message, setMessage] = useState('');
      return (
        <SettingsPage
          {...compactProps({
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
            onVerifyLoginCode: async () => {
              setMessage('Verifying sign-in code…');
              await Promise.resolve();
              setMessage(refused);
              throw new Error(refused);
            }
          })}
          message={message}
        />
      );
    }
    try {
      render(<Harness />);
      fireEvent.change(screen.getByLabelText('Email address'), {
        target: { value: 'person@example.com' }
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'Email me a code' })
        );
      });
      const codeField = await screen.findByLabelText('Email sign-in code');
      fireEvent.change(codeField, { target: { value: '123456' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      });
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(refused)
      );
      const live = [
        ...document.querySelectorAll<HTMLElement>(
          '[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"], [role="log"]'
        )
      ].filter((element) => element.textContent?.includes(refused));
      expect(live).toHaveLength(1);
      expect(live[0]).toHaveAttribute('role', 'alert');
      expect(live[0]).toBeVisible();
      // The header's line still shows it.
      expect(
        document.querySelector('.settings-head .settings-save-message')
      ).toHaveTextContent(refused);
      // Typing a new code does not read the header's line out again.
      fireEvent.change(codeField, { target: { value: '1' } });
      expect(
        document.querySelector('.settings-head .settings-save-message')
      ).toHaveTextContent(refused);
    } finally {
      script.remove();
      delete (window as Window & { turnstile?: unknown }).turnstile;
    }
  });

  // PR #2219 review: search listed rows the section does not draw now.
  it('finds nothing for a row its section does not draw now', () => {
    const search = (query: string) => {
      fireEvent.change(screen.getByLabelText('Find a setting'), {
        target: { value: query }
      });
      return screen.queryByRole('list', { name: 'Matching settings' });
    };
    // Signed out, Account draws no Membership: no result, not even Account.
    const signedOut = renderCompact();
    expect(search('Membership')).toBeNull();
    expect(screen.getByText(/No settings match/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Account' })).toBeNull();
    signedOut.unmount();

    // A personal OpenAI key: no API endpoint, which only a
    // Responses-compatible provider asks for.
    const openai = defaultAppSettings();
    openai.assistant.credentialSource = 'personal';
    openai.assistant.provider = 'openai';
    const withOpenai = renderCompact({ settings: openai });
    const none = search('API endpoint');
    expect(
      none && within(none).queryByRole('button', { name: /^API endpoint/ })
    ).toBeFalsy();
    // Its other personal rows are found.
    expect(
      within(search('Provider')!).getByRole('button', { name: /^Provider/ })
    ).toBeInTheDocument();
    withOpenai.unmount();

    const compatible = defaultAppSettings();
    compatible.assistant.credentialSource = 'personal';
    compatible.assistant.provider = 'responses-compatible';
    renderCompact({ settings: compatible });
    expect(
      within(search('API endpoint')!).getByRole('button', {
        name: /^API endpoint/
      })
    ).toBeInTheDocument();
  });

  it('keeps the live region announced and shown in a section', () => {
    const { rerender, props } = renderCompact();
    fireEvent.click(screen.getByRole('button', { name: 'AI Assistant' }));
    const error = 'The provider refused the API key.';
    rerender(<SettingsPage {...props} message={error} />);
    const region = screen.getByText(error);
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region.closest('[aria-hidden="true"]')).toBeNull();
    expect(region).toBeVisible();
    // The compact stylesheet never takes it off the screen or out of the
    // accessibility tree; it only hides it while empty.
    const css = readFileSync(
      resolve(__dirname, '../styles/components/compact-surfaces.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [
      ...css.matchAll(/([^{}]*settings-save-message[^{}]*)\{([^}]*)\}/g)
    ];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      if (selector!.includes(':empty')) continue;
      expect(body).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    }
  });

  it('leaves the regular page as it was without the compact prop', () => {
    renderCompact({ compact: false });
    expect(page()).not.toHaveAttribute('data-shell');
    expect(page().className).not.toMatch(/is-compact/);
    expect(
      screen.queryByRole('button', { name: 'Back to all settings' })
    ).toBeNull();
  });

  // Slice 10's registry entries in Settings › Advanced, by taps alone.
  for (const [id, label, handler] of [
    ['file-export-diagnostics', 'Export diagnostics', 'onExportDiagnostics'],
    [
      'file-export-interaction-log',
      'Export interaction log',
      'onExportInteractionLog'
    ]
  ] as const) {
    it(`reaches ${id} (${COMPACT_ENTRIES[id]}) by taps`, () => {
      expect(COMPACT_ENTRIES[id]).toBe('settings');
      const { props } = renderCompact({ workspaceOpen: true });
      fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(props[handler]).toHaveBeenCalledTimes(1);
    });
  }
});
