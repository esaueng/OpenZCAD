import type { ReactNode } from 'react';

interface AppShellProps {
  topBar: ReactNode;
  palette: ReactNode;
  browser: ReactNode;
  viewer: ReactNode;
  inspector: ReactNode;
  statusBar: ReactNode;
}

/** Workspace layout frame: TopBar / [Palette | Browser | Viewer | Inspector] / StatusBar. */
export function AppShell({ topBar, palette, browser, viewer, inspector, statusBar }: AppShellProps) {
  return (
    <div className="app-shell">
      {topBar}
      <main className="workspace">
        <div className="left-rail">
          {palette}
          {browser}
        </div>
        {viewer}
        {inspector}
      </main>
      {statusBar}
    </div>
  );
}
