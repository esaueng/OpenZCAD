import { createContext, useCallback, useContext, useLayoutEffect } from 'react';
import type { WorkspaceMode } from '../../lib/panelState';
import type { WorkspaceSaveState } from '../../lib/cloudProjectAutosave';
import type {
  SelectionCalloutVerb,
  SelectionCalloutVerbId
} from '../../lib/selectionCallout';
import type { CommandContext } from '../../lib/commandContext';
import type { ToolAvailability, ToolId } from '../../lib/tools';
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
  /**
   * Where a running command's bar, drawn as the tray, takes the keypad: in
   * the bar under its pinned row (U12 slice 4), so the keypad scrolls under
   * Cancel and Done rather than pushing them out of the sheet. Null when the
   * bar goes.
   */
  keypadSlot?(element: HTMLElement | null): void;
}

export const CompactCommandRowContext =
  createContext<CompactCommandRowSlot | null>(null);

/**
 * Marks what owns its own keys and focus inside or over the compact sheet
 * (the numeric keypad's hosts): the sheet neither pulls focus out of it
 * nor takes its Escape.
 */
export const SHEET_OVERLAY_ATTRIBUTE = 'data-sheet-overlay';

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
 * Whether a running command's bar is drawn as the compact sheet's tray (U12
 * slice 4): one pinned row of the tool's icon, its step, Options, Cancel and
 * Done, with everything else in the sheet's flow under it. False on the
 * regular stage, where the bar keeps its own layout.
 */
export const CompactCommandTrayContext = createContext(false);

export function useCompactCommandTray(): boolean {
  return useContext(CompactCommandTrayContext);
}

/** The tray bar's ref for its keypad slot; a no-op outside the tray. */
export function useCompactKeypadSlot(): (element: HTMLElement | null) => void {
  const slot = useContext(CompactCommandRowContext);
  const tray = useContext(CompactCommandTrayContext);
  const keypadSlot = slot?.keypadSlot;
  return useCallback(
    (element: HTMLElement | null) => {
      if (tray) keypadSlot?.(element);
    },
    [keypadSlot, tray]
  );
}

/**
 * Asks the compact sheet holding `from` to stand at least this high: a
 * bar's Options, a refusal or the keypad need room the tray row has not.
 * A DOM event, so a command drawn anywhere in the sheet can ask without
 * knowing the sheet; outside one it goes nowhere.
 */
export const COMPACT_SHEET_RAISE_EVENT = 'openzcad:compact-sheet-raise';

export type CompactSheetRaise = 'half' | 'full';

export function raiseCompactSheet(
  from: Element | null,
  detent: CompactSheetRaise = 'half'
): void {
  from?.dispatchEvent(
    new CustomEvent<CompactSheetRaise>(COMPACT_SHEET_RAISE_EVENT, {
      bubbles: true,
      detail: detent
    })
  );
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
  /**
   * A shared link's visitor: copy the model into a project of their own.
   * Offered whenever the regular top bar offers it, whatever the link's
   * mode; absent outside a share session.
   */
  onMakeCopy?(): void;
  reducedMotion: boolean;
  /**
   * Build's tray at rest (U12 slice 4): the suggested verbs and the All
   * tools sheet. Null outside Build, while a sketch is open and while
   * modeling is locked, where the tray has nothing of Build's to offer.
   */
  build?: CompactBuildProps | null;
  /**
   * An open sketch (U12 slice 6), which takes over the shell: the header
   * names the sketch with its solve state and Finish, the mode tabs go, and
   * the sketch's tray (the workspace's `compactTray`) stands at peek. The
   * selection chip opens the tray's selection page. Null outside a sketch.
   */
  sketch?: CompactSketchChrome | null;
}

/** What the compact header shows of an open sketch. */
export interface CompactSketchChrome {
  name: string;
  /** The last solve's state, or null before one has run. */
  solve: { tone: 'ok' | 'info' | 'warn'; label: string } | null;
  onFinish(): void;
}

/**
 * The sketch tray's page for the current pick: the entity's editor and the
 * selection's actions (select all, copy, paste). The selection chip opens it.
 */
export const SKETCH_SELECTION_PAGE = 'sketch-selection';

/** What Build's tray and its All tools sheet need from the workspace. */
export interface CompactBuildProps {
  /** What is picked, as the verb rail reads it: the tray suggests for it. */
  context: CommandContext;
  /**
   * The pick's own verbs, which take the tools' place while something is
   * picked, as on the verb rail; null with nothing picked.
   */
  pick: {
    verbs: readonly SelectionCalloutVerb[];
    /** Whether the verb can run now (the rail's hold rule). */
    enabled(verb: SelectionCalloutVerb): boolean;
    onVerb(id: SelectionCalloutVerbId): void;
  } | null;
  availability: ToolAvailability;
  /** The tool running now, lit in the All tools sheet. */
  activeTool: ToolId | null;
  /** Recently launched tools, newest first: they lead the suggestions. */
  recentTools: readonly ToolId[];
  /** The verb rail's pins, which lead All tools before anything is used. */
  pinnedTools: readonly ToolId[];
  /** Launches a tool through the workspace's own launch path. */
  onLaunchTool(tool: ToolId): void;
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
  /**
   * Where the tray draws what stands on the stage just above the sheet
   * (the sketch's relations row), or null until the stage layer is up.
   */
  stageHost: HTMLElement | null;
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
