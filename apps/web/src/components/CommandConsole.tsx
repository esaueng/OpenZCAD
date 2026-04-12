import { useState, type ChangeEvent } from 'react';
import type {
  BooleanOperation,
  PrimitiveKind,
  ProjectDocument,
  SketchObjectKind
} from '@openzcad/shared';
import type { ViewPreset } from '../lib/view';

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
  onFitView(): void;
  onSetView(preset: ViewPreset): void;
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
  onFitView,
  onSetView,
  status
}: CommandConsoleProps) {
  const [projectName, setProjectName] = useState('OpenZCAD Beta Project');

  return (
    <div className="ribbon">
      <div className="ribbon-group ribbon-group--project">
        <span className="ribbon-label">Project</span>
        <input
          className="ribbon-input"
          value={projectName}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setProjectName(event.target.value)
          }
        />
        <button className="ribbon-button ribbon-button--accent" onClick={() => void onCreateProject(projectName)}>
          New
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => void onSave()}>
          Save
        </button>
      </div>

      <div className="ribbon-group">
        <span className="ribbon-label">File</span>
        <label className={`ribbon-button ribbon-button--file ${document ? '' : 'is-disabled'}`}>
          Import
          <input
            type="file"
            accept=".stl,.step,.stp"
            disabled={!document}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              if (file) {
                void onImportFile(file);
              }
              event.currentTarget.value = '';
            }}
          />
        </label>
        <button className="ribbon-button" disabled={!document} onClick={() => void onExport('stl')}>
          STL
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => void onExport('step')}>
          STEP
        </button>
      </div>

      <div className="ribbon-group">
        <span className="ribbon-label">Solid</span>
        <button className="ribbon-button" disabled={!document} onClick={() => onPrimitive('box')}>
          Box
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onPrimitive('cylinder')}>
          Cylinder
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onPrimitive('sphere')}>
          Sphere
        </button>
      </div>

      <div className="ribbon-group">
        <span className="ribbon-label">Sketch</span>
        <button className="ribbon-button" disabled={!document} onClick={() => onSketch('rectangle')}>
          Rect
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onSketch('circle')}>
          Circle
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onSketch('line')}>
          Line
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onExtrude()}>
          Extrude
        </button>
      </div>

      <div className="ribbon-group">
        <span className="ribbon-label">Modify</span>
        <button className="ribbon-button" disabled={!document} onClick={() => onBoolean('union')}>
          Union
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onBoolean('subtract')}>
          Subtract
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onBoolean('intersect')}>
          Intersect
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onTransform()}>
          Move/Rotate
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onUndo()}>
          Undo
        </button>
        <button className="ribbon-button" disabled={!document} onClick={() => onRedo()}>
          Redo
        </button>
      </div>

      <div className="ribbon-group">
        <span className="ribbon-label">View</span>
        <button className="ribbon-button" onClick={() => onSetView('top')}>
          Top
        </button>
        <button className="ribbon-button" onClick={() => onSetView('front')}>
          Front
        </button>
        <button className="ribbon-button" onClick={() => onSetView('right')}>
          Right
        </button>
        <button className="ribbon-button" onClick={() => onSetView('iso')}>
          Iso
        </button>
        <button className="ribbon-button" onClick={() => onFitView()}>
          Fit
        </button>
      </div>

      <div className="ribbon-status">
        <span className={`status-pill ${document ? 'is-ready' : 'is-idle'}`}>
          {document ? 'Model ready' : 'No project'}
        </span>
        <small>{status}</small>
      </div>
    </div>
  );
}
