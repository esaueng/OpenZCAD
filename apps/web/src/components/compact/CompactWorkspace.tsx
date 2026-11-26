import {
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Ellipsis,
  FileText,
  FolderOpen,
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
import type { PaletteCommand } from '../CommandBar';
import { BottomSheet, useSheet } from './BottomSheet';
import type { CompactChromeProps } from './compactSlots';
import type { SheetPage } from './sheetState';

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

interface MenuRow {
  id: string;
  label: string;
  icon?: ReactNode;
  disabledReason?: string | null;
  /** Opens a page rather than running something. */
  drillIn?: boolean;
  run(): void;
}

function MenuList({
  label,
  rows
}: {
  label: string;
  rows: readonly MenuRow[];
}) {
  return (
    <ul className="compact-menu" aria-label={label}>
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className="compact-menu-row"
            disabled={Boolean(row.disabledReason)}
            title={row.disabledReason ?? undefined}
            onClick={row.run}
          >
            <span className="compact-menu-icon" aria-hidden="true">
              {row.icon}
            </span>
            <span className="compact-menu-label">{row.label}</span>
            {row.drillIn ? (
              <ChevronRight
                className="compact-menu-chevron"
                size={18}
                aria-hidden="true"
              />
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
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
}

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
  sheetContent,
  hasSheetContent,
  sheetKey,
  onCommandRowHost
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

  const push = (page: SheetPage) => dispatch({ type: 'push', page });
  const closePages = () => dispatch({ type: 'close' });
  const moreOpen = state.stack.some((page) => page.key === 'more');

  const filePage = (): SheetPage => ({
    key: 'file',
    title: 'File',
    content: <MenuList label="File" rows={fileRows(fileCommands, closePages)} />
  });
  const morePage = (): SheetPage => ({
    key: 'more',
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
            id: 'file',
            label: 'File',
            icon: <FileText size={18} />,
            drillIn: true,
            run: () => push(filePage())
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
  });

  const openSelection = () => {
    if (hasSheetContent) {
      // The pick's inspector is the sheet's own content: bring it up.
      dispatch({ type: 'close' });
      dispatch({ type: 'set-detent', detent: 'half' });
      return;
    }
    if (!selectionLabel) return;
    push({
      key: 'selection',
      title: selectionLabel,
      content: onClearSelection ? (
        <MenuList
          label="Selection"
          rows={[
            {
              id: 'clear',
              label: 'Clear selection',
              run: () => {
                closePages();
                onClearSelection();
              }
            }
          ]}
        />
      ) : null
    });
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
      <header ref={headerRef} className="compact-header">
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
          onClick={() => (moreOpen ? closePages() : push(morePage()))}
        >
          <Ellipsis size={22} aria-hidden="true" />
        </button>
      </header>

      <div className="compact-stage-layer">
        <div ref={floatRef} className="compact-stage-controls">
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
    </div>
  );
}
