import { cloudFunctionsAreEnabled, cloudRequestSignal } from '../lib/cloudMode';
import { isDesktopApp } from '../lib/desktopBridge';
import { useEffect, useState } from 'react';
import { SettingRow, Status, Toggle } from './settingsControls';
import {
  hasAnalyticsConsent,
  setAnalyticsEnabled,
  downloadDiagnosticReport
} from '../lib/analytics';
// One row per title whichever app renders it: the desktop app explains the
// web-only choice in the same row rather than a second "Usage analytics".
export function AnalyticsConsent() {
  const desktop = isDesktopApp();
  const [enabled, setEnabled] = useState(hasAnalyticsConsent);
  const [error, setError] = useState('');
  useEffect(() => {
    const update = () => setEnabled(hasAnalyticsConsent());
    window.addEventListener('glimpse-consent-changed', update);
    return () => window.removeEventListener('glimpse-consent-changed', update);
  }, []);
  return (
    <>
      <SettingRow
        title="Usage analytics"
        hint={
          desktop ? (
            'Available in the web browser. This desktop app does not send usage events.'
          ) : error ? (
            <span role="status">{error}</span>
          ) : (
            'Anonymous feature counts. Never geometry, names, or identity.'
          )
        }
        details={
          desktop
            ? undefined
            : {
                summary: 'What’s collected',
                body: 'Feature categories, workflow steps, exports, diagnostic codes, part-count and project-file-size ranges, transfer-size ranges, and coarse timings. No model contents, geometry, filenames, project names or identity. Off by default; this expanded scope requires a fresh choice. DNT/GPC and turning off cloud features suppress sending while preserving this choice; withdraw here to stop sending immediately. Existing anonymous totals cannot be attributed or removed. Basic server counters measure API activity and reliability. This browser-only choice is separate for each app.'
              }
        }
      >
        {desktop ? (
          <Status>Web only</Status>
        ) : (
          <Toggle
            checked={enabled}
            label="Optional usage analytics"
            onChange={(checked) => {
              const saved = setAnalyticsEnabled(checked);
              setEnabled(hasAnalyticsConsent());
              setError(
                saved
                  ? ''
                  : 'Could not save this choice. Analytics are off in this page; clear this site’s stored data if withdrawal cannot be saved.'
              );
            }}
          />
        )}
      </SettingRow>
      {desktop ? null : (
        <SettingRow
          title="Diagnostic report"
          hint="Counts from this page since opt-in, as JSON. Never uploaded."
        >
          <button
            type="button"
            className="secondary"
            disabled={!enabled}
            onClick={downloadDiagnosticReport}
          >
            Download
          </button>
        </SettingRow>
      )}
    </>
  );
}

// This is an account-wide grant, separate from the browser-only choice above.
// It is never inferred from sign-in, old analytics preferences or another app.
export function CloudStatisticsConsent({
  accountKey,
  cloudEnabled
}: {
  accountKey: string;
  /** The device's cloud switch; while off the row explains the way back. */
  cloudEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(
    'Loading account statistics permission…'
  );
  useEffect(() => {
    const controller = new AbortController();
    setReady(false);
    if (isDesktopApp() || !cloudEnabled || !cloudFunctionsAreEnabled()) {
      setStatus(
        'Turn on cloud features to manage this. An existing grant lasts until withdrawn or 30 days.'
      );
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
  }, [accountKey, cloudEnabled]);
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
    <SettingRow
      title="Cloud account statistics"
      hint={<span role="status">{status}</span>}
      details={{
        summary: 'What’s shared',
        body: 'Hourly aggregate account, owned-project, revision and known storage-byte snapshots for 30 days, across your devices. Only opted-in accounts are included and no account or project identifiers leave OpenZCAD. Includes retained trash and storage metadata, never model contents. Withdraw here at any time; published aggregates remain up to 90 days. This account-wide permission is separate from browser DNT/GPC and this device’s cloud switch.'
      }}
    >
      <Toggle
        checked={enabled}
        disabled={!ready || busy}
        label="Cloud account statistics for 30 days"
        onChange={(checked) => {
          void change(checked);
        }}
      />
    </SettingRow>
  );
}
