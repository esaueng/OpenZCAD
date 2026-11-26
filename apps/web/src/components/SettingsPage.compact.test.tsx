import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { AppSettings } from '@openzcad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppSettings } from '../lib/appSettings';
import { COMPACT_ENTRIES } from '../lib/actions/registry';
import { loadAssistantStatus } from '../lib/assistantStream';
import { updateSettingsViewState } from '../lib/settingsViewState';
import { SettingsPage } from './SettingsPage';

vi.mock('../lib/assistantStream', () => ({
  loadAssistantStatus: vi.fn()
}));

beforeEach(() => {
  vi.mocked(loadAssistantStatus).mockImplementation(
    () => new Promise(() => {})
  );
  // Each test starts on the list, with no search left from the last.
  updateSettingsViewState({ activeSection: 'general', query: '' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderCompact(
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {}
) {
  const props = {
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
