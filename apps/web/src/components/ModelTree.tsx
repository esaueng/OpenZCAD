import { useMemo, type ReactNode } from 'react';
import type { DocumentNode, ProjectDocument } from '@openzcad/shared';

interface ModelTreeProps {
  document: ProjectDocument | null;
  selectedId: string | null;
  onSelect(nodeId: string): void;
}

export function ModelTree({ document, selectedId, onSelect }: ModelTreeProps) {
  const nodesByParent = useMemo(() => {
    const map = new Map<string | null, DocumentNode[]>();
    if (!document) {
      return map;
    }
    for (const node of Object.values(document.nodes)) {
      const list = map.get(node.parentId) ?? [];
      list.push(node);
      map.set(node.parentId, list);
    }
    return map;
  }, [document]);

  if (!document) {
    return <p className="panel-copy">Create or load a project to view the model tree.</p>;
  }

  const renderBranch = (parentId: string | null, depth = 0): ReactNode[] =>
    (nodesByParent.get(parentId) ?? []).map((node) => (
      <div key={node.id}>
        <button
          type="button"
          className={`tree-row ${selectedId === node.id ? 'selected' : ''}`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => onSelect(node.id)}
        >
          <span>{node.name}</span>
          <small>{node.kind}</small>
        </button>
        {renderBranch(node.id, depth + 1)}
      </div>
    ));

  return <div className="tree">{renderBranch(null)}</div>;
}
