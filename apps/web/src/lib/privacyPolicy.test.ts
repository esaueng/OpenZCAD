import { afterEach, describe, expect, it } from 'vitest';
import { PRIVACY_POLICY_PATH, privacyPolicyHref } from './privacyPolicy';

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

describe('privacyPolicyHref', () => {
  it('links the page beside the app in a browser', () => {
    expect(privacyPolicyHref()).toBe(PRIVACY_POLICY_PATH);
    expect(PRIVACY_POLICY_PATH).toBe('/privacy');
  });

  it('links the hosted service’s page from the desktop app', () => {
    // The desktop app has no web origin; a relative link would leave the app.
    (window as TauriWindow).__TAURI_INTERNALS__ = {};
    expect(privacyPolicyHref()).toBe('https://zcad.app/privacy');
  });
});
