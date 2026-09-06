import type { CSSProperties, ReactNode, Ref } from 'react';

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
  /** Splitters: the column's right edge and the assistant's left edge. */
  sidebarResizer?: ReactNode;
  assistantResizer?: ReactNode;
  /** The status toast and the activity log, over the viewport. */
  readout?: ReactNode;
  overlays?: ReactNode;
}

/**
 * Workspace layout frame: TopBar / [Viewer | Assistant]. The column, the
 * inspector and the dock float over the viewer like CAD dialogs, so the
 * viewport keeps its full size while modeling; there is no status bar.
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
  readout,
  overlays
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
        <div className={`viewer-area${inspector ? ' has-inspector' : ''}`}>
          {viewer}
          {sidebar && <div className="workspace-column-float">{sidebar}</div>}
          {sidebar && sidebarResizer}
          {toolBar && <div className="palette-float">{toolBar}</div>}
          {inspector && <div className="inspector-float">{inspector}</div>}
          {readout}
        </div>
        {assistant}
        {assistantDocked && assistantResizer}
      </main>
      {overlays}
    </div>
  );
}
