import { useState, type ChangeEvent } from 'react';
import {
  Box,
  Circle,
  Combine,
  Cylinder,
  Download,
  FilePlus2,
  Maximize2,
  Minus,
  MousePointer2,
  Move3d,
  Radius,
  Redo2,
  Save,
  Square,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Undo2,
  Upload,
  type LucideIcon
} from 'lucide-react';
import type {
  BooleanOperation,
  PrimitiveKind,
  ProjectDocument,
  SketchObjectKind
} from '@openzcad/shared';
import type { ModelingTool } from '../lib/selection';
import type { ViewPreset } from '../lib/view';

interface CommandConsoleProps {
  document: ProjectDocument | null;
  activeTool: ModelingTool;
  onCreateProject(name: string): Promise<void>;
  onPrimitive(kind: PrimitiveKind): void;
  onSketch(kind: SketchObjectKind): void;
  onExtrude(): void;
  onBoolean(operation: BooleanOperation): void;
  onTransform(): void;
  onToolChange(tool: ModelingTool): void;
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
  activeTool,
  onCreateProject,
  onPrimitive,
  onSketch,
  onExtrude,
  onBoolean,
  onTransform,
  onToolChange,
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
    <div className="ribbon" role="toolbar" aria-label="Modeling tools">
      <div className="ribbon-project">
        <input
          className="ribbon-input"
          aria-label="New project name"
          value={projectName}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setProjectName(event.target.value)
          }
        />
        <ToolButton
          label="New"
          icon={FilePlus2}
          onClick={() => void onCreateProject(projectName)}
          emphasized
        />
      </div>

      <RibbonGroup label="File">
        <ToolButton
          label="Save"
          icon={Save}
          disabled={!document}
          onClick={() => void onSave()}
        />
        <label
          className={`tool-button tool-button--file ${document ? '' : 'is-disabled'}`}
        >
          <Upload size={18} aria-hidden="true" />
          <span>Import</span>
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
        <ToolButton
          label="STL"
          icon={Download}
          disabled={!document}
          onClick={() => void onExport('stl')}
        />
        <ToolButton
          label="STEP"
          icon={Download}
          disabled={!document}
          onClick={() => void onExport('step')}
        />
      </RibbonGroup>

      <RibbonGroup label="Create">
        <ToolButton
          label="Box"
          icon={Box}
          disabled={!document}
          onClick={() => onPrimitive('box')}
        />
        <ToolButton
          label="Cylinder"
          icon={Cylinder}
          disabled={!document}
          onClick={() => onPrimitive('cylinder')}
        />
        <ToolButton
          label="Sphere"
          icon={Circle}
          disabled={!document}
          onClick={() => onPrimitive('sphere')}
        />
        <ToolButton
          label="Sketch"
          icon={Square}
          disabled={!document}
          onClick={() => onSketch('rectangle')}
        />
        <ToolButton
          label="Circle"
          icon={Circle}
          disabled={!document}
          onClick={() => onSketch('circle')}
        />
        <ToolButton
          label="Line"
          icon={Minus}
          disabled={!document}
          onClick={() => onSketch('line')}
        />
        <ToolButton
          label="Extrude"
          icon={Combine}
          disabled={!document}
          onClick={onExtrude}
        />
      </RibbonGroup>

      <RibbonGroup label="Modify">
        <ToolButton
          label="Select"
          icon={MousePointer2}
          active={activeTool === 'select'}
          onClick={() => onToolChange('select')}
        />
        <ToolButton
          label="Fillet"
          icon={Radius}
          disabled={!document}
          active={activeTool === 'fillet'}
          onClick={() =>
            onToolChange(activeTool === 'fillet' ? 'select' : 'fillet')
          }
        />
        <ToolButton
          label="Move"
          icon={Move3d}
          disabled={!document}
          onClick={onTransform}
        />
        <ToolButton
          label="Union"
          icon={SquaresUnite}
          disabled={!document}
          onClick={() => onBoolean('union')}
        />
        <ToolButton
          label="Subtract"
          icon={SquaresSubtract}
          disabled={!document}
          onClick={() => onBoolean('subtract')}
        />
        <ToolButton
          label="Intersect"
          icon={SquaresIntersect}
          disabled={!document}
          onClick={() => onBoolean('intersect')}
        />
        <ToolButton
          label="Undo"
          icon={Undo2}
          disabled={!document}
          onClick={onUndo}
        />
        <ToolButton
          label="Redo"
          icon={Redo2}
          disabled={!document}
          onClick={onRedo}
        />
      </RibbonGroup>

      <RibbonGroup label="View" compact>
        {(['top', 'front', 'right', 'iso'] as ViewPreset[]).map((preset) => (
          <button
            key={preset}
            className="view-preset-button"
            onClick={() => onSetView(preset)}
          >
            {preset === 'iso' ? 'ISO' : preset.charAt(0).toUpperCase()}
          </button>
        ))}
        <ToolButton label="Fit" icon={Maximize2} onClick={onFitView} />
      </RibbonGroup>

      <div className="ribbon-status" title={status}>
        <span className={`status-pill ${document ? 'is-ready' : 'is-idle'}`}>
          {document ? 'Ready' : 'No project'}
        </span>
        <small>{status}</small>
      </div>
    </div>
  );
}

function RibbonGroup({
  label,
  compact = false,
  children
}: {
  label: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`ribbon-group ${compact ? 'ribbon-group--compact' : ''}`}>
      <span className="ribbon-label">{label}</span>
      <div className="ribbon-group__tools">{children}</div>
    </div>
  );
}

function ToolButton({
  label,
  icon: Icon,
  active = false,
  emphasized = false,
  disabled = false,
  onClick
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  emphasized?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      className={`tool-button ${active ? 'is-active' : ''} ${emphasized ? 'is-emphasized' : ''}`}
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
    >
      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
