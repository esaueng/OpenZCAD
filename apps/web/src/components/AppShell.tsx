import type { ReactNode } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  /** Floating tool palette (or a mode strip while a direct mode is active). */
  toolBar: ReactNode;
  sidebar: ReactNode;
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
  statusBar,
  overlays
}: AppShellProps) {
  const assistantDocked = Boolean(
    assistant && !assistantHidden && !assistantCollapsed
  );
  return (
    <div className="app-shell">
      {topBar}
      <main className={`workspace${assistantDocked ? ' with-assistant' : ''}`}>
        {sidebar}
        <div className="viewer-area">
          {viewer}
          {toolBar && <div className="palette-float">{toolBar}</div>}
          {inspector && <div className="inspector-float">{inspector}</div>}
        </div>
        {assistant}
      </main>
      {statusBar}
      {overlays}
    </div>
  );
}
