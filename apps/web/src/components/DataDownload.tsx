import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { AppSettings, AuthSession } from '@openzcad/shared';

export function DataDownload({
  settings,
  session,
  cloudFunctionsEnabled,
  busy
}: {
  settings: AppSettings;
  session: AuthSession | null;
  cloudFunctionsEnabled: boolean;
  busy: boolean;
}) {
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const identity = `${session?.userId ?? ''}:${cloudFunctionsEnabled}`;
  const currentIdentity = useRef({ identity, revision: 0 });
  if (currentIdentity.current.identity !== identity) {
    currentIdentity.current = {
      identity,
      revision: currentIdentity.current.revision + 1
    };
  }
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function download() {
    if (preparing) return;
    setPreparing(true);
    setError('');
    const startedFor = currentIdentity.current.revision;
    const isCurrent = () =>
      mounted.current && currentIdentity.current.revision === startedFor;
    try {
      setProgress('Preparing your download…');
      const { downloadAllData } = await import('../lib/dataExport');
      await downloadAllData({
        settings,
        session,
        cloudFunctionsEnabled,
        isCurrent,
        onProgress: (message) => {
          if (isCurrent()) setProgress(message);
        }
      });
      if (isCurrent()) setProgress('Your data download is ready.');
    } catch (failure) {
      if (mounted.current) {
        setProgress('');
        setError(
          !isCurrent()
            ? 'Your account changed. Start the download again.'
            : failure instanceof Error
              ? failure.message
              : 'Could not prepare your data. Please try again.'
        );
      }
    } finally {
      if (mounted.current) setPreparing(false);
    }
  }

  return (
    <div className="data-download">
      <button
        className="secondary"
        type="button"
        disabled={busy || preparing}
        onClick={() => void download()}
        aria-busy={preparing}
      >
        <Download size={14} aria-hidden="true" />
        {preparing ? 'Preparing download…' : 'Download all data'}
      </button>
      {progress ? (
        <p className="data-download-feedback" role="status">
          {progress}
        </p>
      ) : null}
      {error ? (
        <p className="data-download-feedback" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
