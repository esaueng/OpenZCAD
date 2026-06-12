import { type ChangeEvent } from 'react';
import type {
  BooleanOperation,
  DocumentNode,
  PrimitiveKind,
  ProjectDocument,
  SketchObjectKind
} from '@openzcad/shared';
import { ModelTree } from '../ModelTree';

interface ModelPanelProps {
  document: ProjectDocument;
  selectedId: string | null;
  onSelect(nodeId: string): void;
  onPrimitive(kind: PrimitiveKind): void;
  onSketch(kind: SketchObjectKind): void;
  onExtrude(): void;
  onBoolean(operation: BooleanOperation): void;
  onTransform(): void;
  onImportFile(file: File): void;
  onExport(format: 'step' | 'stl'): void;
}

function describeNode(node: DocumentNode): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['kind', node.kind],
    ['id', node.id]
  ];
  if (node.kind === 'body') {
    rows.push(['type', node.bodyType], ['source', node.representationSource]);
  }
  if (node.kind === 'feature') {
    rows.push(['feature', node.featureKind]);
  }
  if (node.kind === 'sketch') {
    rows.push(['plane', node.plane]);
  }
  return rows;
}

export function ModelPanel({
  document,
  selectedId,
  onSelect,
  onPrimitive,
  onSketch,
  onExtrude,
  onBoolean,
  onTransform,
  onImportFile,
  onExport
}: ModelPanelProps) {
  const selected = selectedId ? (document.nodes[selectedId] ?? null) : null;
  const hasBodies = document.bodyOrder.length > 0;
  const hasSketch = document.sketchOrder.length > 0;

  return (
    <>
      <h3>Primitives</h3>
      <div className="button-grid">
        <button type="button" className="secondary" onClick={() => onPrimitive('box')}>
          Box
        </button>
        <button type="button" className="secondary" onClick={() => onPrimitive('cylinder')}>
          Cylinder
        </button>
        <button type="button" className="secondary" onClick={() => onPrimitive('sphere')}>
          Sphere
        </button>
      </div>

      <h3>Sketch &amp; extrude</h3>
      <div className="button-grid">
        <button type="button" className="secondary" onClick={() => onSketch('rectangle')}>
          Rectangle
        </button>
        <button type="button" className="secondary" onClick={() => onSketch('circle')}>
          Circle
        </button>
        <button type="button" className="secondary" onClick={() => onSketch('line')}>
          Line
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!hasSketch}
          title={hasSketch ? 'Extrude the latest sketch' : 'Create a sketch first'}
          onClick={onExtrude}
        >
          Extrude
        </button>
      </div>

      <h3>Combine &amp; move</h3>
      <div className="button-grid">
        <button
          type="button"
          className="secondary"
          disabled={document.bodyOrder.length < 2}
          onClick={() => onBoolean('union')}
        >
          Union
        </button>
        <button
          type="button"
          className="secondary"
          disabled={document.bodyOrder.length < 2}
          onClick={() => onBoolean('subtract')}
        >
          Subtract
        </button>
        <button
          type="button"
          className="secondary"
          disabled={document.bodyOrder.length < 2}
          onClick={() => onBoolean('intersect')}
        >
          Intersect
        </button>
        <button type="button" className="secondary" disabled={!hasBodies} onClick={onTransform}>
          Move + Rotate
        </button>
      </div>

      <h3>Exchange</h3>
      <div className="button-grid">
        <label className="secondary" style={{ cursor: 'pointer' }}>
          Import…
          <input
            type="file"
            accept=".stl,.step,.stp"
            style={{ display: 'none' }}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) {
                onImportFile(file);
              }
            }}
          />
        </label>
        <button type="button" className="secondary" disabled={!hasBodies} onClick={() => onExport('stl')}>
          Export STL
        </button>
        <button type="button" className="secondary" disabled={!hasBodies} onClick={() => onExport('step')}>
          Export STEP
        </button>
      </div>

      <h3>Model tree</h3>
      <ModelTree document={document} selectedId={selectedId} onSelect={onSelect} />

      {selected && (
        <>
          <h3>Selection</h3>
          <div className="kv-grid">
            {describeNode(selected).map(([key, value]) => (
              <span key={key} style={{ display: 'contents' }}>
                <b>{key}</b>
                <span>{value}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}
