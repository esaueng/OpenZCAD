import { ProjectImportButton } from './ProjectImportButton';
import { platformShortcutLabel } from '../lib/platformShortcut';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  Box,
  Check,
  CircleUserRound,
  CloudOff,
  Download,
  Eye,
  Files,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Save,
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
import { COLLABORATION_LABELS } from '../lib/collaborationLabels';
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
  saveToAccount?: boolean;
  /** Saves a revision: File › Save revision and the save chip's actions. */
  onSave(): void;
  /** Opens the naming dialog: File › Save revision as…. */
  onSaveAs(): void;
  onImportFiles(files: File[]): void;
  projectTransferBusy?: boolean;
  onImportProject?(file: File): void;
  onExportProject?(): void;
  onDownloadArtifact?(artifact: ArtifactRecord): void;
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
// "Joining…" rather than "Connecting…": the room is joined for the opening
// frames of every cloud project, and the longer word would either resize the
// chip on the way in or cost the bar four characters for good.
const COLLABORATION_LABEL_RESERVE = ['9 live', 'Offline', 'Joining…'];
const ACCOUNT_LABEL_RESERVE = ['Checking', 'Signed out'];

type SaveGlyph = 'busy' | 'warning' | 'saved' | 'idle';
function saveGlyphFor(state: WorkspaceSaveState): SaveGlyph {
  if (state === 'saving' || state === 'syncing') return 'busy';
  if (
    state === 'conflict' ||
    state === 'repair' ||
    state === 'refused' ||
    state === 'local-source'
  ) {
    return 'warning';
  }
  return state === 'synced' ? 'saved' : 'idle';
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
  tweakModeDisabledReason,
  onWorkspaceMode,
  saveToAccount = false,
  onSave,
  onSaveAs,
  onImportFiles,
  projectTransferBusy,
  onImportProject,
  onExportProject,
  onDownloadArtifact,
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
  const saveGlyph = saveGlyphFor(saveState);

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

    // Escape closes it like any other menu, handing focus back to its
    // button. It used to ignore the key and stay open.
    function closeFileMenuOnEscape(event: KeyboardEvent) {
      const fileMenu = fileMenuRef.current;
      if (event.key !== 'Escape' || !fileMenu?.open) {
        return;
      }
      event.stopPropagation();
      fileMenu.open = false;
      if (fileMenu.contains(document.activeElement)) {
        fileMenu.querySelector('summary')?.focus();
      }
    }

    document.addEventListener('pointerdown', closeFileMenuOnOutsidePointer);
    // Capture, so the workspace's own Escape (clear the selection) waits for
    // the next press rather than doing both at once.
    document.addEventListener('keydown', closeFileMenuOnEscape, true);
    return () => {
      document.removeEventListener(
        'pointerdown',
        closeFileMenuOnOutsidePointer
      );
      document.removeEventListener('keydown', closeFileMenuOnEscape, true);
    };
  }, []);

  /**
   * Export Mesh… opens a dialog, and the menu stayed open underneath it,
   * still showing when the dialog closed. Items that act in place (a STEP
   * download, the stored-file list) keep the menu open as before.
   */
  function openMeshExportFromMenu() {
    if (fileMenuRef.current) {
      fileMenuRef.current.open = false;
    }
    onOpenMeshExport();
  }

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

  // The chip takes a click only where its label names an action: saving a
  // local project to the account, restoring a broken account copy, or
  // uploading a source that exists only here. Elsewhere it is a readout.
  const saveChipActs =
    saveToAccount || saveState === 'repair' || saveState === 'local-source';
  const presentation = WORKSPACE_SAVE_STATE_PRESENTATION[saveState];
  const saveLabel = saveToAccount
    ? 'Save to my account'
    : presentation.topBarLabel;
  const saveChipContent = (
    <>
      {/* Keyed by the glyph, not the state: saving → syncing keeps the
          same ring turning, and only a change of kind pops. */}
      <span key={saveGlyph} className="save-state-icon" aria-hidden="true">
        {saveGlyph === 'busy' ? (
          <LoaderCircle className="spin" size={14} />
        ) : saveGlyph === 'warning' ? (
          <TriangleAlert size={14} />
        ) : saveGlyph === 'saved' ? (
          <Check size={14} />
        ) : (
          <CloudOff size={14} />
        )}
      </span>
      <StableLabel
        reserve={
          saveToAccount
            ? ['Save to my account']
            : accountState === 'signed-in'
              ? CLOUD_SAVE_LABEL_RESERVE
              : DEVICE_SAVE_LABEL_RESERVE
        }
        align="center"
      >
        {saveLabel}
      </StableLabel>
    </>
  );

  /** Save items close the menu: Save as… opens a dialog over it. */
  function saveFromMenu(name: boolean) {
    if (fileMenuRef.current) {
      fileMenuRef.current.open = false;
    }
    if (name) {
      onSaveAs();
    } else {
      onSave();
    }
  }

  const exportTitle = (format: string) =>
    canExport
      ? `Export ${exportScope ?? 'all bodies'} as ${format}`
      : 'Create a body before exporting';
  const collaborationLabel =
    collaborationStatus === 'live'
      ? `${collaboratorCount} live`
      : COLLABORATION_LABELS[collaborationStatus];
  const accountLabel =
    accountState === 'checking'
      ? 'Checking'
      : accountState === 'signed-in'
        ? 'Signed in'
        : accountState === 'signed-out'
          ? 'Signed out'
          : 'Unavailable';

  const breadcrumb = (
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
  );

  return (
    <header className="topbar">
      {/* Three islands over the stage: who and what (identity), the mode,
          then the actions. The header itself is transparent and lets the
          viewport show between them. */}
      <div className="topbar-island topbar-identity">
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
        {breadcrumb}
      </div>
      <div
        className="mode-switch topbar-island"
        data-active={workspaceMode}
        role="group"
        aria-label="Workspace mode"
        title={`Switch between viewing, tweaking parameters and modeling (${platformShortcutLabel('Ctrl+Shift+M')})`}
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
      {/* The island frame wraps the group rather than padding it: the
          group's children own exactly its width at every breakpoint. */}
      <div className="topbar-island topbar-actions-island">
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
                // A person, not a cloud: at icon-only widths this chip and the
                // "Local only" save chip beside it were two identical
                // cloud-off glyphs.
                <CircleUserRound size={13} aria-hidden="true" />
              )}
              <StableLabel reserve={ACCOUNT_LABEL_RESERVE} align="center">
                {accountLabel}
              </StableLabel>
            </span>
          )}
          {saveChipActs ? (
            <button
              className={`save-state topbar-action is-${saveState}`}
              type="button"
              disabled={!projectName}
              onClick={onSave}
              aria-label={saveLabel}
              title={
                saveToAccount
                  ? 'Save this local project and its source files to your account.'
                  : presentation.title
              }
            >
              {saveChipContent}
            </button>
          ) : (
            // A readout, not a control: clicking "Local only" or "Saved" used
            // to save a revision unasked. Saving is on File and the shortcut.
            <span
              className={`save-state topbar-action is-readout is-${saveState}`}
              role="status"
              aria-label={saveLabel}
              title={`${presentation.title} Save a revision from File or with ${platformShortcutLabel('Ctrl+S')}.`}
            >
              {saveChipContent}
            </span>
          )}
          {projectSharingEnabled ? (
            // Signed out there is nothing to share into, so the chip says so.
            // aria-disabled rather than disabled keeps it focusable, and so
            // keeps the tooltip that explains why it is unavailable.
            <button
              type="button"
              className={`collaboration-state ${collaborationStatus}`}
              title={
                session
                  ? `Project sharing · ${collaborationLabel}`
                  : 'Sign in to share'
              }
              aria-label={
                session
                  ? `Open project sharing · ${collaborationLabel}`
                  : 'Project sharing · Sign in to share'
              }
              aria-disabled={session ? undefined : true}
              disabled={!projectName}
              onClick={session ? onOpenSharing : undefined}
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
                {collaborationLabel}
              </StableLabel>
            </button>
          ) : null}
          <details ref={fileMenuRef} className="topbar-menu file-menu">
            <summary
              className="secondary topbar-action"
              title="Import and export"
              aria-label={`Import and export${
                artifacts.length > 0
                  ? ` · ${artifacts.length} stored ${artifacts.length === 1 ? 'file' : 'files'}`
                  : ''
              }${
                localOnlySourceCount > 0
                  ? ` · ${localOnlySourceCount} import ${localOnlySourceCount === 1 ? 'source needs' : 'sources need'} archiving`
                  : ''
              }`}
            >
              <FolderOpen size={14} aria-hidden="true" />
              File
              {localOnlySourceCount > 0 ? (
                <i className="file-menu-attention" aria-hidden="true" />
              ) : null}
              {artifacts.length > 0 ? (
                <>
                  {' '}
                  <span className="file-menu-count">{artifacts.length}</span>
                </>
              ) : null}
            </summary>
            <div className="topbar-menu-panel">
              <strong className="topbar-menu-label">Save</strong>
              <button
                type="button"
                className="topbar-menu-item"
                disabled={!projectName}
                title="Save a revision of this project"
                onClick={() => saveFromMenu(false)}
              >
                <Save size={13} aria-hidden="true" />
                <span>Save revision</span>
                <small>{platformShortcutLabel('Ctrl+S')}</small>
              </button>
              <button
                type="button"
                className="topbar-menu-item"
                disabled={!projectName}
                title="Save a revision under a name of your choosing"
                onClick={() => saveFromMenu(true)}
              >
                <Save size={13} aria-hidden="true" />
                <span>Save revision as…</span>
                <small>{platformShortcutLabel('Ctrl+Shift+S')}</small>
              </button>
              <div className="topbar-menu-sep" />
              <strong className="topbar-menu-label">Import</strong>
              <label
                className="topbar-menu-item"
                title="Import FreeCAD (.FCStd), STEP, a mesh file (STL, 3MF, OBJ, GLB, PLY), or a paired Shapr3D project and STEP"
              >
                <Upload size={13} aria-hidden="true" />
                <span>Import CAD files…</span>
                <small>FreeCAD · STEP · STL · 3MF · OBJ · GLB · PLY</small>
                <input
                  type="file"
                  aria-label="Import FreeCAD, STEP or a mesh file…"
                  accept=".fcstd,.shapr,.stl,.step,.stp,.3mf,.obj,.glb,.ply"
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
              {onImportProject && (
                <ProjectImportButton
                  onImport={onImportProject}
                  disabled={projectTransferBusy}
                  hint=".openzcad backup"
                />
              )}
              <strong className="topbar-menu-label">Export</strong>
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
                title={exportTitle('3MF, STL, OBJ or glTF')}
                onClick={openMeshExportFromMenu}
              >
                <Download size={13} aria-hidden="true" />
                <span>Export Mesh…</span>
                <small>3MF · STL · OBJ · glTF</small>
              </button>
              {onExportProject && (
                <button
                  type="button"
                  className="topbar-menu-item"
                  disabled={!projectName || projectTransferBusy}
                  onClick={onExportProject}
                >
                  <Download size={13} aria-hidden="true" />
                  <span>Export project</span>
                  <small>complete .openzcad backup</small>
                </button>
              )}
              {localOnlySourceCount > 0 ? (
                <>
                  <div className="topbar-menu-sep" />
                  <button
                    type="button"
                    className="topbar-menu-item"
                    title="Upload import sources that exist only on this device so other devices can rebuild this project"
                    onClick={onArchiveLocalSources}
                  >
                    <Upload size={13} aria-hidden="true" />
                    <span>
                      Archive local sources
                      <span className="topbar-menu-badge">
                        {localOnlySourceCount} file
                        {localOnlySourceCount === 1 ? '' : 's'}
                      </span>
                    </span>
                    <small>
                      {localOnlySourceCount === 1
                        ? 'one import exists only on this device'
                        : 'these imports exist only on this device'}
                    </small>
                  </button>
                </>
              ) : null}
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
                    onClick={
                      onDownloadArtifact
                        ? (event) => {
                            event.preventDefault();
                            onDownloadArtifact(artifact);
                          }
                        : undefined
                    }
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
              <div className="topbar-menu-sep" />
              <strong className="topbar-menu-label">Troubleshooting</strong>
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
            </div>
          </details>
          <button
            className="secondary topbar-action settings-action"
            type="button"
            title={`Settings (${platformShortcutLabel('Ctrl+,')})`}
            aria-label="Open settings"
            onClick={onOpenSettings}
          >
            <SettingsIcon size={14} aria-hidden="true" />
            Settings
          </button>
        </div>
      </div>
    </header>
  );
}
