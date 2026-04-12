import { useMemo, type ReactNode } from 'react';
import type { DocumentNode, ProjectDocument } from '@openzcad/shared';

interface ModelTreeProps {
  document: ProjectDocument | null;
  selectedId: string | null;
  onSelect(nodeId: string): void;
}

export function ModelTree({ document, selectedId, onSelect }: ModelTreeProps) {
  const kindLabel: Record<DocumentNode['kind'], string> = {
    project: 'PRJ',
    assembly: 'ASM',
    part: 'PRT',
    parameter: 'PAR',
    sketch: 'SKT',
    'sketch-object': 'OBJ',
    constraint: 'CNS',
    feature: 'FTR',
    body: 'BDY'
  };

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
    return <div className="panel-empty">Create or load a project to view the model tree.</div>;
  }

  const renderBranch = (parentId: string | null, depth = 0): ReactNode[] =>
    (nodesByParent.get(parentId) ?? []).map((node) => (
      <div key={node.id}>
        <button
          className={`tree-node ${selectedId === node.id ? 'is-selected' : ''}`}
          style={{ paddingLeft: `${12 + depth * 14}px` }}
          onClick={() => onSelect(node.id)}
        >
          <span className="tree-node__title">
            <span className="tree-node__kind">{kindLabel[node.kind]}</span>
            <span>{node.name}</span>
          </span>
          <small>{node.kind}</small>
        </button>
        {renderBranch(node.id, depth + 1)}
      </div>
    ));

  return <div className="tree">{renderBranch(null)}</div>;
}
