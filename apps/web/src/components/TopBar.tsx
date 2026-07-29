import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  Check,
  CloudOff,
  Download,
  Files,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Redo2,
  Settings as SettingsIcon,
  Undo2,
  Upload,
  Users
} from 'lucide-react';
import type { ArtifactRecord, AuthSession, UnitSystem } from '@openzcad/shared';
import { BrandMark } from './BrandMark';
import type { CollaborationStatus } from '../lib/useCollaboration';

interface TopBarProps {
  projectName: string | null;
  units: UnitSystem | null;
  canUndo: boolean;
  canRedo: boolean;
  canExport: boolean;
  /** Name of the body the export will target, or null for "all bodies". */
  exportScope: string | null;
  saveState: 'saved' | 'saving' | 'offline';
  artifacts: ArtifactRecord[];
  session: AuthSession | null;
  collaborationStatus: CollaborationStatus;
  collaboratorCount: number;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
  onImportFile(file: File): void;
  onExport(format: 'step' | 'stl'): void;
  onRenameProject(name: string): void;
  onGoHome(): void;
  onOpenSettings(): void;
}

export function TopBar({
  projectName,
  units,
  canUndo,
  canRedo,
  canExport,
  exportScope,
  saveState,
  artifacts,
  session,
  collaborationStatus,
  collaboratorCount,
  onUndo,
  onRedo,
  onSave,
  onImportFile,
  onExport,
  onRenameProject,
  onGoHome,
  onOpenSettings
}: TopBarProps) {
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState(projectName ?? '');
  const projectNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingProjectName) {
      projectNameInputRef.current?.select();
    }
  }, [editingProjectName]);

  function beginProjectRename() {
    if (!projectName) {
      return;
    }
    setProjectNameDraft(projectName);
    setEditingProjectName(true);
  }

  function commitProjectRename() {
    const nextName = projectNameDraft.trim();
    setEditingProjectName(false);
    if (nextName && nextName !== projectName) {
      onRenameProject(nextName);
      return;
    }
    setProjectNameDraft(projectName ?? '');
  }

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
        <BrandMark compact />
        OpenZCAD <span className="beta-tag">Beta</span>
      </button>
      <div className="topbar-divider" />
      <div className="breadcrumb">
        {projectName ? (
          editingProjectName ? (
            <input
              ref={projectNameInputRef}
              className="project-title-input"
              value={projectNameDraft}
              maxLength={200}
              aria-label="Project name"
              onChange={(event) => setProjectNameDraft(event.target.value)}
              onBlur={commitProjectRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitProjectRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setProjectNameDraft(projectName);
                  setEditingProjectName(false);
                }
              }}
            />
          ) : (
            <button
              className="project-title-button"
              type="button"
              aria-label="Rename project"
              title="Rename project"
              onClick={beginProjectRename}
            >
              <strong>{projectName}</strong>
              <Pencil size={11} aria-hidden="true" />
            </button>
          )
        ) : (
          <strong>No project</strong>
        )}
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
      {/*
        Import, two exports and the file list used to sit as four peer buttons in
        a flat row with the sync state and settings, so nothing read as a group.
        They are one file menu now; the row is identity | history | file | state.
      */}
      <details className="topbar-menu file-menu">
        <summary className="secondary topbar-action" title="Import and export">
          <FolderOpen size={14} aria-hidden="true" />
          File{artifacts.length > 0 ? ` ${artifacts.length}` : ''}
        </summary>
        <div className="topbar-menu-panel">
          <label className="topbar-menu-item" title="Import an editable STEP solid or STL mesh">
            <Upload size={13} aria-hidden="true" />
            <span>Import STEP or STL…</span>
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
            type="button"
            className="topbar-menu-item"
            disabled={!canExport}
            title={exportTitle('STEP')}
            onClick={() => onExport('step')}
          >
            <Download size={13} aria-hidden="true" />
            <span>Export STEP</span>
            <small>{exportScope ?? 'all bodies'}</small>
          </button>
          <button
            type="button"
            className="topbar-menu-item"
            disabled={!canExport}
            title={exportTitle('STL')}
            onClick={() => onExport('stl')}
          >
            <Download size={13} aria-hidden="true" />
            <span>Export STL</span>
            <small>{exportScope ?? 'all bodies'}</small>
          </button>
          <div className="topbar-menu-sep" />
          <strong className="topbar-menu-label">
            <Files size={12} aria-hidden="true" />
            Stored files
          </strong>
          {artifacts.length === 0 ? (
            <span className="topbar-menu-empty">
              No archived imports or exports yet.
            </span>
          ) : (
            artifacts.map((artifact) => (
              <a
                key={artifact.artifactId}
                className="topbar-menu-item"
                href={`/api/artifacts/${artifact.artifactId}/download`}
                download={artifact.name}
              >
                <Download size={13} aria-hidden="true" />
                <span>{artifact.name}</span>
                <small>
                  {artifact.bytes === undefined
                    ? artifact.kind
                    : `${artifact.kind} · ${Math.max(1, Math.round(artifact.bytes / 1024))} KB`}
                </small>
              </a>
            ))
          )}
        </div>
      </details>
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
      {session && (
        <span className="session-user" title={session.email ?? session.userId}>
          {session.displayName}
        </span>
      )}
      <button
        className="icon-button"
        type="button"
        title="Settings (Ctrl+,)"
        aria-label="Open settings"
        onClick={onOpenSettings}
      >
        <SettingsIcon size={15} aria-hidden="true" />
      </button>
      <span
        className={`collaboration-state ${collaborationStatus}`}
        title={`Collaboration: ${collaborationStatus}`}
      >
        <Users size={13} aria-hidden="true" />
        {collaborationStatus === 'live'
          ? `${collaboratorCount} live`
          : collaborationStatus === 'conflict'
            ? 'Conflict'
            : collaborationStatus === 'oversize'
              ? 'Local only'
              : collaborationStatus === 'rejected'
                ? 'Not shared'
                : collaborationStatus === 'update-required'
                  ? 'Update required'
                  : collaborationStatus}
      </span>
    </header>
  );
}
