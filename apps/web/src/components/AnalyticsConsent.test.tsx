import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { hasAnalyticsConsent, setAnalyticsEnabled } from '../lib/analytics';
import { AnalyticsConsent } from './AnalyticsConsent';

afterEach(() => {
  setAnalyticsEnabled(false);
  vi.unstubAllGlobals();
});

it.each([{ doNotTrack: '1' }, { globalPrivacyControl: true }])(
  'allows revoking a stored grant under %j',
  (privacySignal) => {
    setAnalyticsEnabled(true);
    vi.stubGlobal('navigator', privacySignal);
    render(<AnalyticsConsent />);
    const consent = screen.getByRole('checkbox', {
      name: 'Optional usage analytics'
    });
    expect(consent).toBeChecked();
    fireEvent.click(consent);
    expect(consent).not.toBeChecked();
    expect(hasAnalyticsConsent()).toBe(false);
    expect(
      window.localStorage.getItem('openzcad.glimpse.consent.v1')
    ).toBeNull();
  }
);
