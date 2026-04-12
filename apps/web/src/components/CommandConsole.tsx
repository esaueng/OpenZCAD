import { useState, type ChangeEvent } from 'react';
import type { BooleanOperation, PrimitiveKind, ProjectDocument, SketchObjectKind } from '@openzcad/shared';

interface CommandConsoleProps {
  document: ProjectDocument | null;
  onCreateProject(name: string): Promise<void>;
  onPrimitive(kind: PrimitiveKind): void;
  onSketch(kind: SketchObjectKind): void;
  onExtrude(): void;
  onBoolean(operation: BooleanOperation): void;
  onTransform(): void;
  onUndo(): void;
  onRedo(): void;
  onSave(): Promise<void>;
  onImportFile(file: File): Promise<void>;
  onExport(format: 'step' | 'stl'): Promise<void>;
  status: string;
}

export function CommandConsole({
  document,
  onCreateProject,
  onPrimitive,
  onSketch,
  onExtrude,
  onBoolean,
  onTransform,
  onUndo,
  onRedo,
  onSave,
  onImportFile,
  onExport,
  status
}: CommandConsoleProps) {
  const [projectName, setProjectName] = useState('OpenZCAD Beta Project');

  return (
    <div className="console">
      <div className="console-row">
        <input
          value={projectName}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setProjectName(event.target.value)
          }
        />
        <button onClick={() => void onCreateProject(projectName)}>Create Project</button>
        <button disabled={!document} onClick={() => void onSave()}>
          Save Revision
        </button>
      </div>
      <div className="console-grid">
        <button disabled={!document} onClick={() => onPrimitive('box')}>
          Box
        </button>
        <button disabled={!document} onClick={() => onPrimitive('cylinder')}>
          Cylinder
        </button>
        <button disabled={!document} onClick={() => onPrimitive('sphere')}>
          Sphere
        </button>
        <button disabled={!document} onClick={() => onSketch('rectangle')}>
          Sketch Rectangle
        </button>
        <button disabled={!document} onClick={() => onSketch('circle')}>
          Sketch Circle
        </button>
        <button disabled={!document} onClick={() => onSketch('line')}>
          Sketch Line
        </button>
        <button disabled={!document} onClick={() => onExtrude()}>
          Extrude
        </button>
        <button disabled={!document} onClick={() => onBoolean('union')}>
          Boolean Union
        </button>
        <button disabled={!document} onClick={() => onBoolean('subtract')}>
          Boolean Subtract
        </button>
        <button disabled={!document} onClick={() => onBoolean('intersect')}>
          Boolean Intersect
        </button>
        <button disabled={!document} onClick={() => onTransform()}>
          Move + Rotate
        </button>
        <button disabled={!document} onClick={() => onUndo()}>
          Undo
        </button>
        <button disabled={!document} onClick={() => onRedo()}>
          Redo
        </button>
        <label className="file-button">
          Import STEP/STL
          <input
            type="file"
            accept=".stl,.step,.stp"
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              if (file) {
                void onImportFile(file);
              }
            }}
          />
        </label>
        <button disabled={!document} onClick={() => void onExport('stl')}>
          Export STL
        </button>
        <button disabled={!document} onClick={() => void onExport('step')}>
          Export STEP
        </button>
      </div>
      <p className="status-line">{status}</p>
    </div>
  );
}
