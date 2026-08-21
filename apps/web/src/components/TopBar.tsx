import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  Check,
  Cloud,
  CloudOff,
  Download,
  Files,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Settings as SettingsIcon,
  TriangleAlert,
  Upload,
  Users
} from 'lucide-react';
import type { ArtifactRecord, AuthSession, UnitSystem } from '@openzcad/shared';
import { BrandMark } from './BrandMark';
import type { WorkspaceMode } from '../lib/panelState';
import type { CollaborationStatus } from '../lib/useCollaboration';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from '../lib/workspaceSaveStatePresentation';

/**
 * What the save button says, per state. Every one of these except `saving`
 * means the work is already stored on this device — the wording differentiates
 * how far it has got beyond that, and never implies work is at risk when it is
 * not.
 */
interface TopBarProps {
  projectName: string | null;
  units: UnitSystem | null;
  canExport: boolean;
  /** Name of the body the export will target, or null for "all bodies". */
  exportScope: string | null;
  saveState: WorkspaceSaveState;
  /**
   * Import sources that exist only in this browser because their cloud
   * archival failed. Nonzero shows the File-menu action that retries the
   * upload without reimporting.
   */
  localOnlySourceCount: number;
  artifacts: ArtifactRecord[];
  session: AuthSession | null;
  accountState: 'checking' | 'signed-in' | 'signed-out' | 'unavailable';
  collaborationStatus: CollaborationStatus;
  collaboratorCount: number;
  projectSharingEnabled: boolean;
  workspaceMode: WorkspaceMode;
  canRenameProject: boolean;
  /**
   * Why Build is unavailable, or null when it is. A read-only share has no
   * build workspace to switch to, so the control says so rather than offering
   * a mode that would refuse every edit.
   */
  buildModeDisabledReason: string | null;
  onWorkspaceMode(mode: WorkspaceMode): void;
  onSave(): void;
  onImportFile(file: File): void;
  onExportStep(): void;
  /** Opens the mesh export dialog (3MF / STL with quality control). */
  onOpenMeshExport(): void;
  onArchiveLocalSources(): void;
  onExportDiagnostics(): void;
  onRenameProject(name: string): void;
  onGoHome(): void;
  onOpenSharing(): void;
  onOpenSettings(): void;
}

export function TopBar({
  projectName,
  units,
  canExport,
  exportScope,
  saveState,
  localOnlySourceCount,
  artifacts,
  session,
  accountState,
  collaborationStatus,
  collaboratorCount,
  projectSharingEnabled,
  workspaceMode,
  canRenameProject,
  buildModeDisabledReason,
  onWorkspaceMode,
  onSave,
  onImportFile,
  onExportStep,
  onOpenMeshExport,
  onArchiveLocalSources,
  onExportDiagnostics,
  onRenameProject,
  onGoHome,
  onOpenSharing,
  onOpenSettings
}: TopBarProps) {
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState(projectName ?? '');
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const fileMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (editingProjectName) {
      projectNameInputRef.current?.select();
    }
  }, [editingProjectName]);

  useEffect(() => {
    function closeFileMenuOnOutsidePointer(event: PointerEvent) {
      const fileMenu = fileMenuRef.current;
      if (
        fileMenu?.open &&
        event.target instanceof Node &&
        !fileMenu.contains(event.target)
      ) {
        fileMenu.open = false;
      }
    }

    document.addEventListener('pointerdown', closeFileMenuOnOutsidePointer);
    return () => {
      document.removeEventListener(
        'pointerdown',
        closeFileMenuOnOutsidePointer
      );
    };
  }, []);

  function beginProjectRename() {
    if (!projectName || !canRenameProject) {
      return;
    }
    setProjectNameDraft(projectName);
    setEditingProjectName(true);
  }

  function commitProjectRename() {
    const nextName = projectNameDraft.trim();
    setEditingProjectName(false);
    if (canRenameProject && nextName && nextName !== projectName) {
      onRenameProject(nextName);
      return;
    }
    setProjectNameDraft(projectName ?? '');
  }

  const exportTitle = (format: string) =>
    canExport
      ? `Export ${exportScope ?? 'all bodies'} as ${format}`
      : 'Create a body before exporting';
  const accountLabel =
    accountState === 'checking'
      ? 'Checking'
      : accountState === 'signed-in'
        ? 'Signed in'
        : accountState === 'signed-out'
          ? 'Signed out'
          : 'Unavailable';

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
          editingProjectName && canRenameProject ? (
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
          ) : canRenameProject ? (
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
          ) : (
            <strong>{projectName}</strong>
          )
        ) : (
          <strong>No project</strong>
        )}
        {projectName && <span className="mono">{units ?? ''}</span>}
      </div>
      <div
        className="mode-switch"
        role="group"
        aria-label="Workspace mode"
        title={
          buildModeDisabledReason
            ? `View mode · ${buildModeDisabledReason}`
            : 'Switch between viewing and modeling (Ctrl+Shift+M)'
        }
      >
        {(['view', 'build'] as const).map((mode) => {
          const disabledReason =
            mode === 'build' ? buildModeDisabledReason : null;
          return (
            <button
              key={mode}
              type="button"
              className={`mode-switch-option${workspaceMode === mode ? ' active' : ''}`}
              aria-pressed={workspaceMode === mode}
              disabled={disabledReason !== null}
              title={disabledReason ?? undefined}
              onClick={() => onWorkspaceMode(mode)}
            >
              {mode === 'view' ? 'View' : 'Build'}
            </button>
          );
        })}
      </div>
      <div
        className="topbar-actions"
        role="group"
        aria-label="Workspace actions"
      >
        <span
          className={`account-state is-${accountState}`}
          role="status"
          title={`Cloud account: ${accountLabel.toLowerCase()}`}
          aria-label={`Cloud account: ${accountLabel.toLowerCase()}`}
        >
          {accountState === 'checking' ? (
            <LoaderCircle className="spin" size={13} aria-hidden="true" />
          ) : accountState === 'signed-in' ? (
            <Cloud size={13} aria-hidden="true" />
          ) : (
            <CloudOff size={13} aria-hidden="true" />
          )}
          {accountLabel}
        </span>
        <button
          className={`save-state topbar-action is-${saveState}`}
          type="button"
          disabled={!projectName}
          onClick={onSave}
          title={`${WORKSPACE_SAVE_STATE_PRESENTATION[saveState].title} Click to save a revision (Ctrl+S).`}
        >
          {saveState === 'saving' || saveState === 'syncing' ? (
            <LoaderCircle className="spin" size={14} aria-hidden="true" />
          ) : saveState === 'conflict' ||
            saveState === 'repair' ||
            saveState === 'refused' ||
            saveState === 'local-source' ? (
            <TriangleAlert size={14} aria-hidden="true" />
          ) : saveState === 'synced' ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <CloudOff size={14} aria-hidden="true" />
          )}
          {WORKSPACE_SAVE_STATE_PRESENTATION[saveState].topBarLabel}
        </button>
        {projectSharingEnabled ? (
          <button
            type="button"
            className={`collaboration-state ${collaborationStatus}`}
            title={`Project sharing · collaboration: ${collaborationStatus}`}
            aria-label="Open project sharing"
            disabled={!projectName || !session}
            onClick={onOpenSharing}
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
          </button>
        ) : null}
        <details ref={fileMenuRef} className="topbar-menu file-menu">
          <summary
            className="secondary topbar-action"
            title="Import and export"
          >
            <FolderOpen size={14} aria-hidden="true" />
            File{artifacts.length > 0 ? ` ${artifacts.length}` : ''}
          </summary>
          <div className="topbar-menu-panel">
            <label
              className="topbar-menu-item"
              title="Import an editable STEP solid or STL mesh"
            >
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
              onClick={onExportStep}
            >
              <Download size={13} aria-hidden="true" />
              <span>Export STEP</span>
              <small>{exportScope ?? 'all bodies'}</small>
            </button>
            <button
              type="button"
              className="topbar-menu-item"
              disabled={!canExport}
              title={exportTitle('3MF or STL')}
              onClick={onOpenMeshExport}
            >
              <Download size={13} aria-hidden="true" />
              <span>Export Mesh…</span>
              <small>3MF · STL</small>
            </button>
            {localOnlySourceCount > 0 ? (
              <button
                type="button"
                className="topbar-menu-item"
                title="Upload import sources that exist only on this device so other devices can rebuild this project"
                onClick={onArchiveLocalSources}
              >
                <Upload size={13} aria-hidden="true" />
                <span>Archive local sources</span>
                <small>
                  {localOnlySourceCount} file
                  {localOnlySourceCount === 1 ? '' : 's'}
                </small>
              </button>
            ) : null}
            <button
              type="button"
              className="topbar-menu-item"
              title="Export a sanitized feature-history snapshot for troubleshooting"
              onClick={onExportDiagnostics}
            >
              <Download size={13} aria-hidden="true" />
              <span>Export diagnostics</span>
              <small>sanitized JSON</small>
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
          className="icon-button"
          type="button"
          title="Settings (Ctrl+,)"
          aria-label="Open settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon size={15} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
