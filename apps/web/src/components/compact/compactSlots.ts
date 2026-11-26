import { createContext, useContext, useLayoutEffect } from 'react';
import type { WorkspaceMode } from '../../lib/panelState';
import type { WorkspaceSaveState } from '../../lib/cloudProjectAutosave';
import type { PaletteCommand } from '../CommandBar';

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
  /** The File menu's actions, as the command bar lists them. */
  fileCommands: readonly PaletteCommand[];
  /** The current pick's name, or null with nothing picked. */
  selectionLabel: string | null;
  onClearSelection?(): void;
  reducedMotion: boolean;
}

/**
 * A mode's tray in the compact sheet (U12 slice 7): View's and Tweak's verbs
 * at peek, each opening a page over the tray. The compact chrome provides
 * this to the tray it draws; the tray draws its open page's content into
 * `pageHost` (a portal), so the page carries the sheet's Back, title and
 * Escape like any page in the back stack. Null outside a tray.
 */
export interface CompactTraySlot {
  /** The page open over the tray, by the tray's own key, or null. */
  page: string | null;
  /** Where that page's content goes while the sheet draws it, else null. */
  pageHost: HTMLElement | null;
  /** Opens a page over the tray at half height; `title` heads the sheet. */
  openPage(key: string, title: string): void;
  /** Back to the tray, the sheet at peek. */
  closePage(): void;
}

export const CompactTrayContext = createContext<CompactTraySlot | null>(null);

/** The tray's page controls; null outside the compact sheet's tray. */
export function useCompactTray(): CompactTraySlot | null {
  return useContext(CompactTrayContext);
}

/**
 * Where the analysis panel (M09's legend, provenance and limits) goes in the
 * compact workspace: View's Display page provides a host, and the viewer
 * draws the panel there rather than over the stage's foot, where the sheet
 * stands. Null in the regular workspace.
 */
export interface CompactAnalysisSlot {
  host: HTMLElement | null;
  setHost(element: HTMLElement | null): void;
}

export const CompactAnalysisSlotContext =
  createContext<CompactAnalysisSlot | null>(null);
