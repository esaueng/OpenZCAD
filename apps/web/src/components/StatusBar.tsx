interface StatusBarProps {
  status: string;
  tone: 'ready' | 'warning' | 'running';
  projectName: string | null;
  bodyCount: number;
  featureCount: number;
  warningCount: number;
  documentVersion: number | null;
}

export function StatusBar({
  status,
  tone,
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
