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
      <div className="properties__header">
        <div>
          <p className="panel-kicker">Selection</p>
          <h3>{selected.name}</h3>
        </div>
        <span className="properties__badge">{selected.kind}</span>
      </div>

      <dl className="properties__grid">
        <div>
          <dt>ID</dt>
          <dd>{selected.id}</dd>
        </div>
        <div>
          <dt>Parent</dt>
          <dd>{selected.parentId ?? 'root'}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>{selected.revisionId ?? 'live'}</dd>
        </div>
        <div>
          <dt>Kind</dt>
          <dd>{selected.kind}</dd>
        </div>
      </dl>

      <div className="properties__detail">
        {selected.kind === 'body' ? (
          <>
            <h4>Body</h4>
            <p>Type {selected.bodyType}</p>
            <p>Representation {selected.representationSource}</p>
            <p>STEP export {selected.exportableStep ? 'available' : 'not available'}</p>
          </>
        ) : null}

        {selected.kind === 'feature' ? (
          <>
            <h4>Feature</h4>
            <p>Feature kind {selected.featureKind}</p>
            <pre>{JSON.stringify(selected.data, null, 2)}</pre>
          </>
        ) : null}

        {selected.kind === 'sketch' ? (
          <>
            <h4>Sketch</h4>
            <p>Plane {selected.plane}</p>
            <p>{selected.objectIds.length} objects</p>
            <p>{selected.constraintIds.length} constraints</p>
          </>
        ) : null}
      </div>

      <details className="properties__raw">
        <summary>Raw node payload</summary>
        <pre>{JSON.stringify(selected, null, 2)}</pre>
      </details>
    </div>
  );
}
