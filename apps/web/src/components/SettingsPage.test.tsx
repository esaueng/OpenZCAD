import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { defaultAppSettings } from '../lib/appSettings';
import {
  KERNEL_BUILD,
  kernelBuildDetail,
  kernelBuildLabel
} from '../lib/kernelBuild';
import type { HealthResponse } from '@openzcad/shared';
import { SettingsPage } from './SettingsPage';

function renderSettings(health: HealthResponse | null = null) {
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
      onLogout={vi.fn()}
      onReset={vi.fn()}
      onApplyViewportDefaults={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

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

  it('reports migration 0010 as not ready when the health check fails closed', async () => {
    const user = userEvent.setup();
    renderSettings({
      status: 'ok',
      environment: 'beta',
      time: '2026-08-03T12:00:00.000Z',
      documentStorageAccountingReady: false
    });

    await user.click(screen.getByRole('button', { name: 'Advanced' }));

    expect(screen.getByText('D1 storage migration')).toBeInTheDocument();
    expect(
      screen.getByText(/0010_document_storage_accounting/)
    ).toBeInTheDocument();
    expect(screen.getByText('Not ready')).toHaveClass(
      'settings-state',
      'warning'
    );
  });
});
