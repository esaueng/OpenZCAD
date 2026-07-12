import type { ReactNode } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  sidebar: ReactNode;
  viewer: ReactNode;
  inspector: ReactNode;
  assistant: ReactNode;
  statusBar: ReactNode;
}

/** Workspace layout frame: TopBar / [Sidebar | Viewer | Inspector] / StatusBar. */
export function AppShell({
  topBar,
  sidebar,
  viewer,
  inspector,
  assistant,
  statusBar
}: AppShellProps) {
  return (
    <div className="app-shell">
      {topBar}
      <main className="workspace">
        {sidebar}
        {viewer}
        {inspector}
      </main>
      {assistant}
      {statusBar}
    </div>
  );
}
