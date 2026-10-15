import { useEffect, useState } from 'react';
import { isAnalyticsEnabled, setAnalyticsEnabled } from '../lib/analytics';
export function AnalyticsConsent() {
  const [enabled, setEnabled] = useState(isAnalyticsEnabled);
  const [error, setError] = useState('');
  useEffect(() => {
    const update = () => setEnabled(isAnalyticsEnabled());
    window.addEventListener('glimpse-consent-changed', update);
    return () => window.removeEventListener('glimpse-consent-changed', update);
  }, []);
  return (
    <div className="settings-privacy-note">
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            const saved = setAnalyticsEnabled(event.currentTarget.checked);
            setEnabled(isAnalyticsEnabled());
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
        Allow Glimpse to count feature use, workflow steps, exports, and coarse
        timings. No model contents, geometry, filenames, project names, or
        identity. Off by default. Withdraw here to stop collection immediately;
        existing anonymous totals cannot be attributed or removed.
      </p>
      <p>
        Basic server counters measure API activity and reliability. Local
        operations are counted only with your opt-in. This choice stays in this
        browser and is separate for each app.
      </p>
      {error && <p role="status">{error}</p>}
    </div>
  );
}
