interface StatusBarProps {
  status: string;
  tone: 'ready' | 'warning' | 'running';
  projectName: string | null;
  bodyCount: number;
  featureCount: number;
  warningCount: number;
  documentVersion: number | null;
  units: string;
}

export function StatusBar({
  status,
  tone,
  projectName,
  bodyCount,
  featureCount,
  warningCount,
  documentVersion,
  units
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span
        className={`status-state ${tone === 'ready' ? '' : tone}`}
        title={status}
      >
        <i />
        {status}
      </span>
      <div className="status-groups" aria-label="Workspace status">
        <span>
          <b>kernel</b>
          Exact B-rep
        </span>
        <span>
          <b>units</b>
          {units}
        </span>
        <span>
          <b>warnings</b>
          {warningCount}
        </span>
        <span>
          <b>rev</b>
          {documentVersion ?? '—'}
        </span>
        <span
          title={`${projectName ?? 'Project'} · ${featureCount} features · ${bodyCount} bodies`}
        >
          <b>sync</b>
          Synced
        </span>
      </div>
    </footer>
  );
}
