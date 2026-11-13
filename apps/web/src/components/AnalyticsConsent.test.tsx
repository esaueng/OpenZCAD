import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasAnalyticsConsent, setAnalyticsEnabled } from '../lib/analytics';
import { ACCOUNT_STATISTICS_VERSION } from '../lib/glimpseContract';
import {
  ACCOUNT_STATISTICS_TEXT,
  AnalyticsConsent,
  CloudStatisticsConsent
} from './AnalyticsConsent';

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

describe('Cloud account statistics permission', () => {
  const expiresAt = '2026-12-13T00:00:00.000Z';
  function serve(version: number | null, enabled = true) {
    const calls: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body as string) as { enabled: boolean };
          calls.push(body);
          return Response.json({
            enabled: body.enabled,
            expiresAt: body.enabled ? expiresAt : null,
            version: body.enabled ? ACCOUNT_STATISTICS_VERSION : null
          });
        }
        return Response.json({
          enabled,
          expiresAt: enabled ? expiresAt : null,
          version
        });
      })
    );
    return calls;
  }

  it('names save activity in the permission text', () => {
    expect(ACCOUNT_STATISTICS_VERSION).toBe(3);
    expect(ACCOUNT_STATISTICS_TEXT).toMatch(
      /saved a project in the last 7 and 30 days/
    );
    expect(ACCOUNT_STATISTICS_TEXT).toMatch(/90 days or more/);
    expect(ACCOUNT_STATISTICS_TEXT).toMatch(
      /fewer than 5 accounts is withheld/
    );
  });

  it('says an earlier grant covers totals only, and grants the current version', async () => {
    const calls = serve(2);
    render(<CloudStatisticsConsent accountKey="a" cloudEnabled />);
    expect(
      await screen.findByText(/Totals only, under the earlier description/)
    ).toBeTruthy();
    const consent = screen.getByRole('checkbox', {
      name: 'Cloud account statistics for 30 days'
    });
    fireEvent.click(consent);
    expect(
      await screen.findByText(
        'Withdrawn. Future cloud snapshots exclude this account.'
      )
    ).toBeTruthy();
    fireEvent.click(consent);
    expect(
      await screen.findByText(`Enabled until ${expiresAt.slice(0, 10)} UTC.`)
    ).toBeTruthy();
    expect(calls).toEqual([
      { enabled: false, version: ACCOUNT_STATISTICS_VERSION },
      { enabled: true, version: ACCOUNT_STATISTICS_VERSION }
    ]);
  });

  it('shows a current grant without the renewal note', async () => {
    serve(ACCOUNT_STATISTICS_VERSION);
    render(<CloudStatisticsConsent accountKey="a" cloudEnabled />);
    expect(
      await screen.findByText(`Enabled until ${expiresAt.slice(0, 10)} UTC.`)
    ).toBeTruthy();
  });
});
