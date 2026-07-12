import { type ChangeEvent } from 'react';
import {
  Check,
  CloudOff,
  Download,
  LoaderCircle,
  Redo2,
  Undo2,
  Upload
} from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import { BrandMark } from './BrandMark';

interface TopBarProps {
  projectName: string | null;
  units: UnitSystem | null;
  canUndo: boolean;
  canRedo: boolean;
  canExport: boolean;
  /** Name of the body the export will target, or null for "all bodies". */
  exportScope: string | null;
  saveState: 'saved' | 'saving' | 'offline';
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
  onImportFile(file: File): void;
  onExport(format: 'step' | 'stl'): void;
  onGoHome(): void;
}

export function TopBar({
  projectName,
  units,
  canUndo,
  canRedo,
  canExport,
  exportScope,
  saveState,
  onUndo,
  onRedo,
  onSave,
  onImportFile,
  onExport,
  onGoHome
}: TopBarProps) {
  const exportTitle = (format: string) =>
    canExport
      ? `Export ${exportScope ?? 'all bodies'} as ${format}`
      : 'Create a body before exporting';

  return (
    <header className="topbar">
      <button
        className="brand"
        type="button"
        onClick={onGoHome}
        title="Back to projects"
      >
        <BrandMark />
        OpenZCAD <span className="beta-tag">Beta</span>
      </button>
      <div className="topbar-divider" />
      <div className="breadcrumb">
        <strong>{projectName ?? 'No project'}</strong>
        {projectName && <span className="mono">{units ?? ''}</span>}
      </div>
      <div className="topbar-tools" aria-label="Workspace tools">
        <button
          className="icon-button"
          type="button"
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 size={15} aria-hidden="true" />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 size={15} aria-hidden="true" />
        </button>
      </div>
      <label
        className="secondary topbar-action"
        title="Import an STL mesh or inspect STEP metadata"
      >
        <Upload size={14} aria-hidden="true" />
        Import
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
      <button
        className="secondary topbar-action"
        type="button"
        disabled={!canExport}
        title={exportTitle('STEP (AP214)')}
        onClick={() => onExport('step')}
      >
        <Download size={14} aria-hidden="true" />
        STEP
      </button>
      <button
        className="secondary topbar-action"
        type="button"
        disabled={!canExport}
        title={exportTitle('STL')}
        onClick={() => onExport('stl')}
      >
        <Download size={14} aria-hidden="true" />
        STL
      </button>
      <button
        className="save-state topbar-action"
        type="button"
        disabled={!projectName}
        onClick={onSave}
        title="Save a revision (Ctrl+S)"
      >
        {saveState === 'saving' ? (
          <LoaderCircle className="spin" size={14} aria-hidden="true" />
        ) : saveState === 'offline' ? (
          <CloudOff size={14} aria-hidden="true" />
        ) : (
          <Check size={14} aria-hidden="true" />
        )}
        {saveState === 'saving'
          ? 'Saving'
          : saveState === 'offline'
            ? 'Local only'
            : 'Saved'}
      </button>
    </header>
  );
}
