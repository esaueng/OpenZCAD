import type { CSSProperties, ReactNode, Ref } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  /** Floating tool palette (or a mode strip while a direct mode is active). */
  toolBar: ReactNode;
  /**
   * Feature tree and parameters; null removes the column, which is what View
   * mode does — there is no history to browse when nothing can be edited.
   */
  sidebar: ReactNode | null;
  viewer: ReactNode;
  /** Contextual properties panel; null hides it and gives the space back. */
  inspector: ReactNode | null;
  /**
   * Assistant dock, to the right of the viewport. Null removes it entirely —
   * what the assistant setting does — and the viewport takes back the space.
   */
  assistant: ReactNode | null;
  /**
   * Gives the assistant's column back without unmounting it. A direct
   * manipulation mode hides the dock, but the panel holds the conversation and
   * any request still streaming, so it has to stay mounted underneath.
   */
  assistantHidden?: boolean;
  /**
   * Same deal for a deliberate collapse: the panel renders its launcher instead
   * of the dock, so the column has to go too — a collapse that left a 360 px
   * gap behind would not be a collapse.
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
  /**
   * Splitters for the two docked panels. They are absolutely positioned over
   * the seam, which also keeps them out of the grid's column count.
   */
  sidebarResizer?: ReactNode;
  assistantResizer?: ReactNode;
  statusBar: ReactNode;
  overlays?: ReactNode;
}

/**
 * Workspace layout frame: TopBar / [Sidebar | Viewer | Assistant] / StatusBar.
 * The tool palette and the inspector float over the viewer like CAD dialogs,
 * so the viewport keeps its full size while modeling.
 */
export function AppShell({
  topBar,
  toolBar,
  sidebar,
  viewer,
  inspector,
  assistant,
  assistantHidden = false,
  assistantCollapsed = false,
  sidebarWidth,
  assistantWidth,
  workspaceRef,
  sidebarResizer,
  assistantResizer,
  statusBar,
  overlays
}: AppShellProps) {
  const assistantDocked = Boolean(
    assistant && !assistantHidden && !assistantCollapsed
  );
  const sidebarDocked = Boolean(sidebar);
  // The widths are custom properties rather than track sizes so the stylesheet
  // keeps the last word: it caps them against the window, and the narrow-screen
  // rules can ignore them entirely when the workspace stacks.
  const widths = {
    '--sidebar-w': `${sidebarWidth}px`,
    '--assistant-w': `${assistantWidth}px`
  } as CSSProperties;
  return (
    <div className="app-shell">
      {topBar}
      <main
        ref={workspaceRef}
        className={`workspace${assistantDocked ? ' with-assistant' : ''}${
          sidebarDocked ? '' : ' no-sidebar'
        }`}
        style={widths}
      >
        {sidebar}
        {sidebarDocked && sidebarResizer}
        <div className={`viewer-area${inspector ? ' has-inspector' : ''}`}>
          {viewer}
          {toolBar && <div className="palette-float">{toolBar}</div>}
          {inspector && <div className="inspector-float">{inspector}</div>}
        </div>
        {assistant}
        {assistantDocked && assistantResizer}
      </main>
      {statusBar}
      {overlays}
    </div>
  );
}
