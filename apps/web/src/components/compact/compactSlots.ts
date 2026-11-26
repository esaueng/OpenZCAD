import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode
} from 'react';
import type { WorkspaceMode } from '../../lib/panelState';
import type {
  SelectionCalloutVerb,
  SelectionCalloutVerbId
} from '../../lib/selectionCallout';
import type { CompactPanelId } from './panelSheet';
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
 * Marks what the compact sheet made inert while it stands at full height
 * (U12 slice 5). The workspace keymap reads it: a stage held behind the
 * sheet is out of reach of the model's keys, but the global ones (Ctrl+\,
 * Ctrl+K, Undo and the rest) still apply, as they do over the regular
 * workspace's panels.
 */
export const SHEET_INERT_ATTRIBUTE = 'data-sheet-inert';

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
  /**
   * A shared link's visitor: copy the model into a project of their own.
   * Offered whenever the regular top bar offers it, whatever the link's
   * mode; absent outside a share session.
   */
  onMakeCopy?(): void;
  reducedMotion: boolean;
  /** The panel sheet (slice 5): History, Objects and the rest. */
  panels: CompactPanels;
  /** What the selection sheet offers for the current pick (slice 5). */
  selection: CompactSelectionSheet | null;
  /**
   * The top bar's "Edit not applied": the latest refused edit, with the
   * handler that brings it back (its message, its form and the value
   * tried). Null while there is none.
   */
  editRefusal: { message: string; onReview(): void } | null;
}

/**
 * The panel sheet (U12 slice 5): one segmented sheet page for the model
 * panels and Comments. The workspace holds which panel is open, so every
 * route to a panel (More, the command bar, Ctrl+\, the warning count)
 * opens the same page.
 */
export interface CompactPanels {
  /** The panel shown, or null while the sheet is shut. */
  open: CompactPanelId | null;
  /** The segments on offer, in order. */
  available: readonly CompactPanelId[];
  /** Why the panels cannot open now (a mode without them), or null. */
  disabledReason: string | null;
  /** The open panel's body, drawn from the workspace's current state. */
  content: ReactNode;
  /** Opens a panel, or shuts the sheet with null. */
  onOpen(panel: CompactPanelId | null): void;
  /** Warnings on the model; the header's count opens Diagnostics. */
  warningCount: number;
}

/** One action the selection sheet offers. */
export interface CompactSelectionAction {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Why it cannot run now, shown in place of running it; null runs. */
  disabledReason?: string | null;
  run(): void;
}

/**
 * The selection sheet (U12 slice 5): the pick's verbs as the verb rail
 * offers them, the picks a double-click makes on the regular stage, and
 * the selection filter.
 */
export interface CompactSelectionSheet {
  /** The verb rail's verbs for the pick, as the rail draws them. */
  verbs: readonly SelectionCalloutVerb[];
  onVerb(id: SelectionCalloutVerbId): void;
  /** Select body, Select connected: each only where it applies. */
  picks: readonly CompactSelectionAction[];
  filter: {
    options: readonly { id: string; label: string }[];
    /** The filter in force. */
    current: string;
    onChange(id: string): void;
  } | null;
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
