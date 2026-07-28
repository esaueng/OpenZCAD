import {
  SELECTION_FILTERS,
  SELECTION_FILTER_LABELS,
  type SelectionFilter
} from '@openzcad/viewport';

interface StatusBarProps {
  status: string;
  tone: 'ready' | 'warning' | 'running';
  /** Context-sensitive next-step hint, e.g. shortcuts for the selection. */
  hint: string | null;
  projectName: string | null;
  bodyCount: number;
  featureCount: number;
  warningCount: number;
  documentVersion: number | null;
  units: string;
  /** What picking is currently narrowed to, however that was decided. */
  selectionFilter: SelectionFilter;
  /** True while the active tool is choosing the filter rather than the user. */
  selectionFilterIsAutomatic: boolean;
  /** Null clears the manual choice and hands the filter back to the tool. */
  onSelectionFilter(filter: SelectionFilter | null): void;
}

export function StatusBar({
  status,
  tone,
  hint,
  projectName,
  bodyCount,
  featureCount,
  warningCount,
  documentVersion,
  units,
  selectionFilter,
  selectionFilterIsAutomatic,
  onSelectionFilter
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
      {hint && <span className="status-hint">{hint}</span>}
      <div
        className="status-filters"
        role="group"
        aria-label="Selection filter"
      >
        <b>select</b>
        {SELECTION_FILTERS.map((filter) => {
          const active = filter === selectionFilter;
          // Clicking the active chip clears the manual choice rather than
          // re-asserting it, so the tool can take the filter back without a
          // second control to find.
          return (
            <button
              key={filter}
              type="button"
              className={`status-filter${active ? ' active' : ''}${
                active && selectionFilterIsAutomatic ? ' automatic' : ''
              }`}
              aria-pressed={active}
              title={
                active && selectionFilterIsAutomatic
                  ? `${SELECTION_FILTER_LABELS[filter]} — chosen by the active tool`
                  : `Select ${SELECTION_FILTER_LABELS[filter].toLowerCase()} only (Q cycles)`
              }
              onClick={() =>
                onSelectionFilter(
                  active && !selectionFilterIsAutomatic ? null : filter
                )
              }
            >
              {SELECTION_FILTER_LABELS[filter]}
            </button>
          );
        })}
      </div>
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
