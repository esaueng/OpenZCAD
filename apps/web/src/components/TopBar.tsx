import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  Box,
  Check,
  CloudOff,
  Download,
  Eye,
  Files,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Settings as SettingsIcon,
  SlidersHorizontal,
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
import { StableLabel } from './StableLabel';

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
  /**
   * Why Tweak is unavailable, or null when it is. A read-only collaborator
   * cannot change parameters either, so the reason usually matches Build's.
   */
  tweakModeDisabledReason: string | null;
  onWorkspaceMode(mode: WorkspaceMode): void;
  onSave(): void;
  onImportFiles(files: File[]): void;
  onExportStep(): void;
  /** Opens the mesh export dialog (3MF / STL with quality control). */
  onOpenMeshExport(): void;
  onArchiveLocalSources(): void;
  onExportDiagnostics(): void;
  onExportInteractionLog(): void;
  onRenameProject(name: string): void;
  onGoHome(): void;
  onOpenSharing(): void;
  onOpenSettings(): void;
}

/**
 * The three workspaces, in the order they appear. Each hint doubles as the
 * tooltip body — the one place the difference between the modes is spelled
 * out, which matters most for Tweak, a mode a shared-link visitor may be
 * meeting for the first time.
 */
const WORKSPACE_MODE_OPTIONS: ReadonlyArray<{
  mode: WorkspaceMode;
  label: string;
  hint: string;
  Icon: typeof Eye;
}> = [
  {
    mode: 'view',
    label: 'View',
    hint: 'Read the model. Measure, orbit, inspect — nothing changes.',
    Icon: Eye
  },
  {
    mode: 'tweak',
    label: 'Tweak',
    hint: 'Adjust parameters and export. The design itself stays locked.',
    Icon: SlidersHorizontal
  },
  {
    mode: 'build',
    label: 'Build',
    hint: 'Full modeling workspace. Sketch, features, history.',
    Icon: Box
  }
];

/**
 * Labels a chip cycles through in ordinary use. Each chip reserves the widest
 * of these so a save, a sync or a presence change never resizes it — and no
 * more, so the chip stays as narrow as its own cycle allows. The rare
 * decision states (conflict, repair, update required) may still take extra
 * room while they show, as they demand a look anyway.
 */
const saveStateLabels = (states: readonly WorkspaceSaveState[]) =>
  states.map((state) => WORKSPACE_SAVE_STATE_PRESENTATION[state].topBarLabel);
/** Signed in: the account round-trip. Signed out: device saves only. */
const CLOUD_SAVE_LABEL_RESERVE = saveStateLabels([
  'saving',
  'syncing',
  'synced',
  'offline'
]);
const DEVICE_SAVE_LABEL_RESERVE = saveStateLabels(['saving', 'local']);
const COLLABORATION_LABEL_RESERVE = ['9 live', 'offline'];
const ACCOUNT_LABEL_RESERVE = ['Checking', 'Signed out'];

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
  tweakModeDisabledReason,
  onWorkspaceMode,
  onSave,
  onImportFiles,
  onExportStep,
  onOpenMeshExport,
  onArchiveLocalSources,
  onExportDiagnostics,
  onExportInteractionLog,
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
      <div
        className="mode-switch"
        role="group"
        aria-label="Workspace mode"
        title="Switch between viewing, tweaking parameters and modeling (Ctrl+Shift+M)"
      >
        {WORKSPACE_MODE_OPTIONS.map(({ mode, label, hint, Icon }) => {
          const disabledReason =
            mode === 'build'
              ? buildModeDisabledReason
              : mode === 'tweak'
                ? tweakModeDisabledReason
                : null;
          return (
            <button
              key={mode}
              type="button"
              className={`mode-switch-option${workspaceMode === mode ? ' active' : ''}`}
              aria-pressed={workspaceMode === mode}
              disabled={disabledReason !== null}
              title={disabledReason ?? `${label} — ${hint}`}
              onClick={() => onWorkspaceMode(mode)}
            >
              <Icon size={13} aria-hidden="true" />
              <span className="mode-switch-label">
                <StableLabel reserve={[label]}>{label}</StableLabel>
              </span>
            </button>
          );
        })}
      </div>
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
        className="topbar-actions"
        role="group"
        aria-label="Workspace actions"
      >
        {/* Signed in is the happy default and the save chip already shows
            cloud state, so the account chip appears only when something
            needs attention. */}
        {accountState !== 'signed-in' && (
          <span
            className={`account-state is-${accountState}`}
            role="status"
            title={`Cloud account: ${accountLabel.toLowerCase()}`}
            aria-label={`Cloud account: ${accountLabel.toLowerCase()}`}
          >
            {accountState === 'checking' ? (
              <LoaderCircle className="spin" size={13} aria-hidden="true" />
            ) : (
              <CloudOff size={13} aria-hidden="true" />
            )}
            <StableLabel reserve={ACCOUNT_LABEL_RESERVE} align="center">
              {accountLabel}
            </StableLabel>
          </span>
        )}
        <button
          className={`save-state topbar-action is-${saveState}`}
          type="button"
          disabled={!projectName}
          onClick={onSave}
          title={`${WORKSPACE_SAVE_STATE_PRESENTATION[saveState].title} Click to save a revision (Ctrl+S), or Ctrl+Shift+S to name it.`}
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
          <StableLabel
            reserve={
              accountState === 'signed-in'
                ? CLOUD_SAVE_LABEL_RESERVE
                : DEVICE_SAVE_LABEL_RESERVE
            }
            align="center"
          >
            {WORKSPACE_SAVE_STATE_PRESENTATION[saveState].topBarLabel}
          </StableLabel>
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
            {collaborationStatus === 'live' ? (
              // Only drawn once the row has collapsed to icons; the label
              // carries the count everywhere else.
              <span className="live-badge" aria-hidden="true">
                {collaboratorCount}
              </span>
            ) : null}
            <StableLabel reserve={COLLABORATION_LABEL_RESERVE} align="center">
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
            </StableLabel>
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
              title="Import STEP, STL, or a paired Shapr3D project and STEP"
            >
              <Upload size={13} aria-hidden="true" />
              <span>Import CAD files…</span>
              <input
                type="file"
                aria-label="Import STEP or STL…"
                accept=".shapr,.stl,.step,.stp"
                multiple
                style={{ display: 'none' }}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  if (files.length > 0) {
                    onImportFiles(files);
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
            <button
              type="button"
              className="topbar-menu-item"
              title="Export the on-device log of direct-edit attempts and refusals for troubleshooting"
              onClick={onExportInteractionLog}
            >
              <Download size={13} aria-hidden="true" />
              <span>Export interaction log</span>
              <small>direct edits</small>
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
          className="secondary topbar-action settings-action"
          type="button"
          title="Settings (Ctrl+,)"
          aria-label="Open settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon size={14} aria-hidden="true" />
          Settings
        </button>
      </div>
    </header>
  );
}
