import {
  AlertTriangle,
  Check,
  ChevronLeft,
  CircleHelp,
  Copy,
  Ellipsis,
  FileText,
  FolderOpen,
  PanelsTopLeft,
  Map as MapIcon,
  Redo2,
  Search,
  Settings,
  SquarePen,
  Undo2,
  X
} from 'lucide-react';
import {
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { WORKSPACE_MODE_OPTIONS } from '../../lib/topBarPresentation';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from '../../lib/workspaceSaveStatePresentation';
import type { WorkspaceSaveState } from '../../lib/cloudProjectAutosave';
import { OWN_ENTER_ATTRIBUTE } from '../../lib/exactEntryShortcut';
import type { PaletteCommand } from '../CommandBar';
import { AllToolsSheet } from './AllToolsSheet';
import { BottomSheet, useSheet } from './BottomSheet';
import {
  ANALYSIS_LABELS,
  analysisRuntime,
  useAnalysisRuntime
} from '../../lib/analysis/analysisRuntime';
import { MenuList, type MenuRow } from './CompactMenuList';
import { CompactPanelSheet } from './CompactPanelSheet';
import { CompactSelectionPage } from './CompactSelectionPage';
import {
  COMPACT_SHEET_RAISE_EVENT,
  COMPACT_SHEET_YIELD_EVENT,
  CompactAnalysisSlotContext,
  CompactTrayContext,
  SHEET_OVERLAY_ATTRIBUTE,
  SKETCH_SELECTION_PAGE,
  type CompactChromeProps,
  type CompactSheetRaise,
  type CompactTraySlot
} from './compactSlots';
import { COMPACT_PANEL_TITLES, PANEL_SHEET_PAGE } from './panelSheet';
import { ContextTray } from './ContextTray';
import { ProjectSheet } from './ProjectSheet';

/** The save dot's tone: settled, under way, or worth a look. */
function saveTone(state: WorkspaceSaveState): 'ok' | 'busy' | 'local' | 'warn' {
  switch (state) {
    case 'synced':
      return 'ok';
    case 'saving':
    case 'syncing':
      return 'busy';
    case 'local':
    case 'room-only':
      return 'local';
    default:
      return 'warn';
  }
}

function fileRows(
  commands: readonly PaletteCommand[],
  done: () => void
): MenuRow[] {
  return commands.map((command) => ({
    id: command.id,
    label: command.label,
    icon: command.icon ?? <FileText size={18} />,
    disabledReason: command.disabledReason ?? null,
    run: () => {
      done();
      command.run();
    }
  }));
}

export interface CompactWorkspaceProps extends CompactChromeProps {
  /** The sheet's root page: what the workspace puts in it now. */
  sheetContent: ReactNode;
  /** Whether that page holds anything. */
  hasSheetContent: boolean;
  /** Changes when different content arrives, so the sheet comes up. */
  sheetKey: string;
  /**
   * A running command's bar is in the sheet (it carries its own tray row,
   * which then stands in for the mode's tray).
   */
  commandRowPresent?: boolean;
  /**
   * That bar is all the sheet holds: it comes up at peek, the model in view
   * to pick on, and its Options raise it.
   */
  rowOnly?: boolean;
  /**
   * The mode's tray (U12 slice 7: View's and Tweak's verbs), the sheet's
   * row at peek; its pages open over it through `CompactTrayContext`. A
   * tray keeps the sheet at peek rather than closed, and arriving does not
   * raise it: only a page does. Build's tray comes from `build` instead.
   */
  tray?: ReactNode;
  /** The host the in-place command bar is portalled into. */
  onCommandRowHost(element: HTMLElement | null): void;
  /**
   * The host for what must stand over the sheet at any height (the numeric
   * keypad): outside the stage, which is inert while the sheet is full.
   */
  onOverlayHost(element: HTMLElement | null): void;
  /** Where the action notice goes: over the sheet, outside the stage. */
  onNoticeHost?(element: HTMLElement | null): void;
  /**
   * The sheet stands at full height, or no longer does: the stage under it
   * is inert, and the status line moves to the notice host meanwhile.
   */
  onSheetFull?(full: boolean): void;
}

/**
 * The chrome's own controls keep their Enter: pressed on More or a tab while
 * a command runs, it presses that control rather than the workspace taking
 * it as the command's Done.
 */
const OWN_ENTER = { [OWN_ENTER_ATTRIBUTE]: '' };

/** The pages the compact chrome pushes onto the sheet, by id. */
type CompactPage =
  | 'more'
  | 'file'
  | 'project'
  | 'selection'
  | 'all-tools'
  | typeof PANEL_SHEET_PAGE;

/** A tray's page in the back stack: this prefix, then the tray's own key. */
const TRAY_PAGE = 'tray:';

/**
 * The compact workspace's chrome (U12 slice 2): a header, the mode tabs, the
 * controls floating on the stage and the one bottom sheet. It is a second
 * filling of `AppShell`, not a fork: the stage, the document and every
 * command are the regular workspace's, and each control here runs the
 * handler that workspace already has.
 */
export default function CompactWorkspace({
  projectName,
  saveState,
  workspaceMode,
  modeLockedReason,
  shareLink,
  onWorkspaceMode,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onHome,
  onSearch,
  onSettings,
  onHelp,
  onGuide,
  searchOpen = false,
  onCloseSearch,
  project = null,
  fileCommands,
  selectionLabel,
  onClearSelection,
  onMakeCopy,
  reducedMotion,
  panels,
  selection,
  editRefusal,
  build = null,
  sketch = null,
  sheetContent,
  hasSheetContent,
  sheetKey,
  commandRowPresent = false,
  rowOnly = false,
  tray = null,
  onCommandRowHost,
  onOverlayHost,
  onNoticeHost,
  onSheetFull
}: CompactWorkspaceProps) {
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const projectNameHintId = useId();
  const headerRef = useRef<HTMLElement | null>(null);
  const tabsRef = useRef<HTMLElement | null>(null);
  const floatRef = useRef<HTMLDivElement | null>(null);
  // Build's tray stands at peek while nothing runs (U12 slice 4); View's
  // and Tweak's trays come from the workspace (U12 slice 7). One mode has
  // one tray, so at most one of them is up.
  const hasModeTray = tray !== null && tray !== undefined && tray !== false;
  const trayShown = build !== null || hasModeTray;
  // An analysis left on (M09) keeps colouring the model in every mode, as in
  // the regular workspace, where its panel with Off stays over the stage.
  // Here the panel lives in View's Display page; wherever that page is not
  // showing it, a chip on the stage says what is on and turns it off.
  const analysisKind = useAnalysisRuntime((s) => s.request?.kind ?? null);
  const analysisPanelShown = Boolean(
    useContext(CompactAnalysisSlotContext)?.host
  );
  // The keypad is Build's sheet's content while it is open (U12 slice 4):
  // it lands in a host in the sheet's flow, under the tray row.
  const [keypadHost, setKeypadHost] = useState<HTMLElement | null>(null);
  const [keypadUp, setKeypadUp] = useState(false);
  // Up in either of its sheet hosts: this one, or a running command's bar.
  useEffect(() => {
    const chrome = chromeRef.current;
    if (!chrome) return;
    const read = () =>
      setKeypadUp(
        chrome.querySelector('.compact-sheet .numeric-keypad') !== null
      );
    read();
    const observer = new MutationObserver(read);
    observer.observe(chrome, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  // A tray is the sheet's own root too: the sheet rests at peek on it.
  const hasRoot = hasSheetContent || trayShown || keypadUp;
  const { state, dispatch } = useSheet(hasRoot);
  const stateRef = useRef(state);
  stateRef.current = state;
  // The stage goes inert under a full sheet: the shell moves the status
  // line (and its Undo) over the sheet meanwhile, as the notice is.
  const sheetFull = state.detent === 'full';
  useEffect(() => {
    onSheetFull?.(sheetFull);
  }, [onSheetFull, sheetFull]);
  useEffect(() => () => onSheetFull?.(false), [onSheetFull]);

  // Content arriving brings the sheet up to half (a running tool's row
  // alone to peek); content leaving closes a sheet that holds nothing else,
  // and brings one that keeps a tray back down to its peek (under an open
  // page, once the page goes).
  //
  // A running command's row arriving takes the sheet, wherever the command
  // was run from (the command bar, a key, the tray, All tools, a selection
  // verb, an action sheet): every page goes, as for an edit started from a
  // page, and the sheet stands at the root's height, so the row's Cancel and
  // Done show at once rather than under History until Back.
  const lastKey = useRef('');
  const lastRow = useRef(false);
  useEffect(() => {
    const key = hasSheetContent ? sheetKey : '';
    const arrived = key !== '' && key !== lastKey.current;
    const left = key === '' && lastKey.current !== '';
    const rowArrived = commandRowPresent && !lastRow.current;
    lastKey.current = key;
    lastRow.current = commandRowPresent;
    if (left && trayShown) {
      dispatch({ type: 'settle' });
      return;
    }
    dispatch({
      type: 'root',
      present: hasRoot,
      arrived,
      at: rowOnly ? 'peek' : 'half'
    });
    if (rowArrived) dispatch({ type: 'leave', toRoot: true });
  }, [
    commandRowPresent,
    dispatch,
    hasRoot,
    hasSheetContent,
    rowOnly,
    sheetKey,
    trayShown
  ]);

  // The keypad needs the room of half height at least.
  useEffect(() => {
    if (keypadUp) dispatch({ type: 'raise', detent: 'half' });
  }, [dispatch, keypadUp]);

  // What in the sheet asks for room (a tool's Options, a refusal) raises it.
  useEffect(() => {
    const chrome = chromeRef.current;
    if (!chrome) return;
    const onRaise = (event: Event) => {
      const detent = (event as CustomEvent<CompactSheetRaise>).detail;
      dispatch({ type: 'raise', detent: detent === 'full' ? 'full' : 'half' });
    };
    chrome.addEventListener(COMPACT_SHEET_RAISE_EVENT, onRaise);
    return () => chrome.removeEventListener(COMPACT_SHEET_RAISE_EVENT, onRaise);
  }, [dispatch]);

  // What a global key opens on the stage (the command bar) needs the stage
  // live: a full sheet comes down to half for it, pages and all.
  useEffect(() => {
    const shell = chromeRef.current?.closest('.app-shell');
    if (!shell) return;
    const onYield = () => {
      if (stateRef.current.detent === 'full') {
        dispatch({ type: 'set-detent', detent: 'half' });
      }
    };
    shell.addEventListener(COMPACT_SHEET_YIELD_EVENT, onYield);
    return () => shell.removeEventListener(COMPACT_SHEET_YIELD_EVENT, onYield);
  }, [dispatch]);

  // The keypad's host: in the sheet while Build's tray holds it up, so the
  // keypad is the sheet's content; elsewhere (View's and Tweak's trays too)
  // outside the stage, where it stands over the sheet at any height.
  const keypadInSheet = build !== null;
  const overlayHostRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    onOverlayHost(keypadInSheet ? keypadHost : overlayHostRef.current);
  }, [keypadHost, keypadInSheet, onOverlayHost]);

  // The tray's open page, wherever it is in the stack (a page such as More
  // can stand over it), and the element its content is drawn into while it
  // is the page on show.
  const trayTitles = useRef(new Map<string, string>());
  const [trayPageHost, setTrayPageHost] = useState<HTMLElement | null>(null);
  // What a tray stands on the stage, over the sheet (the sketch's
  // relations row).
  const [trayStageHost, setTrayStageHost] = useState<HTMLElement | null>(null);
  const trayEntry = state.stack.find((page) => page.key.startsWith(TRAY_PAGE));
  const trayPage = trayEntry ? trayEntry.key.slice(TRAY_PAGE.length) : null;
  const trayPageOnTop =
    trayEntry !== undefined &&
    state.stack[state.stack.length - 1]?.key === trayEntry.key;
  const traySlot = useMemo<CompactTraySlot>(
    () => ({
      page: trayPage,
      pageHost: trayPageOnTop ? trayPageHost : null,
      openPage(key, title) {
        trayTitles.current.set(key, title);
        // One tray page at a time: another one open goes first. A sheet
        // raised to full stays there.
        const full = stateRef.current.detent === 'full';
        if (stateRef.current.stack.length > 0) dispatch({ type: 'close' });
        dispatch({
          type: 'push',
          page: { key: `${TRAY_PAGE}${key}` },
          detent: full ? 'full' : 'half'
        });
      },
      closePage() {
        dispatch({ type: 'close' });
      },
      stageHost: trayStageHost
    }),
    [dispatch, trayPage, trayPageOnTop, trayPageHost, trayStageHost]
  );
  // Back from a tray page (its Back, Escape, or the page closing itself)
  // lowers the sheet to the tray's peek, unless the workspace has content
  // of its own in the sheet.
  const lastTrayPage = useRef<string | null>(null);
  useEffect(() => {
    const left = lastTrayPage.current !== null && trayPage === null;
    lastTrayPage.current = trayPage;
    if (
      left &&
      hasModeTray &&
      !hasSheetContent &&
      stateRef.current.stack.length === 0
    ) {
      dispatch({ type: 'set-detent', detent: 'peek' });
    }
  }, [dispatch, hasModeTray, hasSheetContent, trayPage]);

  const shell = () => chromeRef.current?.closest('.app-shell') ?? null;
  const background = useCallback(
    () => [
      shell()?.querySelector(':scope > .workspace'),
      headerRef.current,
      tabsRef.current,
      floatRef.current
    ],
    []
  );
  // The notice host stands beside the sheet, outside the stage it makes
  // inert at full height: its Undo (a toast's, the status line's) is part
  // of the sheet's focus trap there.
  const noticeHostRef = useRef<HTMLDivElement | null>(null);
  const noticeHostCallback = useCallback(
    (element: HTMLDivElement | null) => {
      noticeHostRef.current = element;
      onNoticeHost?.(element);
    },
    [onNoticeHost]
  );
  const companions = useCallback(() => [noticeHostRef.current], []);
  const onHeight = useCallback((px: number) => {
    (shell() as HTMLElement | null)?.style.setProperty(
      '--compact-sheet-h',
      `${px}px`
    );
  }, []);
  useLayoutEffect(
    () => () => {
      (
        chromeRef.current?.closest('.app-shell') as HTMLElement | null
      )?.style.removeProperty('--compact-sheet-h');
    },
    []
  );

  // A command's Options open in the sheet's flow, under the bar: brought
  // into view as they open, rather than left below the sheet's fold.
  useEffect(() => {
    const chrome = chromeRef.current;
    if (!chrome) return;
    const onToggle = (event: Event) => {
      const details = event.target;
      if (
        !(details instanceof HTMLDetailsElement) ||
        !details.open ||
        !details.classList.contains('in-place-command-options') ||
        !details.closest('.compact-sheet')
      ) {
        return;
      }
      const body = details.closest<HTMLElement>('.compact-sheet-body');
      if (!body) return;
      // Its top into view when it opened below the sheet's fold, just
      // under the tray row pinned over it.
      const room = body.getBoundingClientRect();
      const pinned =
        body.querySelector('.compact-tray-row')?.getBoundingClientRect()
          .bottom ?? room.top;
      const top = details.getBoundingClientRect().top;
      if (top > room.bottom - 96) {
        body.scrollTop += top - Math.max(room.top, pinned) - 8;
      }
    };
    // `toggle` does not bubble.
    chrome.addEventListener('toggle', onToggle, true);
    return () => chrome.removeEventListener('toggle', onToggle, true);
  }, []);

  // A disabled verb's reason stands under the tray row: tapped at peek,
  // the sheet comes up to half to show it, and goes back to the height the
  // person chose with it (sheetState's temporary raise), even when All
  // tools opened and closed meanwhile.
  const onTrayReason = useCallback(
    (shown: boolean) =>
      dispatch(
        shown
          ? { type: 'raise', detent: 'half', temporary: true }
          : { type: 'lower' }
      ),
    [dispatch]
  );

  const push = (key: CompactPage, detent?: 'half' | 'full') =>
    dispatch({ type: 'push', page: { key }, ...(detent ? { detent } : {}) });
  const closePages = () => dispatch({ type: 'close' });
  const moreOpen = state.stack.some((page) => page.key === 'more');
  const projectOpen = state.stack.some((page) => page.key === 'project');
  const allToolsOpen = state.stack.some((page) => page.key === 'all-tools');

  // The panel sheet follows the workspace's open panel (every route to a
  // panel sets it), and a sheet put away by Back, Close or Escape shuts it.
  const panelsInStack = state.stack.some(
    (page) => page.key === PANEL_SHEET_PAGE
  );
  const panelsWereInStack = useRef(false);
  const panelOpen = panels.open;
  const onPanelOpen = panels.onOpen;
  useEffect(() => {
    if (panelsWereInStack.current && !panelsInStack) {
      panelsWereInStack.current = false;
      if (panelOpen !== null) onPanelOpen(null);
      return;
    }
    panelsWereInStack.current = panelsInStack;
    if (panelOpen !== null && !panelsInStack) {
      dispatch({ type: 'push', page: { key: PANEL_SHEET_PAGE } });
    } else if (panelOpen === null && panelsInStack) {
      // Shut from outside the sheet: an edit, a tool or an inspector started
      // from a panel (a History tap), or Ctrl+\. Every page goes with it, so
      // More, under Panels, never covers the edit form that took its place.
      dispatch({ type: 'leave' });
    }
  }, [dispatch, onPanelOpen, panelOpen, panelsInStack]);

  // Each page is drawn from the workspace's state as it is now, so a row
  // disabled while the model was updating comes back when it finishes.
  const renderPage = (
    key: string
  ): { title: string; content: ReactNode } | null => {
    if (key.startsWith(TRAY_PAGE)) {
      const trayKey = key.slice(TRAY_PAGE.length);
      return {
        // The sketch's selection page names the pick as it is now: a paste
        // or an undo changes it under the open page.
        title:
          trayKey === SKETCH_SELECTION_PAGE
            ? (selectionLabel ?? 'Nothing picked')
            : (trayTitles.current.get(trayKey) ?? ''),
        // The tray draws the page's content in here (a portal), so it keeps
        // the tray's own state and handlers.
        content: <div ref={setTrayPageHost} className="compact-tray-page" />
      };
    }
    switch (key as CompactPage) {
      case 'project':
        return {
          title: 'Project',
          content: (
            <ProjectSheet
              projectName={projectName}
              fileCommands={fileCommands}
              project={project}
              done={closePages}
            />
          )
        };
      case 'file':
        return {
          title: 'File',
          content: (
            <MenuList label="File" rows={fileRows(fileCommands, closePages)} />
          )
        };
      case 'more':
        return {
          title: 'More',
          content: (
            <MenuList
              label="More"
              rows={[
                // A shared link's visitor's way to keep the model, in any
                // mode: the regular top bar's labelled button, here.
                ...(onMakeCopy
                  ? [
                      {
                        id: 'make-copy',
                        label: 'Make a copy',
                        icon: <Copy size={18} />,
                        run: () => {
                          closePages();
                          onMakeCopy();
                        }
                      }
                    ]
                  : []),
                {
                  id: 'settings',
                  label: 'Open settings',
                  icon: <Settings size={18} />,
                  run: () => {
                    closePages();
                    onSettings();
                  }
                },
                {
                  id: 'help',
                  label: 'Help & keyboard shortcuts',
                  icon: <CircleHelp size={18} />,
                  run: () => {
                    closePages();
                    onHelp();
                  }
                },
                ...(onGuide
                  ? [
                      {
                        id: 'guide',
                        label: 'Modeling guide',
                        icon: <MapIcon size={18} />,
                        run: () => {
                          closePages();
                          onGuide();
                        }
                      }
                    ]
                  : []),
                {
                  id: 'project',
                  label: 'Project',
                  icon: <SquarePen size={18} />,
                  drillIn: true,
                  run: () => push('project')
                },
                {
                  id: 'panels',
                  label: 'Panels',
                  icon: <PanelsTopLeft size={18} />,
                  drillIn: true,
                  disabledReason: panels.disabledReason,
                  run: () => panels.onOpen(panels.available[0] ?? 'history')
                },
                {
                  id: 'file',
                  label: 'File',
                  icon: <FileText size={18} />,
                  drillIn: true,
                  run: () => push('file')
                },
                {
                  id: 'home',
                  label: 'Back to projects',
                  icon: <FolderOpen size={18} />,
                  run: () => {
                    closePages();
                    onHome();
                  }
                }
              ]}
            />
          )
        };
      case 'all-tools':
        return build
          ? {
              title: 'All tools',
              content: (
                <AllToolsSheet
                  build={build}
                  onLaunch={(tool) => {
                    closePages();
                    build.onLaunchTool(tool);
                  }}
                />
              )
            }
          : null;
      case 'selection':
        return {
          title: selectionLabel ?? 'Nothing picked',
          content: selectionLabel ? (
            <CompactSelectionPage
              selection={selection}
              onDetails={
                hasSheetContent
                  ? () => {
                      // The pick's inspector is the sheet's own content.
                      closePages();
                      dispatch({ type: 'set-detent', detent: 'half' });
                    }
                  : null
              }
              onClear={
                onClearSelection
                  ? () => {
                      closePages();
                      onClearSelection();
                    }
                  : null
              }
              done={closePages}
            />
          ) : null
        };
      case PANEL_SHEET_PAGE:
        return {
          title: panels.open ? COMPACT_PANEL_TITLES[panels.open] : 'Panels',
          content: <CompactPanelSheet panels={panels} />
        };
      default:
        return null;
    }
  };

  const openSelection = () => {
    if (sketch) {
      // A sketch's pick: its editor and actions are the tray's page.
      if (trayPage === SKETCH_SELECTION_PAGE) traySlot.closePage();
      else
        traySlot.openPage(SKETCH_SELECTION_PAGE, selectionLabel ?? 'Selection');
      return;
    }
    if (!selectionLabel) return;
    push('selection');
  };

  // A shared link's visitor sees only the modes the link opens, as on the
  // top bar; with one, there is nothing to switch.
  const modes = sketch
    ? // A sketch takes over the shell: Finish, not a mode, leaves it.
      []
    : shareLink
      ? WORKSPACE_MODE_OPTIONS.filter(
          ({ mode }) => modeLockedReason(mode) === null
        )
      : WORKSPACE_MODE_OPTIONS;
  const presentation = WORKSPACE_SAVE_STATE_PRESENTATION[saveState];

  return (
    <div ref={chromeRef} className="compact-chrome">
      <header ref={headerRef} className="compact-header" {...OWN_ENTER}>
        <button
          type="button"
          className="compact-icon-button"
          aria-label="Back to projects"
          onClick={onHome}
        >
          <ChevronLeft size={24} aria-hidden="true" />
        </button>
        {sketch ? (
          <div className="compact-title">
            <h1 className="compact-project-name">{sketch.name}</h1>
            <span
              className={`compact-save-dot compact-solve-dot is-${
                sketch.solve?.tone ?? 'unsolved'
              }`}
              role="img"
              aria-label={`Sketch state: ${sketch.solve?.label ?? 'not solved yet'}`}
              title={sketch.solve?.label ?? 'Not solved yet'}
            />
          </div>
        ) : (
          <div className="compact-title">
            <h1 className="compact-project-name">
              {/* The name opens the project sheet: rename, properties,
                sharing, revisions, export and import, units, storage. */}
              <button
                type="button"
                className="compact-project-button"
                aria-expanded={projectOpen}
                aria-describedby={projectNameHintId}
                onClick={() => (projectOpen ? closePages() : push('project'))}
              >
                {projectName}
              </button>
            </h1>
            <span id={projectNameHintId} className="visually-hidden">
              Opens the project sheet
            </span>
            <span
              className={`compact-save-dot is-${saveTone(saveState)}`}
              role="img"
              aria-label={presentation.topBarLabel}
              title={presentation.title}
            />
          </div>
        )}
        {sketch ? (
          <button
            type="button"
            className="compact-finish-button"
            aria-label="Finish Sketch"
            onClick={sketch.onFinish}
          >
            <Check size={20} aria-hidden="true" />
            <span aria-hidden="true">Finish</span>
          </button>
        ) : null}
        {editRefusal ? (
          // The top bar's "Edit not applied", with its handler: it brings
          // back the refused edit, its value and why it was refused.
          <button
            type="button"
            className="compact-refusal-chip"
            aria-label="Edit not applied: reopen it"
            title={`${editRefusal.message} Reopen the edit to see why and choose what to do.`}
            onClick={() => {
              // The edit comes back as the sheet's content: no page stays
              // over it.
              dispatch({ type: 'leave' });
              editRefusal.onReview();
            }}
          >
            <AlertTriangle size={16} aria-hidden="true" />
            <span className="compact-refusal-text">Edit not applied</span>
          </button>
        ) : null}
        {panels.warningCount > 0 ? (
          <button
            type="button"
            className="compact-warning-badge"
            aria-label={`${panels.warningCount} ${
              panels.warningCount === 1 ? 'warning' : 'warnings'
            }: show Diagnostics`}
            onClick={() => panels.onOpen('diagnostics')}
          >
            <AlertTriangle size={18} aria-hidden="true" />
            <span className="compact-warning-count mono">
              {panels.warningCount}
            </span>
          </button>
        ) : null}
        {searchOpen && onCloseSearch ? (
          // The full-screen search covers the stage and the tabs: its way
          // out by touch stands where it was opened.
          <button
            type="button"
            className="compact-icon-button"
            aria-label="Close the command bar"
            aria-expanded="true"
            onClick={onCloseSearch}
          >
            <X size={22} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="compact-icon-button"
            aria-label="Open the command bar"
            onClick={onSearch}
          >
            <Search size={22} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="compact-icon-button"
          aria-label="More"
          aria-expanded={moreOpen}
          onClick={() => (moreOpen ? closePages() : push('more'))}
        >
          <Ellipsis size={22} aria-hidden="true" />
        </button>
      </header>

      <div className="compact-stage-layer">
        <div ref={floatRef} className="compact-stage-controls" {...OWN_ENTER}>
          <div className="compact-history" role="group" aria-label="History">
            <button
              type="button"
              className="compact-float-button"
              aria-label="Undo"
              disabled={!canUndo}
              onClick={onUndo}
            >
              <Undo2 size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="compact-float-button"
              aria-label="Redo"
              disabled={!canRedo}
              onClick={onRedo}
            >
              <Redo2 size={20} aria-hidden="true" />
            </button>
          </div>
          {analysisKind && !analysisPanelShown ? (
            <button
              type="button"
              className="compact-analysis-chip"
              aria-label={`Turn off ${ANALYSIS_LABELS[analysisKind].toLowerCase()} analysis`}
              onClick={() => analysisRuntime.off()}
            >
              <span className="compact-selection-dot" aria-hidden="true" />
              <span className="compact-selection-text" aria-hidden="true">
                {ANALYSIS_LABELS[analysisKind]}
              </span>
              <X size={18} aria-hidden="true" />
            </button>
          ) : null}
          {selectionLabel ? (
            <button
              type="button"
              className="compact-selection-chip"
              aria-label={`Selection: ${selectionLabel}`}
              onClick={openSelection}
            >
              <span className="compact-selection-dot" aria-hidden="true" />
              <span className="compact-selection-text">{selectionLabel}</span>
            </button>
          ) : null}
          {/* A tray's row on the stage (the sketch's relations), over the
              undo pair and the chip: last, so it wraps to a row above. */}
          <div ref={setTrayStageHost} className="compact-stage-tray" />
        </div>
        <BottomSheet
          label="Workspace sheet"
          state={state}
          dispatch={dispatch}
          hasRoot={hasRoot}
          renderPage={renderPage}
          reducedMotion={reducedMotion}
          background={background}
          companions={companions}
          onHeight={onHeight}
        >
          {/* The mode's tray first: the row the sheet shows at peek. A
              running command's bar brings its own row, which stands in for
              it: Build's tray goes, and View's or Tweak's waits, hidden,
              with its state, until the command ends. */}
          {trayShown ? (
            <CompactTrayContext.Provider value={traySlot}>
              <div
                className={`compact-tray-slot${
                  hasModeTray && !hasSheetContent && !commandRowPresent
                    ? ' is-alone'
                    : ''
                }`}
                hidden={commandRowPresent}
              >
                {build ? (
                  commandRowPresent ? null : (
                    <ContextTray
                      build={build}
                      allToolsOpen={allToolsOpen}
                      onAllTools={() =>
                        allToolsOpen ? closePages() : push('all-tools', 'full')
                      }
                      onReason={onTrayReason}
                    />
                  )
                ) : (
                  <Suspense fallback={null}>{tray}</Suspense>
                )}
              </div>
            </CompactTrayContext.Provider>
          ) : null}
          {/* The in-place command bar lands here (WorkspaceReadout), first:
              its step and Done are what a running command needs in reach. */}
          <div ref={onCommandRowHost} className="compact-command-row" />
          {/* The keypad, as the sheet's content under the tray row. */}
          <div
            ref={setKeypadHost}
            className="compact-keypad-host"
            {...{ [SHEET_OVERLAY_ATTRIBUTE]: '' }}
          />
          {sheetContent}
        </BottomSheet>
        {/* The action notice (a delete's Undo): over the sheet and outside
            the stage, which is inert while the sheet stands at full. */}
        <div
          ref={noticeHostCallback}
          className="compact-notice-host"
          {...{ [SHEET_OVERLAY_ATTRIBUTE]: '' }}
        />
      </div>

      {modes.length > 1 ? (
        <nav
          ref={tabsRef}
          className="compact-tabs"
          {...OWN_ENTER}
          role="group"
          aria-label="Workspace mode"
        >
          {modes.map(({ mode, label, Icon }) => {
            const reason = modeLockedReason(mode);
            return (
              <button
                key={mode}
                type="button"
                className={`compact-tab${workspaceMode === mode ? ' active' : ''}`}
                aria-label={label}
                aria-pressed={workspaceMode === mode}
                disabled={reason !== null}
                title={reason ?? undefined}
                onClick={() => {
                  if (mode !== workspaceMode) onWorkspaceMode(mode);
                }}
              >
                <Icon size={22} aria-hidden="true" />
                <span className="compact-tab-label" aria-hidden="true">
                  {label}
                </span>
              </button>
            );
          })}
        </nav>
      ) : (
        <span
          ref={tabsRef}
          className="compact-tabs is-empty"
          aria-hidden="true"
        />
      )}

      {/* Outside the stage and the sheet, so what lands here (the numeric
          keypad) stays live while the sheet stands at full over an inert
          stage. */}
      <div
        ref={overlayHostRef}
        className="compact-overlay-host"
        {...{ [SHEET_OVERLAY_ATTRIBUTE]: '' }}
      />
    </div>
  );
}
