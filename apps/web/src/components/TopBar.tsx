import { ProjectImportButton } from './ProjectImportButton';
import { labelWithKey, useKeymap } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  Box,
  Check,
  CircleUserRound,
  CloudOff,
  Download,
  Files,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Save,
  Settings as SettingsIcon,
  TriangleAlert,
  Upload,
  UserPlus,
  Users
} from 'lucide-react';
import type { ArtifactRecord, AuthSession, UnitSystem } from '@openzcad/shared';
import { BrandMark } from './BrandMark';
import {
  EncryptionIndicator,
  type EncryptionIndicatorProps
} from './EncryptionIndicator';
import { isEncryptedProject } from '../lib/api';
import type { WorkspaceMode } from '../lib/panelState';
import type { CollaborationStatus } from '../lib/useCollaboration';
import { COLLABORATION_LABELS } from '../lib/collaborationLabels';
import type { WorkspaceSaveState } from '../lib/cloudProjectAutosave';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from '../lib/workspaceSaveStatePresentation';
import { StableLabel } from './StableLabel';
import { Tooltip } from './Tooltip';
import {
  ACCOUNT_LABEL_RESERVE,
  COLLABORATION_LABEL_RESERVE,
  WORKSPACE_MODE_OPTIONS,
  saveGlyphFor,
  type SaveGlyph
} from '../lib/topBarPresentation';
import { createLazyPanel } from './LazyPanel';
import type { UnusedMeshPayloadsProps } from './UnusedMeshPayloads';

const UnusedMeshPayloads = createLazyPanel<UnusedMeshPayloadsProps>(
  'Mesh cleanup',
  () => import('./UnusedMeshPayloads')
);

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
  /** Recovery guidance when no bodies are available in the export scope. */
  exportUnavailableReason?: string | null;
  /**
   * Why export is holding bodies back: they stand in for a feature that
   * failed to rebuild. Shown in the File menu beside the export items.
   */
  exportWithheld?: string | null;
  saveState: WorkspaceSaveState;
  geometryPending?: boolean;
  geometryFailed?: boolean;
  /** A proposed direct edit has not passed validation or been saved yet. */
  editPending?: boolean;
  editRefusal?: string | null;
  onReviewEditFailure?(): void;
  /**
   * Import sources that exist only in this browser because their cloud
   * archival failed. Nonzero shows the File-menu action that retries the
   * upload without reimporting.
   */
  localOnlySourceCount: number;
  artifacts: ArtifactRecord[];
  meshCleanup?: UnusedMeshPayloadsProps;
  session: AuthSession | null;
  accountState: 'checking' | 'signed-in' | 'signed-out' | 'unavailable';
  collaborationStatus: CollaborationStatus;
  collaborationFailure?: string | null;
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
  /** Why the Drawing workspace cannot open, or null (absent: never locked). */
  drawingModeDisabledReason?: string | null;
  onWorkspaceMode(mode: WorkspaceMode): void;
  saveToAccount?: boolean;
  /**
   * The account's project list was read and this project is not on it. Only
   * then is "Not shared" a fact; an unreachable account cannot say whether
   * the project is in it, and keeps the room's own status.
   */
  knownDeviceOnly?: boolean;
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
  /** Opens the image export dialog (view PNG / sketch SVG). */
  onOpenImageExport?(): void;
  onArchiveLocalSources(): void;
  onExportDiagnostics(): void;
  onExportInteractionLog(): void;
  onRenameProject(name: string): void;
  onGoHome(): void;
  onOpenSharing(): void;
  /**
   * Where the sharing chip goes while signed out: Settings → Account, so the
   * one action it points at is a click away instead of a dead button.
   */
  onSignIn?(): void;
  onOpenSettings(): void;
  /**
   * The open project's encryption status, only for an end-to-end encrypted
   * project (ADR-024 Phase 4). Absent or null, nothing is shown.
   */
  encryption?: EncryptionIndicatorProps | null;
}

/**
 * One glyph per presence state, so the icon-only chip tells them apart
 * without its tooltip: an invitation while nothing is shared, the group
 * faded while joining and struck through while offline. Colour still marks
 * live (green) and the states that need a look (amber), via the chip.
 */
function PresenceGlyph({
  status
}: {
  status: CollaborationStatus | 'not-shared';
}) {
  if (status === 'not-shared') {
    return <UserPlus size={14} aria-hidden="true" />;
  }
  return (
    <span
      className={`presence-glyph${status === 'connecting' ? ' is-joining' : status === 'offline' ? ' is-offline' : ''}`}
      aria-hidden="true"
    >
      <Users size={14} />
    </span>
  );
}

export function TopBar({
  projectName,
  units,
  canExport,
  exportScope,
  exportWithheld = null,
  exportUnavailableReason = null,
  saveState,
  geometryPending = false,
  geometryFailed = false,
  editPending = false,
  editRefusal: proposedEditRefusal = null,
  onReviewEditFailure,
  localOnlySourceCount,
  artifacts: storedArtifacts,
  meshCleanup,
  session,
  accountState,
  collaborationStatus,
  collaborationFailure,
  collaboratorCount,
  projectSharingEnabled,
  workspaceMode,
  canRenameProject,
  buildModeDisabledReason,
  tweakModeDisabledReason,
  drawingModeDisabledReason = null,
  onWorkspaceMode,
  saveToAccount = false,
  knownDeviceOnly = false,
  onSave,
  onSaveAs,
  onImportFiles,
  projectTransferBusy,
  onImportProject,
  onExportProject,
  onDownloadArtifact,
  onExportStep,
  onOpenMeshExport,
  onOpenImageExport,
  onArchiveLocalSources,
  onExportDiagnostics,
  onExportInteractionLog,
  onRenameProject,
  onGoHome,
  onOpenSharing,
  onSignIn,
  onOpenSettings,
  encryption = null
}: TopBarProps) {
  const keymap = useKeymap();
  const saveKey = keymap.label('file-save');
  const saveNamedKey = keymap.label('file-save-named');
  // A mesh payload is the import's internal triangles, not a file anyone
  // picked or would download; the original upload is listed beside it. A
  // reference image's picture is internal to its image in the same way.
  const artifacts = storedArtifacts.filter(
    (artifact) =>
      artifact.kind !== 'mesh-payload' && artifact.kind !== 'reference-image'
  );
  const [editingProjectName, setEditingProjectName] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState(projectName ?? '');
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const projectTitleButtonRef = useRef<HTMLButtonElement>(null);
  // Enter and Escape end the rename with focus in the field it removes;
  // the title takes it back. A blur commit leaves focus where it went.
  const refocusProjectTitleRef = useRef(false);
  const fileMenuRef = useRef<HTMLDetailsElement>(null);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  // A saved document can still be preparing its model. Keep the storage
  // label and show preparation separately, rather than relying on a spinner.
  const modelPending =
    !saveToAccount && saveState === 'synced' && geometryPending;
  // The saved revision is still safe, but the proposed edit is not in it.
  // Keep actionable storage failures visible rather than masking them.
  const checkingEdit =
    !saveToAccount &&
    editPending &&
    (saveState === 'synced' || saveState === 'local');
  // A refused proposal must not cover a device/account save failure or a
  // newer validation in progress. The saved revision remains unchanged.
  const editRefusal =
    !editPending && ['local', 'synced', 'syncing'].includes(saveState)
      ? proposedEditRefusal
      : null;
  const saveGlyph: SaveGlyph = checkingEdit
    ? 'busy'
    : editRefusal
      ? 'warning'
      : modelPending && geometryFailed
        ? 'warning'
        : saveGlyphFor(saveState);

  useEffect(() => {
    if (editingProjectName) {
      projectNameInputRef.current?.select();
    } else if (refocusProjectTitleRef.current) {
      refocusProjectTitleRef.current = false;
      projectTitleButtonRef.current?.focus();
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
   * Closes the menu for an item that opens a dialog. The dialog hands focus
   * back to whatever had it when it opened, and an item inside the closed
   * menu cannot take it — focus fell to <body> — so the File button takes
   * it first.
   */
  function closeFileMenuForDialog() {
    const fileMenu = fileMenuRef.current;
    if (!fileMenu) {
      return;
    }
    fileMenu.querySelector('summary')?.focus();
    fileMenu.open = false;
  }

  /**
   * Export mesh… opens a dialog, and the menu stayed open underneath it,
   * still showing when the dialog closed. Items that act in place (the
   * stored-file list) keep the menu open as before.
   */
  function openMeshExportFromMenu() {
    closeFileMenuForDialog();
    onOpenMeshExport();
  }

  /**
   * A STEP export runs in the background and reports its progress and result
   * in the activity pill and status line. With the menu left open over them
   * the click looked like it had done nothing, so the menu closes first and
   * the File button keeps focus, as it does for a dialog.
   */
  function exportStepFromMenu() {
    closeFileMenuForDialog();
    onExportStep();
  }

  function openImageExportFromMenu() {
    closeFileMenuForDialog();
    onOpenImageExport?.();
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
  const reviewRefusal = Boolean(editRefusal && onReviewEditFailure);
  const saveChipActs =
    reviewRefusal ||
    saveToAccount ||
    saveState === 'repair' ||
    saveState === 'local-source';
  const presentation = WORKSPACE_SAVE_STATE_PRESENTATION[saveState];
  const saveText = editRefusal
    ? 'Edit not applied'
    : saveToAccount
      ? 'Save to my account'
      : checkingEdit
        ? 'Checking'
        : presentation.topBarLabel;
  const modelReadiness =
    !checkingEdit && !editRefusal && modelPending
      ? geometryFailed
        ? 'model unavailable'
        : 'preparing model'
      : null;
  const readinessVisible = modelReadiness !== null && geometryFailed;
  // The revision is saved; the model is still being built. A cube drawing
  // itself stands in for the check until it is ready. A spinner beside
  // "Saved" read as a save still in flight.
  const modelPreparing = modelReadiness !== null && !geometryFailed;
  // The accessible name keeps the readiness the glyph shows, and still
  // begins with the visible label (WCAG 2.5.3).
  const saveLabel = modelReadiness
    ? `${saveText} · ${modelReadiness}`
    : saveText;
  const saveTitle = editRefusal
    ? `${editRefusal} Open the activity log for details.`
    : checkingEdit
      ? `The proposed edit is being checked before it is applied and saved. ${presentation.title}`
      : `${presentation.title}${geometryPending ? (geometryFailed ? ' Exact geometry is unavailable; see the activity log.' : ' Preparing exact geometry. Face and edge edits become available when it finishes.') : ''}`;
  const saveChipContent = (
    <>
      <StableLabel reserve={[saveText]}>
        {/* Keyed by the glyph, not the state: saving → syncing keeps the
            same ring turning, and only a change of kind pops. */}
        <span
          key={modelPreparing ? 'model' : saveGlyph}
          className="save-state-icon"
          aria-hidden="true"
        >
          {modelPreparing ? (
            <Box size={14} className="save-model-glyph" />
          ) : saveGlyph === 'busy' ? (
            <LoaderCircle className="spin" size={14} />
          ) : saveGlyph === 'warning' ? (
            <TriangleAlert size={14} />
          ) : saveGlyph === 'saved' ? (
            <Check size={14} />
          ) : (
            <CloudOff size={14} />
          )}
        </span>
        {saveText}
      </StableLabel>
      {/* Readiness is announced alongside the storage label. Preparing is
          shown by the cube alone (the tooltip spells it out); a failed
          model stays in words, as it needs a look. */}
      {modelReadiness ? (
        <span
          className={`save-model-readiness${readinessVisible ? '' : ' visually-hidden'}`}
        >
          {' '}
          · {modelReadiness}
        </span>
      ) : null}
    </>
  );

  /** Save items close the menu: Save as… opens a dialog over it. */
  function saveFromMenu(name: boolean) {
    closeFileMenuForDialog();
    if (name) {
      onSaveAs();
    } else {
      onSave();
    }
  }

  const exportTitle = (format: string) =>
    canExport
      ? `Export ${exportScope ?? 'all bodies'} as ${format}${exportWithheld ? `. ${exportWithheld}` : ''}`
      : (exportWithheld ??
        exportUnavailableReason ??
        'Create a body before exporting');
  // A project that is not in the account has no room to join, so its room
  // status is `offline` — which, beside "Save to my account", read as a
  // connection problem rather than the plain fact that nothing is shared yet.
  const collaborationLabel = knownDeviceOnly
    ? 'Not shared'
    : collaborationStatus === 'live'
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
                refocusProjectTitleRef.current = true;
                commitProjectRename();
              } else if (event.key === 'Escape') {
                // The rename's own cancel; in a sketch the workspace would
                // also climb the sketch's Escape ladder.
                event.preventDefault();
                event.stopPropagation();
                refocusProjectTitleRef.current = true;
                setProjectNameDraft(projectName);
                setEditingProjectName(false);
              }
            }}
          />
        ) : canRenameProject ? (
          <button
            ref={projectTitleButtonRef}
            className="project-title-button"
            type="button"
            // Carries the name it shows (WCAG 2.5.3). The action leads: a
            // project named after a command would otherwise answer to that
            // command's name.
            aria-label={`Rename project ${projectName}`}
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
        {/* Beside the breadcrumb, not in it: the breadcrumb clips overflow
            for the name's ellipsis, and would clip the popover too. */}
        {encryption && projectName ? (
          <EncryptionIndicator {...encryption} />
        ) : null}
        {/* The save status belongs to the document, so it follows its name.
            This island is anchored at its left edge with open stage beyond
            it, so a label change moves nothing; the actions island keeps a
            fixed width with no status slot to reserve. */}
        {saveChipActs ? (
          <button
            className={`save-state topbar-action is-${saveState}`}
            type="button"
            disabled={!projectName}
            onClick={reviewRefusal ? onReviewEditFailure : onSave}
            aria-label={saveLabel}
            title={
              saveToAccount && !editRefusal
                ? 'Save this local project and its source files to your account.'
                : saveTitle
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
            title={`${saveTitle} Save a revision from File${saveKey ? ` or with ${platformShortcutLabel(saveKey)}` : ''}.`}
          >
            {saveChipContent}
          </span>
        )}
      </div>
      <div
        className="mode-switch topbar-island"
        data-active={workspaceMode}
        role="group"
        aria-label="Workspace mode"
      >
        {WORKSPACE_MODE_OPTIONS.map(({ mode, label, hint, Icon }) => {
          const disabledReason =
            mode === 'build'
              ? buildModeDisabledReason
              : mode === 'tweak'
                ? tweakModeDisabledReason
                : mode === 'drawing'
                  ? drawingModeDisabledReason
                  : null;
          return (
            <Tooltip
              key={mode}
              multiline
              label={label}
              description={disabledReason ?? hint}
              shortcut={keymap.label('workspace-mode-cycle')}
            >
              <button
                type="button"
                className={`mode-switch-option${workspaceMode === mode ? ' active' : ''}`}
                aria-pressed={workspaceMode === mode}
                aria-label={label}
                disabled={disabledReason !== null}
                title={disabledReason ?? undefined}
                onClick={() => onWorkspaceMode(mode)}
              >
                <Icon size={13} aria-hidden="true" />
                <span className="mode-switch-label">
                  <StableLabel reserve={[label]}>{label}</StableLabel>
                </span>
              </button>
            </Tooltip>
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
          {/* Signed in is the happy default and the save status already shows
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
          {projectSharingEnabled ? (
            // Signed out there is nothing to share into, so the chip says so
            // and takes the user to where signing in happens. It used to be
            // aria-disabled: a button that did nothing when pressed.
            <button
              type="button"
              className={`collaboration-state ${collaborationStatus}`}
              title={
                session
                  ? collaborationFailure && collaborationStatus === 'rejected'
                    ? `Connection refused: ${collaborationFailure}`
                    : `Project sharing · ${collaborationLabel}`
                  : 'Sign in to share'
              }
              // Each name carries the label the chip shows (WCAG 2.5.3).
              aria-label={
                session
                  ? `Open project sharing · ${collaborationLabel}`
                  : `${collaborationLabel} · Sign in to share`
              }
              disabled={!projectName}
              onClick={session ? onOpenSharing : onSignIn}
            >
              <PresenceGlyph
                status={knownDeviceOnly ? 'not-shared' : collaborationStatus}
              />
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
          <details
            ref={fileMenuRef}
            className="topbar-menu file-menu"
            onToggle={(event) => setFileMenuOpen(event.currentTarget.open)}
            // Tabbing past its last item left it open over the stage. Only a
            // move to another control closes it: a press on its own labels
            // drops focus to nothing, and the pointer handler covers clicks.
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && !event.currentTarget.contains(next)) {
                event.currentTarget.open = false;
              }
            }}
          >
            <summary
              className="secondary topbar-action"
              title="File: save, import and export"
              aria-label={`File${
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
                {saveKey && <small>{platformShortcutLabel(saveKey)}</small>}
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
                {saveNamedKey && (
                  <small>{platformShortcutLabel(saveNamedKey)}</small>
                )}
              </button>
              <div className="topbar-menu-sep" />
              <strong className="topbar-menu-label">Import</strong>
              {/* A button beside its input, as ProjectImportButton is: a
                  label around a display:none input took no focus, so Tab
                  went past it. */}
              <button
                type="button"
                className="topbar-menu-item"
                title="Import FreeCAD (.FCStd), STEP, a mesh file (STL, 3MF, OBJ, GLB, PLY), a DXF drawing as a sketch, or a paired Shapr3D project and STEP"
                // The format list stays in its title: in the name it made
                // this item answer to "STEP" beside Export STEP.
                aria-label="Import CAD files…"
                onClick={() => importInputRef.current?.click()}
              >
                <Upload size={13} aria-hidden="true" />
                <span>Import CAD files…</span>
                <small>
                  FreeCAD · STEP · STL · 3MF · OBJ · GLB · PLY · DXF
                </small>
              </button>
              <input
                ref={importInputRef}
                type="file"
                aria-label="Import FreeCAD, STEP or a mesh file…"
                accept=".fcstd,.shapr,.stl,.step,.stp,.3mf,.obj,.glb,.ply,.dxf"
                multiple
                hidden
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  if (files.length > 0) {
                    onImportFiles(files);
                  }
                }}
              />
              {onImportProject && (
                <ProjectImportButton
                  onImport={onImportProject}
                  disabled={projectTransferBusy}
                  hint=".openzcad backup"
                />
              )}
              <div className="topbar-menu-sep" />
              <strong className="topbar-menu-label">Export</strong>
              {exportWithheld && (
                <span className="topbar-menu-note" role="note">
                  {exportWithheld}
                </span>
              )}
              <button
                type="button"
                className="topbar-menu-item"
                disabled={!canExport}
                title={exportTitle('STEP')}
                onClick={exportStepFromMenu}
              >
                <Download size={13} aria-hidden="true" />
                <span>Export STEP</span>
                <small>{exportScope ?? 'all bodies'}</small>
              </button>
              <button
                type="button"
                className="topbar-menu-item"
                disabled={!canExport}
                title={exportTitle('3MF, STL, OBJ, glTF or PLY')}
                onClick={openMeshExportFromMenu}
              >
                <Download size={13} aria-hidden="true" />
                <span>Export mesh…</span>
                <small>3MF · STL · OBJ · glTF · PLY</small>
              </button>
              {onOpenImageExport && (
                <button
                  type="button"
                  className="topbar-menu-item"
                  disabled={!projectName}
                  title="Export the current view as a PNG, or a sketch as an exact SVG"
                  onClick={openImageExportFromMenu}
                >
                  <Download size={13} aria-hidden="true" />
                  <span>Export image…</span>
                  <small>PNG view · SVG sketch</small>
                </button>
              )}
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
                    // An encrypted project's file has no plaintext route:
                    // the click decrypts it and saves it from a blob URL.
                    {...(isEncryptedProject(artifact.projectId)
                      ? { href: '#' }
                      : {
                          href: `/api/artifacts/${artifact.artifactId}/download`,
                          download: artifact.name
                        })}
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
              {fileMenuOpen && meshCleanup ? (
                <UnusedMeshPayloads
                  key={meshCleanup.document.projectId}
                  {...meshCleanup}
                />
              ) : null}
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
            title={labelWithKey('Settings', keymap.label('app-settings'))}
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
