import {
  AlertTriangle,
  ChevronLeft,
  CircleHelp,
  Ellipsis,
  FileText,
  FolderOpen,
  PanelsTopLeft,
  Redo2,
  Search,
  Settings,
  Undo2
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode
} from 'react';
import { WORKSPACE_MODE_OPTIONS } from '../../lib/topBarPresentation';
import { WORKSPACE_SAVE_STATE_PRESENTATION } from '../../lib/workspaceSaveStatePresentation';
import type { WorkspaceSaveState } from '../../lib/cloudProjectAutosave';
import { OWN_ENTER_ATTRIBUTE } from '../../lib/exactEntryShortcut';
import type { PaletteCommand } from '../CommandBar';
import { BottomSheet, SHEET_OVERLAY_ATTRIBUTE, useSheet } from './BottomSheet';
import { MenuList, type MenuRow } from './CompactMenuList';
import { CompactPanelSheet } from './CompactPanelSheet';
import { CompactSelectionPage } from './CompactSelectionPage';
import type { CompactChromeProps } from './compactSlots';
import { COMPACT_PANEL_TITLES, PANEL_SHEET_PAGE } from './panelSheet';

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
  /** The host the in-place command bar is portalled into. */
  onCommandRowHost(element: HTMLElement | null): void;
  /**
   * The host for what must stand over the sheet at any height (the numeric
   * keypad): outside the stage, which is inert while the sheet is full.
   */
  onOverlayHost(element: HTMLElement | null): void;
}

/**
 * The chrome's own controls keep their Enter: pressed on More or a tab while
 * a command runs, it presses that control rather than the workspace taking
 * it as the command's Done.
 */
const OWN_ENTER = { [OWN_ENTER_ATTRIBUTE]: '' };

/** The pages the compact chrome pushes onto the sheet, by id. */
type CompactPage = 'more' | 'file' | 'selection' | typeof PANEL_SHEET_PAGE;

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
  fileCommands,
  selectionLabel,
  onClearSelection,
  reducedMotion,
  panels,
  selection,
  editRefusal,
  sheetContent,
  hasSheetContent,
  sheetKey,
  onCommandRowHost,
  onOverlayHost
}: CompactWorkspaceProps) {
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const tabsRef = useRef<HTMLElement | null>(null);
  const floatRef = useRef<HTMLDivElement | null>(null);
  const { state, dispatch } = useSheet(hasSheetContent);

  // Content arriving brings the sheet up to half; content leaving closes a
  // sheet that holds nothing else.
  const lastKey = useRef('');
  useEffect(() => {
    const arrived = hasSheetContent && sheetKey !== lastKey.current;
    lastKey.current = hasSheetContent ? sheetKey : '';
    dispatch({ type: 'root', present: hasSheetContent, arrived });
  }, [dispatch, hasSheetContent, sheetKey]);

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
      // Its top into view when it opened below the sheet's fold, leaving
      // the bar above it in reach where there is room.
      const room = body.getBoundingClientRect();
      const top = details.getBoundingClientRect().top;
      if (top > room.bottom - 96) {
        body.scrollTop += top - room.top - 8;
      }
    };
    // `toggle` does not bubble.
    chrome.addEventListener('toggle', onToggle, true);
    return () => chrome.removeEventListener('toggle', onToggle, true);
  }, []);

  const push = (key: CompactPage) => dispatch({ type: 'push', page: { key } });
  const closePages = () => dispatch({ type: 'close' });
  const moreOpen = state.stack.some((page) => page.key === 'more');

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
    switch (key as CompactPage) {
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
    if (!selectionLabel) return;
    push('selection');
  };

  // A shared link's visitor sees only the modes the link opens, as on the
  // top bar; with one, there is nothing to switch.
  const modes = shareLink
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
        <div className="compact-title">
          <h1 className="compact-project-name">{projectName}</h1>
          <span
            className={`compact-save-dot is-${saveTone(saveState)}`}
            role="img"
            aria-label={presentation.topBarLabel}
            title={presentation.title}
          />
        </div>
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
        <button
          type="button"
          className="compact-icon-button"
          aria-label="Open the command bar"
          onClick={onSearch}
        >
          <Search size={22} aria-hidden="true" />
        </button>
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
        </div>
        <BottomSheet
          label="Workspace sheet"
          state={state}
          dispatch={dispatch}
          hasRoot={hasSheetContent}
          renderPage={renderPage}
          reducedMotion={reducedMotion}
          background={background}
          onHeight={onHeight}
        >
          {/* The in-place command bar lands here (WorkspaceReadout), first:
              its step and Done are what a running command needs in reach. */}
          <div ref={onCommandRowHost} className="compact-command-row" />
          {sheetContent}
        </BottomSheet>
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
        ref={onOverlayHost}
        className="compact-overlay-host"
        {...{ [SHEET_OVERLAY_ATTRIBUTE]: '' }}
      />
    </div>
  );
}
