import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { AppSettings, AuthSession } from '@openzcad/shared';
import type { DataExportSummary } from '../lib/dataExportTypes';
import { SettingRow, Toggle } from './settingsControls';

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
  const [includeOriginalImports, setIncludeOriginalImports] = useState(false);
  const [includeDeviceSnapshot, setIncludeDeviceSnapshot] = useState(true);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<{
    revision: number;
    summary: DataExportSummary;
  } | null>(null);
  const identity = `${session?.userId ?? ''}:${cloudFunctionsEnabled}`;
  const currentIdentity = useRef({ identity, revision: 0 });
  if (currentIdentity.current.identity !== identity) {
    currentIdentity.current = {
      identity,
      revision: currentIdentity.current.revision + 1
    };
  }
  const summary =
    completed?.revision === currentIdentity.current.revision
      ? completed.summary
      : null;
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
    setCompleted(null);
    const startedFor = currentIdentity.current.revision;
    const isCurrent = () =>
      mounted.current && currentIdentity.current.revision === startedFor;
    try {
      setProgress('Preparing your download…');
      const { downloadAllData } = await import('../lib/dataExport');
      const result = await downloadAllData({
        settings,
        session,
        cloudFunctionsEnabled,
        includeOriginalImports,
        includeDeviceSnapshot,
        isCurrent,
        onProgress: (message) => {
          if (isCurrent()) setProgress(message);
        }
      });
      if (isCurrent()) {
        setCompleted({ revision: startedFor, summary: result });
        setProgress(
          `Your data download is ready. ${result.includedProjects} project backup${result.includedProjects === 1 ? '' : 's'} included; ${result.skippedProjects.length} skipped.`
        );
      }
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
    <>
      <SettingRow
        title="Download your data"
        hint={
          session && cloudFunctionsEnabled
            ? 'Local and cloud projects, history, files, settings and profile. One unencrypted ZIP, up to 512 MB.'
            : 'This device’s projects, files and settings. One unencrypted ZIP, up to 512 MB.'
        }
      >
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
      </SettingRow>
      <SettingRow
        title="Include original import files"
        hint="Rebuild data is always included."
      >
        <Toggle
          label="Include original import files"
          checked={includeOriginalImports}
          disabled={busy || preparing}
          onChange={setIncludeOriginalImports}
        />
      </SettingRow>
      <SettingRow
        title="Include device recovery data"
        hint="Browser recovery records. Off is smaller and faster."
      >
        <Toggle
          label="Include extra device recovery data"
          checked={includeDeviceSnapshot}
          disabled={busy || preparing}
          onChange={setIncludeDeviceSnapshot}
        />
      </SettingRow>
      {progress || error || summary ? (
        <div className="data-download">
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
          {summary &&
          (summary.skippedProjects.length > 0 ||
            summary.omittedSections.length > 0) ? (
            <details className="data-download-omissions" open>
              <summary>Not included in this download</summary>
              {summary.skippedProjects.length > 0 ? (
                <>
                  <p>
                    Open these projects from Projects, then choose File → Export
                    project to download them manually.
                  </p>
                  <ul aria-label="Project backups not included">
                    {summary.skippedProjects.map((project) => (
                      <li key={`${project.scope}:${project.projectId}`}>
                        <strong>{project.name}</strong>
                        <span>
                          {project.scope === 'local'
                            ? 'Local copy'
                            : 'Cloud copy'}{' '}
                          · {project.projectId}
                        </span>
                        <span>{project.reason}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {summary.omittedSections.length > 0 ? (
                <ul aria-label="Other data not included">
                  {summary.omittedSections.map((section) => (
                    <li key={section.name}>
                      <strong>{section.name}</strong>
                      <span>{section.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p>
                This list is also in NOT-INCLUDED.txt and manifest.json inside
                your ZIP.
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
