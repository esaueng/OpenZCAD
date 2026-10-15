import { useEffect, useState } from 'react';
import { hasAnalyticsConsent, setAnalyticsEnabled } from '../lib/analytics';
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
      {error && <p role="status">{error}</p>}
    </div>
  );
}
