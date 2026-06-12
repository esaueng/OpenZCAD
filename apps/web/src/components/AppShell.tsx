import type { ReactNode } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  sidebar: ReactNode;
  viewer: ReactNode;
  inspector: ReactNode;
  statusBar: ReactNode;
}

/** Workspace layout frame: TopBar / [Sidebar | Viewer | Inspector] / StatusBar. */
export function AppShell({ topBar, sidebar, viewer, inspector, statusBar }: AppShellProps) {
  return (
    <div className="app-shell">
      {topBar}
      <main className="workspace">
        {sidebar}
        {viewer}
        {inspector}
      </main>
      {statusBar}
    </div>
  );
}
