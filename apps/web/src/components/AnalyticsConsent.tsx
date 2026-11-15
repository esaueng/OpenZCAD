import { cloudFunctionsAreEnabled, cloudRequestSignal } from '../lib/cloudMode';
import { isDesktopApp } from '../lib/desktopBridge';
import { useEffect, useState } from 'react';
import { SettingRow, Status, Toggle } from './settingsControls';
import {
  hasAnalyticsConsent,
  setAnalyticsEnabled,
  downloadDiagnosticReport
} from '../lib/analytics';
import { ACCOUNT_STATISTICS_VERSION } from '../lib/glimpseContract';
import { privacyPolicyHref } from '../lib/privacyPolicy';
import { ExternalAnchor } from './ExternalAnchor';

/**
 * The Cloud account statistics permission text, version
 * {@link ACCOUNT_STATISTICS_VERSION}. Version 3 added save activity; a grant
 * of the version 2 text keeps covering totals only until it expires.
 */
export const ACCOUNT_STATISTICS_TEXT =
  'Separately allow hourly aggregate snapshots for 30 days, across your devices: account, owned-project, revision and known storage-byte totals, and how many accounts saved a project in the last 7 and 30 days or have not saved one for 90 days or more. Only opted-in accounts are included, and an activity count that would describe fewer than 5 accounts is withheld. No account or project identifiers or save dates leave OpenZCAD. Includes retained trash and storage metadata, never model contents. Withdraw here at any time; published aggregates remain up to 90 days. This account-wide permission is separate from browser DNT/GPC and this device’s cloud switch.';

function grantStatus(v: {
  enabled: boolean;
  expiresAt: string | null;
  version?: number | null;
}): string {
  const until = `Enabled until ${v.expiresAt?.slice(0, 10)} UTC.`;
  // An older grant accepted text without save activity: it stays limited to
  // totals, and saying so asks for a fresh choice instead of assuming one.
  return typeof v.version === 'number' && v.version < ACCOUNT_STATISTICS_VERSION
    ? `${until} Totals only, under the earlier description without save activity. Turn this off and on to accept the current description.`
    : until;
}
/**
 * The browser analytics disclosure: the approved consent text, reworded as
 * what is sent, what never is, and how to stop. Every statement of the
 * earlier paragraph is here, and the scope is unchanged, so the saved
 * `granted-v2` choice still answers it. Glimpse is OpenZCAD's own counting
 * service (docs/glimpse.md); it is named so the policy's word matches.
 */
function AnalyticsDisclosure() {
  return (
    <div className="analytics-disclosure">
      <p>
        When this is on, this browser sends anonymous counts to Glimpse, the
        usage-counting service OpenZCAD runs for itself.
      </p>
      <strong>Sent</strong>
      <ul>
        <li>Which feature categories, workflow steps and exports you use</li>
        <li>Diagnostic codes</li>
        <li>
          Ranges, never exact values: part count, project file size and transfer
          size
        </li>
        <li>Coarse timings</li>
        <li>
          Work done on this device, not only in the cloud. Local operations are
          counted only with this switch on.
        </li>
      </ul>
      <strong>Never sent</strong>
      <ul>
        <li>Model contents or geometry</li>
        <li>File names or project names</li>
        <li>Anything that identifies you</li>
      </ul>
      <strong>How to stop</strong>
      <ul>
        <li>It is off until you turn it on.</li>
        <li>Turn it off here and sending stops at once.</li>
        <li>
          Do Not Track or Global Privacy Control in your browser, or turning off
          Cloud features, pauses sending and keeps this choice for later.
        </li>
        <li>
          The choice is kept in this browser only, and separately for each app.
        </li>
        <li>
          A yes given before this list grew does not cover it: this expanded
          scope requires a fresh choice.
        </li>
      </ul>
      <p>
        Totals already sent are anonymous, so they cannot be traced back to you
        or removed. Separately from this switch, basic server counters measure
        API activity and reliability. More in the{' '}
        <ExternalAnchor href={privacyPolicyHref()}>
          privacy policy
        </ExternalAnchor>
        .
      </p>
    </div>
  );
}

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
        // The disclosure keeps every statement of the approved consent text:
        // a shortened copy once dropped that local operations need opt-in.
        details={
          desktop
            ? undefined
            : {
                summary: 'What’s collected',
                body: <AnalyticsDisclosure />
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
            // The row title is not part of the button's name; on its own
            // "Download" would not say what it downloads.
            aria-label="Download diagnostic report"
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
          version?: number | null;
        }>;
      })
      .then((v) => {
        setEnabled(v.enabled);
        setReady(true);
        setStatus(
          v.enabled
            ? grantStatus(v)
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
        body: JSON.stringify({
          enabled: checked,
          version: ACCOUNT_STATISTICS_VERSION
        })
      });
      if (!r.ok) throw new Error();
      const v = (await r.json()) as {
        enabled: boolean;
        expiresAt: string | null;
        version?: number | null;
      };
      setEnabled(v.enabled);
      setStatus(
        v.enabled
          ? grantStatus(v)
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
        body: ACCOUNT_STATISTICS_TEXT
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
