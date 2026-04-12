import type { ProjectDocument } from '@openzcad/shared';

interface PropertiesPanelProps {
  document: ProjectDocument | null;
  selectedId: string | null;
}

export function PropertiesPanel({ document, selectedId }: PropertiesPanelProps) {
  const selected = selectedId && document ? document.nodes[selectedId] ?? null : null;

  if (!selected) {
    return <div className="panel-empty">Select an item to inspect its properties.</div>;
  }

  return (
    <div className="properties">
      <h3>{selected.name}</h3>
      <pre>{JSON.stringify(selected, null, 2)}</pre>
    </div>
  );
}
