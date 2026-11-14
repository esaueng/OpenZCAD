import { render, screen, within } from '@testing-library/react';
import { act, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  toUserId,
  type AppSettingsResponse,
  type AuthSession
} from '@openzcad/shared';
import { defaultAppSettings } from '../lib/appSettings';
import {
  ACCOUNT_SHAPE_HINT_STORAGE_KEY,
  loadAccountShapeHint,
  normalizeAccountShapeHint,
  rememberAccountShape
} from '../lib/accountShapeHint';
import * as availability from '../lib/e2ee/availability';
import { api } from '../lib/api';
import { SettingsPage } from './SettingsPage';

/**
 * A signed-in user reloading in Settings saw a signed-out page first: an
 * amber "checking" notice, then the email sign-in form, then their own
 * profile; the footer said "Device only"; Encryption was inserted into the
 * nav under the pointer; and Storage appeared late. While the saved session
 * is restoring, Settings draws the account's last known shape instead.
 */

const session: AuthSession = {
  userId: toUserId('user_restoring'),
  displayName: 'person',
  email: 'person@example.com',
  mode: 'email-code'
};

const accountState: AppSettingsResponse = {
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
};

const emailSignIn = {
  mode: 'email-code' as const,
  emailCodeEnabled: true,
  turnstileSiteKey: 'site-key'
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function settingsElement(
  overrides: Partial<ComponentProps<typeof SettingsPage>> = {}
) {
  return (
    <SettingsPage
      settings={defaultAppSettings()}
      cloudFunctionsEnabled={true}
      accountState={null}
      authConfig={emailSignIn}
      authConfigStatus="ready"
      health={null}
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

function navLabels(): string[] {
  const nav = screen.getByRole('complementary', { name: 'Settings sections' });
  return within(nav.querySelector('nav')!)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? '');
}

let turnstileScript: HTMLScriptElement;

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(availability, 'fetchEncryptionAvailability').mockResolvedValue(
    false
  );
  vi.spyOn(api, 'storageUsage').mockResolvedValue({
    projectCount: 3,
    documentBytes: 2_048,
    revisionBytes: 1_024,
    revisionCount: 4,
    projectStorageBytes: 3_072,
    documentLimitBytes: 10 * 1_048_576,
    maxRevisionsPerProject: 20,
    artifactBytes: 5 * 1_048_576,
    artifactCount: 2,
    artifactLimitBytes: 100 * 1_048_576
  });
  // Stands in for the loaded Turnstile script so a sign-in form, when one is
  // drawn, does not fetch it.
  Object.defineProperty(window, 'turnstile', {
    configurable: true,
    value: { render: vi.fn(() => 'widget-1'), remove: vi.fn(), reset: vi.fn() }
  });
  turnstileScript = document.createElement('script');
  turnstileScript.dataset.openzcadTurnstile = 'true';
  document.head.append(turnstileScript);
});

afterEach(() => {
  turnstileScript.remove();
  delete (window as Window & { turnstile?: unknown }).turnstile;
  vi.restoreAllMocks();
});

describe('Settings while a saved session is restoring', () => {
  it('draws the signed-in shape, not the sign-in form or "Device only"', async () => {
    rememberAccountShape({ signedIn: true });
    const view = render(
      settingsElement({ initialSection: 'account', accountResolving: true })
    );

    expect(screen.queryByLabelText('Email address')).toBeNull();
    expect(screen.queryByText('Email sign-in')).toBeNull();
    expect(screen.queryByText(/Checking whether sign-in/)).toBeNull();
    expect(screen.queryByText('Device only')).toBeNull();
    expect(screen.getByText('Checking account…')).toBeVisible();
    // The signed-in rows hold their place, inert until the session lands.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDisabled();
    expect(screen.getByText('Membership')).toBeVisible();
    // Storage reserves its rows rather than appearing once the session does.
    expect(screen.getByRole('heading', { name: 'Storage' })).toBeVisible();
    expect(
      screen.getByText(
        'Projects, save states, imports and exports saved to your account.'
      )
    ).toBeVisible();

    view.rerender(
      settingsElement({
        initialSection: 'account',
        accountResolving: false,
        session,
        accountState
      })
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Storage' })).toBeVisible();
    expect(screen.getByText('Cloud profile connected')).toBeVisible();
    expect(screen.getByText('Available')).toBeVisible();
    expect(
      await screen.findByRole('meter', { name: 'Storage used' })
    ).toBeVisible();
  });

  it('waits in a neutral tone on a device with no account history', () => {
    render(
      settingsElement({
        initialSection: 'account',
        accountResolving: true,
        authConfigStatus: 'loading',
        authConfig: null
      })
    );
    const waiting = screen.getByText('Checking your account…');
    expect(waiting.closest('.settings-notice')).toHaveClass('neutral');
    expect(waiting.closest('.settings-notice')).not.toHaveClass('warning');
    expect(screen.queryByLabelText('Email address')).toBeNull();
    expect(screen.queryByText('Device only')).toBeNull();
  });

  it('keeps the session rows, not "unavailable", while account settings load', () => {
    render(
      settingsElement({
        initialSection: 'account',
        accountResolving: true,
        session
      })
    );
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    expect(screen.queryByText('Cloud profile unavailable')).toBeNull();
    expect(screen.getByText('Checking account…')).toBeVisible();
  });

  it('still offers a signed-out user the sign-in form once that is known', () => {
    rememberAccountShape({ signedIn: true });
    const view = render(
      settingsElement({ initialSection: 'account', accountResolving: true })
    );
    expect(screen.queryByLabelText('Email address')).toBeNull();

    view.rerender(
      settingsElement({ initialSection: 'account', accountResolving: false })
    );
    expect(screen.getByLabelText('Email address')).toBeVisible();
    expect(screen.getAllByText('Device only')).toHaveLength(2);
    // Storage is a signed-in group; signed out there is nothing to measure.
    expect(screen.queryByRole('heading', { name: 'Storage' })).toBeNull();
  });

  it('keeps the unreachable-server Retry path', () => {
    render(
      settingsElement({
        initialSection: 'account',
        authConfigStatus: 'unavailable',
        authConfig: null
      })
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.getByText('Cloud unavailable')).toBeVisible();
  });

  it('does not offer the cloud saving controls before the account is known', () => {
    const view = render(
      settingsElement({ initialSection: 'saving', accountResolving: true })
    );
    expect(
      screen.getByRole('checkbox', { name: 'Cloud autosave' })
    ).toBeDisabled();
    expect(
      screen.getByRole('spinbutton', {
        name: 'Cloud autosave delay in seconds'
      })
    ).toBeDisabled();
    expect(screen.queryByText('Device only')).toBeNull();

    view.rerender(
      settingsElement({
        initialSection: 'saving',
        accountResolving: false,
        session,
        accountState
      })
    );
    expect(
      screen.getByRole('checkbox', { name: 'Cloud autosave' })
    ).toBeEnabled();
    expect(screen.getByText('Manual')).toBeVisible();
  });
});

describe('Settings navigation while encryption availability is pending', () => {
  it('holds the Encryption item where it last was through the answer', async () => {
    rememberAccountShape({ signedIn: true, encryption: true });
    const answer = deferred<boolean>();
    vi.spyOn(availability, 'fetchEncryptionAvailability').mockReturnValue(
      answer.promise
    );
    const view = render(settingsElement({ accountResolving: true }));
    const before = navLabels();
    expect(before).toContain('Encryption');

    view.rerender(
      settingsElement({ accountResolving: false, session, accountState })
    );
    expect(navLabels()).toEqual(before);

    await act(async () => answer.resolve(true));
    expect(navLabels()).toEqual(before);
  });

  it('never inserts Encryption for an account that did not have it', async () => {
    rememberAccountShape({ signedIn: true, encryption: false });
    const answer = deferred<boolean>();
    vi.spyOn(availability, 'fetchEncryptionAvailability').mockReturnValue(
      answer.promise
    );
    const view = render(settingsElement({ accountResolving: true }));
    const before = navLabels();
    expect(before).not.toContain('Encryption');

    view.rerender(
      settingsElement({ accountResolving: false, session, accountState })
    );
    await act(async () => answer.resolve(false));
    expect(navLabels()).toEqual(before);
  });

  it('remembers the answer for the next reload', async () => {
    rememberAccountShape({ signedIn: true });
    vi.spyOn(availability, 'fetchEncryptionAvailability').mockResolvedValue(
      true
    );
    render(settingsElement({ session, accountState }));
    await screen.findByRole('button', { name: 'Encryption' });
    expect(loadAccountShapeHint()).toEqual({
      signedIn: true,
      encryption: true
    });
  });
});

describe('account shape hint', () => {
  it('stores two booleans and nothing that identifies the account', () => {
    rememberAccountShape({ signedIn: true, encryption: true });
    expect(
      JSON.parse(window.localStorage.getItem(ACCOUNT_SHAPE_HINT_STORAGE_KEY)!)
    ).toEqual({ signedIn: true, encryption: true });
  });

  it('forgets encryption on sign-out and tolerates malformed storage', () => {
    rememberAccountShape({ signedIn: true, encryption: true });
    rememberAccountShape({ signedIn: false });
    expect(loadAccountShapeHint()).toEqual({
      signedIn: false,
      encryption: false
    });
    window.localStorage.setItem(ACCOUNT_SHAPE_HINT_STORAGE_KEY, '{oops');
    expect(loadAccountShapeHint()).toEqual({
      signedIn: false,
      encryption: false
    });
    expect(normalizeAccountShapeHint(['signedIn'])).toEqual({
      signedIn: false,
      encryption: false
    });
  });
});
