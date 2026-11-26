import { createContext, useContext, useLayoutEffect } from 'react';
import type { WorkspaceMode } from '../../lib/panelState';
import type { WorkspaceSaveState } from '../../lib/cloudProjectAutosave';
import type { PaletteCommand } from '../CommandBar';
import type { TopBarProps } from '../TopBar';
import type { UnusedMeshPayloadsProps } from '../UnusedMeshPayloads';

/**
 * Where an in-place command's bar goes in the compact workspace (U12 slice
 * 2): into the bottom sheet rather than the stage's foot. The shell provides
 * the sheet's host element; `WorkspaceReadout` portals its command row there
 * and reports whether one is up, which tells the sheet it has content.
 * Absent (the regular workspace), the row stays where it always was.
 */
export interface CompactCommandRowSlot {
  host: HTMLElement | null;
  report(present: boolean): void;
}

export const CompactCommandRowContext =
  createContext<CompactCommandRowSlot | null>(null);

/** The compact sheet's command-row host, or null in the regular workspace. */
export function useCompactCommandRowHost(present: boolean): HTMLElement | null {
  const slot = useContext(CompactCommandRowContext);
  const report = slot?.report;
  useLayoutEffect(() => {
    if (!report) return;
    report(present);
    return () => report(false);
  }, [report, present]);
  return slot?.host ?? null;
}

/**
 * The compact frame is up but its chrome (loaded lazily) has not yet given
 * the host: what goes there waits rather than drawing on the stage first.
 */
export const COMPACT_OVERLAY_HOST_PENDING = 'pending';

export type CompactOverlayHost =
  HTMLElement | typeof COMPACT_OVERLAY_HOST_PENDING | null;

/**
 * Where what must stay usable over the compact sheet at any height goes (U12
 * slice 2): the numeric keypad. The stage is inert while the sheet stands at
 * full, so a keypad drawn on it could be neither focused nor tapped; the
 * compact chrome provides a host outside the stage instead. Null in the
 * regular workspace, where the keypad stays on the stage.
 */
export const CompactOverlayHostContext =
  createContext<CompactOverlayHost>(null);

/**
 * The compact overlay host; `COMPACT_OVERLAY_HOST_PENDING` while the compact
 * frame waits for it; null in the regular workspace.
 */
export function useCompactOverlayHost(): CompactOverlayHost {
  return useContext(CompactOverlayHostContext);
}

/**
 * What the compact workspace's own controls need from the workspace: every
 * one runs a handler the regular workspace already has.
 */
export interface CompactChromeProps {
  projectName: string;
  saveState: WorkspaceSaveState;
  workspaceMode: WorkspaceMode;
  /** Why each mode is locked, or null where it is open. */
  modeLockedReason(mode: WorkspaceMode): string | null;
  /** A shared link shows only the modes it opens, as the top bar does. */
  shareLink: boolean;
  onWorkspaceMode(mode: WorkspaceMode): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onHome(): void;
  onSearch(): void;
  onSettings(): void;
  onHelp(): void;
  /** Brings the modeling guide back from its first step (More › Modeling guide). */
  onGuide?(): void;
  /**
   * The command search is open: the header's search button closes it, as
   * the full-screen search has no other way out by touch.
   */
  searchOpen?: boolean;
  onCloseSearch?(): void;
  /** What the project sheet holds beyond the File menu's actions. */
  project?: CompactProjectSheet | null;
  /** The File menu's actions, as the command bar lists them. */
  fileCommands: readonly PaletteCommand[];
  /** The current pick's name, or null with nothing picked. */
  selectionLabel: string | null;
  onClearSelection?(): void;
  reducedMotion: boolean;
}

/** A stored file the File menu lists, ready to save. */
export interface CompactStoredFile {
  id: string;
  name: string;
  /** Its kind and size, as the File menu words them. */
  detail: string;
  download(): void;
}

/**
 * The project sheet (U12 slice 10), opened by a tap on the header's project
 * name: everything the regular workspace keeps in the top bar's name field,
 * the File menu and the library tile's Properties. Every action runs the
 * handler the regular workspace already has; the File menu's own rows come
 * from `fileCommands`.
 */
export interface CompactProjectSheet {
  /** Why the project cannot be renamed here, or null where it can. */
  renameDisabledReason: string | null;
  onRename(name: string): void;
  /** Opens the project's Properties; null where there are none to show. */
  onProperties: (() => void) | null;
  /** Project sharing, or the way to sign in for it; null where it is off. */
  share: { label: string; run(): void } | null;
  /** The comments pinned to the model; null where they are off. */
  onComments: (() => void) | null;
  /** The File menu's Units row and Convert stored units…. */
  displayUnits: TopBarProps['displayUnits'] | null;
  /** IGES shares the File menu's STEP row. */
  exportIges: { disabledReason: string | null; run(): void } | null;
  /** Imports kept only on this device, to archive to the account. */
  archiveLocalSources: {
    count: number;
    disabledReason: string | null;
    run(): void;
  } | null;
  storedFiles: readonly CompactStoredFile[];
  /** The File menu's clean-up of unused mesh files, where the owner has one. */
  meshCleanup?: UnusedMeshPayloadsProps;
  /** The account's storage, in Settings; null signed out. */
  onStorage: (() => void) | null;
}
