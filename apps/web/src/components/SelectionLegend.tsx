import type { WorkflowCounts } from '../lib/workflow';

interface SelectionLegendProps {
  counts: WorkflowCounts;
}

const ENTRIES = [
  { label: 'design space', color: 'var(--color-text-muted)', key: 'designBodies' },
  { label: 'preserve', color: 'var(--color-role-preserve)', key: 'preserved' },
  { label: 'fixed', color: 'var(--color-role-fixed)', key: 'fixed' },
  { label: 'obstacle', color: 'var(--color-role-obstacle)', key: 'obstacles' },
  { label: 'loaded', color: 'var(--color-role-load)', key: 'loaded' }
] as const;

export function SelectionLegend({ counts }: SelectionLegendProps) {
  return (
    <div className="selection-legend" aria-label="Body role legend">
      <strong>setup</strong>
      {ENTRIES.map((entry) => (
        <div key={entry.key}>
          <i style={{ background: entry.color }} />
          {entry.label}
          <small>{counts[entry.key]}</small>
        </div>
      ))}
    </div>
  );
}
