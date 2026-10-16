import { cloudFunctionsAreEnabled, cloudRequestSignal } from '../lib/cloudMode';
import { isDesktopApp } from '../lib/desktopBridge';
import { useEffect, useState } from 'react';
import {
  hasAnalyticsConsent,
  setAnalyticsEnabled,
  downloadDiagnosticReport
} from '../lib/analytics';
export function AnalyticsConsent() {
  const [enabled, setEnabled] = useState(hasAnalyticsConsent);
  const [error, setError] = useState('');
  useEffect(() => {
    const update = () => setEnabled(hasAnalyticsConsent());
    window.addEventListener('glimpse-consent-changed', update);
    return () => window.removeEventListener('glimpse-consent-changed', update);
  }, []);
  return (
    <div className="settings-analytics-consent">
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            const saved = setAnalyticsEnabled(event.currentTarget.checked);
            setEnabled(hasAnalyticsConsent());
            setError(
              saved
                ? ''
                : 'Could not save this choice. Analytics are off in this page; clear this site’s stored data if withdrawal cannot be saved.'
            );
          }}
        />{' '}
        Optional usage analytics
      </label>
      <p>
        <button
          type="button"
          className="secondary"
          disabled={!enabled}
          onClick={downloadDiagnosticReport}
        >
          Download diagnostic report
        </button>
      </p>
      <p>
        Report contains only allowlisted counts from this page since opt-in.
        Review the JSON before sharing it yourself. No automatic upload.
      </p>
      {error && <p role="status">{error}</p>}
    </div>
  );
}

// This is an account-wide grant, separate from the browser-only choice above.
// It is never inferred from sign-in, old analytics preferences or another app.
export function CloudStatisticsConsent({ accountKey }: { accountKey: string }) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(
    'Loading account statistics permission…'
  );
  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    if (isDesktopApp() || !cloudFunctionsAreEnabled()) {
      setStatus('Enable cloud features to manage the account permission.');
      return () => controller.abort();
    }
    void fetch('/api/glimpse/account-consent', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: cloudRequestSignal(controller.signal)
    })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json() as Promise<{
          enabled: boolean;
          expiresAt: string | null;
        }>;
      })
      .then((v) => {
        setEnabled(v.enabled);
        setReady(true);
        setStatus(
          v.enabled
            ? `Enabled until ${v.expiresAt?.slice(0, 10)} UTC.`
            : 'Off. No cloud-account statistics are collected.'
        );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setStatus('Account statistics are unavailable.');
      });
    return () => controller.abort();
  }, [accountKey]);
  async function change(checked: boolean) {
    setBusy(true);
    try {
      if (isDesktopApp() || !cloudFunctionsAreEnabled())
        throw new Error('Cloud unavailable');
      const r = await fetch('/api/glimpse/account-consent', {
        method: 'POST',
        signal: cloudRequestSignal(),
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked, version: 2 })
      });
      if (!r.ok) throw new Error();
      const v = (await r.json()) as {
        enabled: boolean;
        expiresAt: string | null;
      };
      setEnabled(v.enabled);
      setStatus(
        v.enabled
          ? `Enabled until ${v.expiresAt?.slice(0, 10)} UTC.`
          : 'Withdrawn. Future cloud snapshots exclude this account.'
      );
    } catch {
      setStatus(
        'Could not confirm this change. Refresh to check the server permission before trying again.'
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-analytics-consent">
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!ready || busy}
          onChange={(e) => {
            void change(e.currentTarget.checked);
          }}
        />{' '}
        Cloud account statistics for 30 days
      </label>
      <p role="status">{status}</p>
    </div>
  );
}
