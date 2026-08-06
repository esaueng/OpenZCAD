import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { defaultAppSettings } from '../lib/appSettings';
import {
  KERNEL_BUILD,
  kernelBuildDetail,
  kernelBuildLabel
} from '../lib/kernelBuild';
import { toUserId, type HealthResponse } from '@openzcad/shared';
import { SettingsPage } from './SettingsPage';

function renderSettings(
  health: HealthResponse | null = null,
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {}
) {
  return render(
    <SettingsPage
      settings={defaultAppSettings()}
      accountState={null}
      authConfig={null}
      authConfigStatus="unavailable"
      health={health}
      session={null}
      busy={false}
      message=""
      onChange={vi.fn()}
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
      onReset={vi.fn()}
      onApplyViewportDefaults={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />
  );
}

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
    expect(value.textContent).toMatch(/^BrepKit /);
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
    expect(screen.getByText(/Migrations 0010 and 0011/)).toBeInTheDocument();
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
