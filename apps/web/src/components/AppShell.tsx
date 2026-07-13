import type { ReactNode } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  toolBar: ReactNode;
  sidebar: ReactNode;
  viewer: ReactNode;
  /** Contextual properties panel; null hides it and gives the space back. */
  inspector: ReactNode | null;
  statusBar: ReactNode;
  overlays?: ReactNode;
}

/**
 * Workspace layout frame: TopBar / ToolBar / [Sidebar | Viewer] / StatusBar.
 * The inspector floats over the viewer like a CAD dialog instead of taking a
 * permanent column, so the viewport keeps its size while editing.
 */
export function AppShell({
  topBar,
  toolBar,
  sidebar,
  viewer,
  inspector,
  statusBar,
  overlays
}: AppShellProps) {
  return (
    <div className="app-shell">
      {topBar}
      {toolBar}
      <main className="workspace">
        {sidebar}
        <div className="viewer-area">
          {viewer}
          {inspector && <div className="inspector-float">{inspector}</div>}
        </div>
      </main>
      {statusBar}
      {overlays}
    </div>
  );
}
