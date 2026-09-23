import {
  lazy,
  Suspense,
  type CSSProperties,
  type ReactNode,
  type Ref
} from 'react';

// Off the entry chunk, which has no room left; it mounts long before anyone
// could have started dragging a file toward the window.
const LazyFileDropTarget = lazy(() =>
  import('./FileDropTarget').then((module) => ({
    default: module.FileDropTarget
  }))
);

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
   * A deliberate collapse: the panel renders its Ask launcher on the search
   * bar instead of the conversation.
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
          {sidebar && <div className="workspace-column-float">{sidebar}</div>}
          {sidebar && sidebarResizer}
          {toolBar && <div className="palette-float">{toolBar}</div>}
          {/* The right lane, beside the instrument rail: the inspector over
              the drawer, one column, so neither pushes into the canvas. The
              wrapper always renders, so opening the drawer never remounts
              an inspector form mid-edit. */}
          <div className="stage-right">
            {inspector && <div className="inspector-float">{inspector}</div>}
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
