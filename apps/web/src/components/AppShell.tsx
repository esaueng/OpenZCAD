import {
  lazy,
  Suspense,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref
} from 'react';
import { OVERLAY_EXIT_MS, useDelayedUnmount } from '../hooks/useDelayedUnmount';

// Off the entry chunk, which has no room left; it mounts long before anyone
// could have started dragging a file toward the window.
const LazyFileDropTarget = lazy(() =>
  import('./FileDropTarget').then((module) => ({
    default: module.FileDropTarget
  }))
);

/**
 * A floating panel that can play an exit. While `closing` it is `inert` —
 * gone as far as input goes — and it gives up focus on the commit that
 * starts the exit. Inert alone is not enough: the browser only moves focus
 * out of an inert subtree at its next rendering update, so a key pressed
 * straight after the Escape that closed the inspector still landed in the
 * inspector's field, typing a shortcut into a form on its way out instead of
 * reaching the workspace. Focus goes to the body, where an unmount would
 * have left it.
 */
function ExitingFloat({
  className,
  closing,
  children
}: {
  className: string;
  closing: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (
      closing &&
      active instanceof HTMLElement &&
      ref.current?.contains(active)
    ) {
      active.blur();
    }
  }, [closing]);
  return (
    <div ref={ref} className={className} inert={closing}>
      {children}
    </div>
  );
}

interface AppShellProps {
  topBar: ReactNode;
  /** Floating strip over the viewport: a direct-mode strip, or View's bar. */
  toolBar: ReactNode;
  /**
   * The workspace column, floating over the viewport's left edge; null
   * removes it, which is what View mode does.
   */
  sidebar: ReactNode | null;
  viewer: ReactNode;
  /** Contextual properties panel; null hides it and gives the space back. */
  inspector: ReactNode | null;
  /**
   * The model drawer (parameters, bodies, history), floating beside the
   * instrument rail on the right; null while it is closed.
   */
  drawer?: ReactNode | null;
  /**
   * The assistant's conversation, floating over the viewport above the search
   * bar. Null removes it entirely — what the assistant setting does.
   */
  assistant: ReactNode | null;
  /**
   * Hides the conversation without unmounting it. A direct manipulation mode
   * hides it, but the panel holds the conversation and any request still
   * streaming, so it has to stay mounted underneath.
   */
  assistantHidden?: boolean;
  /**
   * A deliberate collapse: the stream is tucked away behind the prompt line,
   * which keeps the conversation and shows a dot for replies that land.
   */
  assistantCollapsed?: boolean;
  /** The user's panel widths, in CSS pixels, published to the layout. */
  sidebarWidth: number;
  assistantWidth: number;
  /**
   * The workspace element, so a drag can write the width straight to the grid
   * for the duration of the gesture instead of re-rendering the editor.
   */
  workspaceRef?: Ref<HTMLElement>;
  /** The column's splitter. The assistant floats, so it has none. */
  sidebarResizer?: ReactNode;
  /** The status toast and the activity log, over the viewport. */
  readout?: ReactNode;
  overlays?: ReactNode;
  /**
   * Files dropped on the viewer area from outside the page. Absent, the
   * area is not a drop target and the browser keeps its default.
   */
  onDropFiles?(files: File[]): void;
}

/**
 * Workspace layout frame: the viewer fills the workspace, and everything else
 * — the top islands, the column, the inspector, the drawer, the assistant —
 * floats over it, so the viewport keeps its full size while modeling; there
 * is no status bar.
 */
export function AppShell({
  topBar,
  toolBar,
  sidebar,
  viewer,
  inspector,
  drawer = null,
  assistant,
  assistantHidden = false,
  assistantCollapsed = false,
  sidebarWidth,
  assistantWidth,
  workspaceRef,
  sidebarResizer,
  readout,
  overlays,
  onDropFiles
}: AppShellProps) {
  // The inspector fades out rather than vanishing. `has-inspector` still
  // follows the live prop, so the lane is released on the frame it closes.
  const inspectorExit = useDelayedUnmount(inspector || null, OVERLAY_EXIT_MS);
  // Changing mode slides the column and the strip off toward their edges
  // (view-mode.css) before they unmount.
  const columnExit = useDelayedUnmount(sidebar || null, OVERLAY_EXIT_MS);
  const stripExit = useDelayedUnmount(toolBar || null, OVERLAY_EXIT_MS);
  const assistantDocked = Boolean(
    assistant && !assistantHidden && !assistantCollapsed
  );
  // The widths are custom properties rather than track sizes so the stylesheet
  // keeps the last word: it caps them against the window, and the narrow-screen
  // rules can ignore them entirely when the workspace stacks.
  const widths = {
    '--sidebar-w': `${sidebarWidth}px`,
    '--assistant-w': `${assistantWidth}px`
  } as CSSProperties;
  return (
    <div className="app-shell column-layout">
      {topBar}
      <main
        ref={workspaceRef}
        className={`workspace no-sidebar column-layout${
          assistantDocked ? ' with-assistant' : ''
        }`}
        style={widths}
      >
        <div
          className={`viewer-area${inspector ? ' has-inspector' : ''}${
            drawer ? ' has-drawer' : ''
          }`}
        >
          {viewer}
          {columnExit.rendered && (
            <ExitingFloat
              className={`workspace-column-float${columnExit.closing ? ' closing' : ''}`}
              closing={columnExit.closing}
            >
              {columnExit.rendered}
            </ExitingFloat>
          )}
          {sidebar && sidebarResizer}
          {stripExit.rendered && (
            <ExitingFloat
              className={`palette-float${stripExit.closing ? ' closing' : ''}`}
              closing={stripExit.closing}
            >
              {stripExit.rendered}
            </ExitingFloat>
          )}
          {/* The right lane, beside the instrument rail: the inspector over
              the drawer, one column, so neither pushes into the canvas. The
              wrapper always renders, so opening the drawer never remounts
              an inspector form mid-edit. */}
          <div className="stage-right">
            {inspectorExit.rendered && (
              <ExitingFloat
                className={`inspector-float${inspectorExit.closing ? ' closing' : ''}`}
                closing={inspectorExit.closing}
              >
                {inspectorExit.rendered}
              </ExitingFloat>
            )}
            {drawer && <div className="model-drawer-float">{drawer}</div>}
          </div>
          {readout}
          {onDropFiles && (
            <Suspense fallback={null}>
              <LazyFileDropTarget onDrop={onDropFiles} />
            </Suspense>
          )}
        </div>
        {assistant}
      </main>
      {overlays}
    </div>
  );
}
