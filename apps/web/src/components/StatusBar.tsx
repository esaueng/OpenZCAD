interface StatusBarProps {
  status: string;
  tone: 'ready' | 'warning' | 'running';
  /** Contextual guidance: active command, selection actions, or discovery tips. */
  hint: string;
  projectName: string | null;
  bodyCount: number;
  featureCount: number;
  warningCount: number;
  documentVersion: number | null;
}

export function StatusBar({
  status,
  tone,
  hint,
  projectName,
  bodyCount,
  featureCount,
  warningCount,
  documentVersion
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span className={`status-state ${tone === 'ready' ? '' : tone}`} title={status}>
        <i />
        {status}
      </span>
      <span className="status-hint">{hint}</span>
      <div className="status-groups" aria-label="Workspace status">
        <span>
          <b>project</b>
          {projectName ?? '—'}
        </span>
        <span>
          <b>features</b>
          {featureCount}
        </span>
        <span>
          <b>bodies</b>
          {bodyCount}
        </span>
        {warningCount > 0 && (
          <span className="status-warning">
            <b>warnings</b>
            {warningCount}
          </span>
        )}
        <span>
          <b>rev</b>
          {documentVersion ?? '—'}
        </span>
      </div>
    </footer>
  );
}
