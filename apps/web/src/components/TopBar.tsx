import { type ChangeEvent } from 'react';
import {
  Download,
  HelpCircle,
  Redo2,
  Save,
  Search,
  Undo2,
  Upload
} from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import type { WorkspaceId } from '../lib/commands';
import { BrandMark } from './BrandMark';

interface TopBarProps {
  projectName: string | null;
  units: UnitSystem | null;
  /** True when the document has changes not yet saved as a revision. */
  dirty: boolean;
  workspace: WorkspaceId;
  canUndo: boolean;
  canRedo: boolean;
  canExport: boolean;
  /** Name of the body the export will target, or null for "all bodies". */
  exportScope: string | null;
  onWorkspaceChange(workspace: WorkspaceId): void;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
  onImportFile(file: File): void;
  onExport(format: 'step' | 'stl'): void;
  onGoHome(): void;
  onOpenSearch(): void;
  onOpenShortcuts(): void;
}

const WORKSPACES: { id: WorkspaceId; label: string }[] = [
  { id: 'model', label: 'Model' },
  { id: 'visualize', label: 'Visualize' }
];

/** Global bar: navigation, project identity, workspaces, and global actions. */
export function TopBar({
  projectName,
  units,
  dirty,
  workspace,
  canUndo,
  canRedo,
  canExport,
  exportScope,
  onWorkspaceChange,
  onUndo,
  onRedo,
  onSave,
  onImportFile,
  onExport,
  onGoHome,
  onOpenSearch,
  onOpenShortcuts
}: TopBarProps) {
  const exportTitle = (format: string) =>
    canExport
      ? `Export ${exportScope ?? 'all bodies'} as ${format}`
      : 'Create a body before exporting';

  return (
    <header className="topbar">
      <button className="brand" type="button" onClick={onGoHome} title="Back to projects">
        <BrandMark />
        OpenZCAD <span className="beta-tag">Beta</span>
      </button>
      <div className="topbar-divider" />
      <div className="breadcrumb">
        <strong>{projectName ?? 'No project'}</strong>
        {projectName && <span className="mono">{units ?? ''}</span>}
        {projectName && (
          <span
            className={`save-state ${dirty ? 'dirty' : ''}`}
            title={dirty ? 'Unsaved changes — Ctrl+S saves a revision' : 'All changes saved'}
          >
            {dirty ? '● unsaved' : 'saved'}
          </span>
        )}
      </div>

      <div className="workspace-switcher" role="tablist" aria-label="Workspaces">
        {WORKSPACES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={workspace === entry.id}
            className={`workspace-tab ${workspace === entry.id ? 'active' : ''}`}
            onClick={() => onWorkspaceChange(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="topbar-tools" aria-label="Global tools">
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
        <button
          className="search-trigger"
          type="button"
          title="Search commands (S)"
          onClick={onOpenSearch}
        >
          <Search size={13} aria-hidden="true" />
          <span>Search</span>
          <kbd>S</kbd>
        </button>
      </div>

      <label className="secondary topbar-action" title="Import an STL mesh or inspect STEP metadata">
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
        className="primary topbar-action"
        type="button"
        disabled={!projectName}
        onClick={onSave}
        title="Save a revision (Ctrl+S)"
      >
        <Save size={15} aria-hidden="true" />
        Save
      </button>
      <button
        className="icon-button"
        type="button"
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
        onClick={onOpenShortcuts}
      >
        <HelpCircle size={15} aria-hidden="true" />
      </button>
    </header>
  );
}
